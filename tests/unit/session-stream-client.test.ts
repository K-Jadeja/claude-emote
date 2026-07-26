import { describe, expect, it, vi } from "vitest";
import {
  createSessionStreamClient,
  resolveSessionStreamUrl,
} from "../../desktop/src/session-stream-client";

class FakeEventSource {
  readonly listeners = new Map<
    string,
    Array<(event: Event | MessageEvent<string>) => void>
  >();
  closed = false;

  addEventListener(
    type: string,
    listener: (event: Event | MessageEvent<string>) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data?: string): void {
    const event = data === undefined ? new Event(type) : ({ data } as MessageEvent<string>);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close(): void {
    this.closed = true;
  }
}

describe("desktop session stream client", () => {
  it("accepts only loopback endpoints and normalizes the event path", () => {
    expect(resolveSessionStreamUrl("http://127.0.0.1:4312/event")).toBe(
      "http://127.0.0.1:4312/stream",
    );
    expect(() =>
      resolveSessionStreamUrl("https://example.com/event"),
    ).toThrow("loopback HTTP");
    expect(() =>
      resolveSessionStreamUrl("http://127.0.0.1:4312/private"),
    ).toThrow("Unsupported");
  });

  it("delivers snapshots and newer states while rejecting malformed or stale data", () => {
    const source = new FakeEventSource();
    const onState = vi.fn();
    const onProtocolError = vi.fn();
    const client = createSessionStreamClient({
      endpoint: "http://localhost:4312/event",
      onState,
      onProtocolError,
      eventSourceFactory: () => source,
    });
    const state = {
      sessionId: "s",
      sequence: 2,
      status: "running",
      activity: "reading",
      timestamp: 100,
    };

    source.emit("snapshot", JSON.stringify(state));
    source.emit("state", JSON.stringify({ ...state, sequence: 1 }));
    source.emit("state", JSON.stringify({ ...state, prompt: "must not pass" }));

    expect(onState).toHaveBeenCalledOnce();
    expect(onState).toHaveBeenCalledWith(state);
    expect(onProtocolError).toHaveBeenCalledOnce();
    client.close();
    expect(source.closed).toBe(true);
  });

  it("reports disconnects but does not overwrite a terminal ended state", () => {
    const source = new FakeEventSource();
    const connection = vi.fn();
    createSessionStreamClient({
      endpoint: "http://127.0.0.1:4312",
      onState: () => {},
      onConnectionChange: connection,
      eventSourceFactory: () => source,
    });

    source.emit("open");
    source.emit("error");
    source.emit(
      "state",
      JSON.stringify({
        sessionId: "s",
        sequence: 3,
        status: "ended",
        activity: "idle",
        timestamp: 101,
      }),
    );
    source.emit("error");

    expect(connection.mock.calls).toEqual([[true], [false]]);
  });
});
