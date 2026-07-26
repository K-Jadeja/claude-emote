import {
  parsePetSessionState,
  type PetSessionState,
} from "../../src/shared/pet-session-state";

interface EventSourceLike {
  addEventListener(
    type: string,
    listener: (event: Event | MessageEvent<string>) => void,
  ): void;
  close(): void;
}

export interface SessionStreamClient {
  close(): void;
}

export interface SessionStreamClientOptions {
  endpoint: string;
  onState: (state: PetSessionState) => void;
  onConnectionChange?: (connected: boolean) => void;
  onProtocolError?: (error: Error) => void;
  eventSourceFactory?: (url: string) => EventSourceLike;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function resolveSessionStreamUrl(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Claude Pet endpoint must be a valid URL");
  }
  if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error("Claude Pet endpoint must use loopback HTTP");
  }
  if (!["/", "/event", "/state", "/stream"].includes(parsed.pathname)) {
    throw new Error(`Unsupported Claude Pet endpoint path: ${parsed.pathname}`);
  }
  parsed.pathname = "/stream";
  parsed.hash = "";
  return parsed.toString();
}

export function createSessionStreamClient(
  options: SessionStreamClientOptions,
): SessionStreamClient {
  const streamUrl = resolveSessionStreamUrl(options.endpoint);
  const createSource =
    options.eventSourceFactory ??
    ((url: string): EventSourceLike => new EventSource(url));
  const source = createSource(streamUrl);
  let lastSequence = -1;
  let ended = false;

  function acceptEvent(event: Event | MessageEvent<string>): void {
    if (!("data" in event) || typeof event.data !== "string") return;
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
  }

  source.addEventListener("open", () => {
    options.onConnectionChange?.(true);
  });
  source.addEventListener("error", () => {
    if (!ended) options.onConnectionChange?.(false);
  });
  source.addEventListener("snapshot", acceptEvent);
  source.addEventListener("state", acceptEvent);

  return {
    close: () => source.close(),
  };
}

