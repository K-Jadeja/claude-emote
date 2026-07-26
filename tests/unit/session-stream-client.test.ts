import { describe, expect, it, vi } from "vitest";
import {
  createSessionStreamClient,
  notifyOverlayReady,
  resolveSessionStreamUrl,
} from "../../desktop/src/session-stream-client";

const TOKEN = "desktop_stream_test_capability_1234567890";

function sseResponse(blocks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const block of blocks) controller.enqueue(encoder.encode(block));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

describe("desktop session stream client", () => {
  it("accepts only loopback endpoints and removes query data", () => {
    expect(
      resolveSessionStreamUrl(
        "http://127.0.0.1:4312/event?must=not-survive",
      ),
    ).toBe("http://127.0.0.1:4312/stream");
    expect(() =>
      resolveSessionStreamUrl("https://example.com/event"),
    ).toThrow("loopback HTTP");
    expect(() =>
      resolveSessionStreamUrl("http://127.0.0.1:4312/private"),
    ).toThrow("Unsupported");
  });

  it("sends the capability in a header, never the URL", async () => {
    const state = {
      sessionId: "s",
      sequence: 2,
      status: "ended",
      activity: "idle",
      timestamp: 100,
    };
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(String(_url)).toBe("http://localhost:4312/stream");
      expect(String(_url)).not.toContain(TOKEN);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${TOKEN}`,
      );
      return sseResponse([
        `event: snapshot\ndata: ${JSON.stringify(state)}\n\n`,
      ]);
    });
    const onState = vi.fn();
    const client = createSessionStreamClient({
      endpoint: "http://localhost:4312/event",
      capabilityToken: TOKEN,
      onState,
      fetchImpl,
    });

    await vi.waitFor(() => expect(onState).toHaveBeenCalledWith(state));
    client.close();
  });

  it("delivers newer states while rejecting malformed and stale data", async () => {
    const state = {
      sessionId: "s",
      sequence: 2,
      status: "running",
      activity: "reading",
      timestamp: 100,
    };
    const ended = {
      ...state,
      sequence: 3,
      status: "ended",
      activity: "idle",
    };
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      sseResponse([
        `event: snapshot\ndata: ${JSON.stringify(state)}\n\n`,
        `event: state\ndata: ${JSON.stringify({ ...state, sequence: 1 })}\n\n`,
        `event: state\ndata: ${JSON.stringify({ ...state, prompt: "private" })}\n\n`,
        `event: state\ndata: ${JSON.stringify(ended)}\n\n`,
      ]),
    );
    const onState = vi.fn();
    const onProtocolError = vi.fn();
    const client = createSessionStreamClient({
      endpoint: "http://localhost:4312/event",
      capabilityToken: TOKEN,
      onState,
      onProtocolError,
      fetchImpl,
    });

    await vi.waitFor(() => expect(onState).toHaveBeenCalledTimes(2));
    expect(onState.mock.calls).toEqual([[state], [ended]]);
    expect(onProtocolError).toHaveBeenCalledOnce();
    client.close();
  });

  it("reports an authenticated connection without reporting ended as disconnected", async () => {
    const connection = vi.fn();
    const ended = {
      sessionId: "s",
      sequence: 3,
      status: "ended",
      activity: "idle",
      timestamp: 101,
    };
    const client = createSessionStreamClient({
      endpoint: "http://127.0.0.1:4312",
      capabilityToken: TOKEN,
      onState: () => {},
      onConnectionChange: connection,
      fetchImpl: async () =>
        sseResponse([
          `event: state\ndata: ${JSON.stringify(ended)}\n\n`,
        ]),
    });

    await vi.waitFor(() => expect(connection).toHaveBeenCalledWith(true));
    expect(connection.mock.calls).toEqual([[true]]);
    client.close();
  });

  it("announces overlay readiness with the same header contract", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("http://127.0.0.1:4312/overlay-ready");
      expect(String(url)).not.toContain(TOKEN);
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${TOKEN}`,
      );
      return new Response(null, { status: 204 });
    });

    await notifyOverlayReady(
      "http://127.0.0.1:4312/event",
      TOKEN,
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
