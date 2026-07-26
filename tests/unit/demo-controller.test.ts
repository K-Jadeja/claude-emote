import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoController } from "../../desktop/src/demo-controller";
import { createDemoStates } from "../../desktop/src/pet-state";

afterEach(() => {
  vi.useRealTimers();
});

describe("desktop demo controller", () => {
  it("cycles, pauses, advances manually, and resumes without duplicate timers", () => {
    vi.useFakeTimers();
    const states = createDemoStates(1000).slice(0, 3);
    const observed: number[] = [];
    const controller = createDemoController(
      states,
      (_state, index) => observed.push(index),
      100,
    );

    controller.start();
    vi.advanceTimersByTime(200);
    expect(observed).toEqual([0, 1, 2]);

    expect(controller.togglePause()).toBe(true);
    vi.advanceTimersByTime(500);
    expect(observed).toEqual([0, 1, 2]);

    controller.next();
    expect(observed).toEqual([0, 1, 2, 0]);
    expect(controller.togglePause()).toBe(false);
    vi.advanceTimersByTime(100);
    expect(observed).toEqual([0, 1, 2, 0, 1]);

    controller.stop();
    vi.advanceTimersByTime(500);
    expect(observed).toEqual([0, 1, 2, 0, 1]);
  });
});
