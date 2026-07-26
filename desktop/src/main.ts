import { createDemoController } from "./demo-controller";
import { createDemoStates } from "./pet-state";
import { createPetShell } from "./shell";
import { createPetView } from "./pet-view";
import { protectInteractiveRegionFromWindowDrag } from "./pointer-guard";
import { createSessionStreamClient } from "./session-stream-client";
import type { PetSessionState } from "../../src/shared/pet-session-state";

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Desktop markup is missing "${selector}"`);
  return element;
}

async function main(): Promise<void> {
  const root = requiredElement<HTMLElement>("#pet-shell");
  const controls = requiredElement<HTMLElement>("#pet-controls");
  const pauseButton = requiredElement<HTMLButtonElement>("#pause-button");
  const nextButton = requiredElement<HTMLButtonElement>("#next-button");
  const closeButton = requiredElement<HTMLButtonElement>("#close-button");
  const shell = createPetShell();
  const view = createPetView(root);
  const endpoint = new URL(globalThis.location.href).searchParams.get("endpoint");
  let disposeMode: () => void = () => {};

  protectInteractiveRegionFromWindowDrag(controls);

  try {
    await shell.initialize();
    await shell.makeDraggable(root, [controls]);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    view.showFatal(failure.message);
    await shell.reportError(failure);
    throw failure;
  }

  try {
    if (endpoint) {
      view.setMode("live");
      let currentState: PetSessionState = {
        sessionId: "connecting",
        sequence: 0,
        status: "disconnected",
        activity: "idle",
        timestamp: Date.now(),
      };
      view.render(currentState, 0, 0);
      const stream = createSessionStreamClient({
        endpoint,
        onState(state) {
          currentState = state;
          view.render(state, 0, 0);
        },
        onConnectionChange(connected) {
          if (connected || currentState.status === "ended") return;
          currentState = {
            ...currentState,
            status: "disconnected",
            timestamp: Date.now(),
          };
          view.render(currentState, 0, 0);
        },
        onProtocolError(error) {
          void shell.reportError(error);
        },
      });
      disposeMode = () => stream.close();
    } else {
      view.setMode("demo");
      const states = createDemoStates();
      const demo = createDemoController(states, (state, index) => {
        view.render(state, index, states.length);
      });
      pauseButton.addEventListener("click", () => {
        view.setPaused(demo.togglePause());
      });
      nextButton.addEventListener("click", () => demo.next());
      view.setPaused(false);
      demo.start();
      disposeMode = () => demo.stop();
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    view.showFatal(failure.message);
    await shell.reportError(failure);
    throw failure;
  }

  closeButton.addEventListener("click", () => {
    disposeMode();
    view.dispose();
    void shell.close(0);
  });
  window.addEventListener("beforeunload", () => {
    disposeMode();
    view.dispose();
  });

  root.dataset.shell = shell.kind;
}

void main().catch((error: unknown) => {
  console.error("[Claude Pet] startup failed", error);
});
