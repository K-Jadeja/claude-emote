import type { PetState } from "./pet-state";

export interface DemoController {
  start(): void;
  stop(): void;
  next(): void;
  togglePause(): boolean;
  getIndex(): number;
  isPaused(): boolean;
}

export function createDemoController(
  states: readonly PetState[],
  onState: (state: PetState, index: number) => void,
  intervalMs = 1_600,
): DemoController {
  if (states.length === 0) {
    throw new Error("Demo controller requires at least one state");
  }
  let index = 0;
  let paused = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function emit(): void {
    onState(states[index]!, index);
  }

  function next(): void {
    index = (index + 1) % states.length;
    emit();
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function schedule(): void {
    clearTimer();
    if (!paused) timer = setInterval(next, intervalMs);
  }

  return {
    start() {
      emit();
      schedule();
    },
    stop() {
      clearTimer();
    },
    next() {
      next();
      schedule();
    },
    togglePause() {
      paused = !paused;
      schedule();
      return paused;
    },
    getIndex: () => index,
    isPaused: () => paused,
  };
}
