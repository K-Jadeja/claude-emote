import {
  parsePetSessionState,
  type PetSessionState,
} from "../../src/shared/pet-session-state";
import {
  buildCapabilityAuthorization,
  requireSessionCapability,
} from "../../src/shared/session-capability";

export interface SessionStreamClient {
  close(): void;
}

export interface SessionStreamClientOptions {
  endpoint: string;
  capabilityToken: string;
  onState: (state: PetSessionState) => void;
  onConnectionChange?: (connected: boolean) => void;
  onProtocolError?: (error: Error) => void;
  fetchImpl?: typeof fetch;
  initialRetryMs?: number;
  maxRetryMs?: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_SSE_BUFFER_BYTES = 64 * 1024;

export function resolveSessionUrl(endpoint: string, pathname: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Claude Pet endpoint must be a valid URL");
  }
  if (
    parsed.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("Claude Pet endpoint must use loopback HTTP");
  }
  if (!["/", "/event", "/state", "/stream"].includes(parsed.pathname)) {
    throw new Error(`Unsupported Claude Pet endpoint path: ${parsed.pathname}`);
  }
  parsed.pathname = pathname;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function resolveSessionStreamUrl(endpoint: string): string {
  return resolveSessionUrl(endpoint, "/stream");
}

interface ParsedSseEvent {
  event: string;
  data: string;
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: ParsedSseEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  const dispatch = (): void => {
    if (dataLines.length > 0) {
      onEvent({ event: eventName, data: dataLines.join("\n") });
    }
    eventName = "message";
    dataLines = [];
  };

  const consumeLine = (rawLine: string): void => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    if (field === "data") dataLines.push(value);
  };

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_SSE_BUFFER_BYTES) {
        throw new Error("Claude Pet state stream exceeded its size limit");
      }
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) consumeLine(buffer);
    dispatch();
  } finally {
    reader.releaseLock();
  }
}

export function createSessionStreamClient(
  options: SessionStreamClientOptions,
): SessionStreamClient {
  const streamUrl = resolveSessionStreamUrl(options.endpoint);
  const capabilityToken = requireSessionCapability(
    options.capabilityToken,
    "Claude Pet session capability",
  );
  const authorization = buildCapabilityAuthorization(capabilityToken);
  const fetchImpl = options.fetchImpl ?? fetch;
  const initialRetryMs = options.initialRetryMs ?? 250;
  const maxRetryMs = options.maxRetryMs ?? 5_000;
  let retryMs = initialRetryMs;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;
  let lastSequence = -1;
  let ended = false;
  let closed = false;
  let connected = false;

  const setConnected = (next: boolean): void => {
    if (connected === next) return;
    connected = next;
    options.onConnectionChange?.(next);
  };

  const acceptEvent = (event: ParsedSseEvent): void => {
    if (event.event !== "snapshot" && event.event !== "state") return;
    try {
      const state = parsePetSessionState(JSON.parse(event.data));
      if (state.sequence < lastSequence) return;
      lastSequence = state.sequence;
      ended = state.status === "ended";
      options.onState(state);
    } catch (error) {
      options.onProtocolError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  };

  const scheduleReconnect = (): void => {
    if (closed || ended || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, retryMs);
    retryMs = Math.min(maxRetryMs, retryMs * 2);
  };

  const connect = async (): Promise<void> => {
    if (closed || ended) return;
    abortController = new AbortController();
    try {
      const response = await fetchImpl(streamUrl, {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          authorization,
        },
        cache: "no-store",
        signal: abortController.signal,
      });
      if (!response.ok) {
        throw new Error(
          `Claude Pet state stream returned HTTP ${response.status}`,
        );
      }
      if (!response.body) {
        throw new Error("Claude Pet state stream returned no body");
      }
      retryMs = initialRetryMs;
      setConnected(true);
      await consumeSse(response.body, abortController.signal, acceptEvent);
      if (!ended && !closed) {
        throw new Error("Claude Pet state stream disconnected");
      }
    } catch (error) {
      if (closed || abortController.signal.aborted) return;
      options.onProtocolError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      abortController = null;
      if (!ended && !closed) {
        setConnected(false);
        scheduleReconnect();
      }
    }
  };

  void connect();

  return {
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      abortController?.abort();
      abortController = null;
    },
  };
}

export async function notifyOverlayReady(
  endpoint: string,
  capabilityToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const token = requireSessionCapability(
    capabilityToken,
    "Claude Pet session capability",
  );
  const response = await fetchImpl(resolveSessionUrl(endpoint, "/overlay-ready"), {
    method: "POST",
    headers: {
      authorization: buildCapabilityAuthorization(token),
    },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(
      `Claude Pet overlay readiness returned HTTP ${response.status}`,
    );
  }
}

/**
 * Ask the per-session host to bring the originating Windows Terminal
 * pane to the foreground. The endpoint is documented as 204-on-success
 * and never returns state. Any 2xx is treated as success; non-2xx
 * throws with the status code so the caller can route it through
 * `shell.reportError`. Focus is a best-effort UX win — never a
 * load-bearing side effect.
 */
export async function notifyOverlayFocus(
  endpoint: string,
  capabilityToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const token = requireSessionCapability(
    capabilityToken,
    "Claude Pet session capability",
  );
  const response = await fetchImpl(resolveSessionUrl(endpoint, "/focus"), {
    method: "POST",
    headers: {
      authorization: buildCapabilityAuthorization(token),
    },
    cache: "no-store",
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Claude Pet focus returned HTTP ${response.status}`,
    );
  }
}
