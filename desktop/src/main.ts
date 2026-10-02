import { createDemoController } from "./demo-controller";
import { createDemoStates } from "./pet-state";
import { createPetShell } from "./shell";
import { createPetView, waitForImageRender } from "./pet-view";
import { protectInteractiveRegionFromWindowDrag } from "./pointer-guard";
import {
  createSessionStreamClient,
  notifyOverlayFocus,
  notifyOverlayReady,
} from "./session-stream-client";
import { SESSION_CAPABILITY_ENV } from "../../src/shared/session-capability";
import {
  HIDE_SESSION_LABEL_ENV,
  SESSION_LABEL_ENV,
} from "../../src/shared/session-label";
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
  const focusButton = requiredElement<HTMLButtonElement>("#focus-button");
  const closeButton = requiredElement<HTMLButtonElement>("#close-button");
  const shell = createPetShell();
  const view = createPetView(root);
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
    const [environmentEndpoint, capabilityToken, sessionLabel, hideLabel] =
      await Promise.all([
        shell.getEnvironmentValue("CLAUDE_EMOTE_ENDPOINT"),
        shell.getEnvironmentValue(SESSION_CAPABILITY_ENV),
        shell.getEnvironmentValue(SESSION_LABEL_ENV),
        shell.getEnvironmentValue(HIDE_SESSION_LABEL_ENV),
      ]);
    const endpoint =
      environmentEndpoint ??
      new URL(globalThis.location.href).searchParams.get("endpoint");
    if (endpoint) {
      if (!capabilityToken) {
        throw new Error(
          `${SESSION_CAPABILITY_ENV} is required for a live Claude Pet session`,
        );
      }
      view.setMode("live");
      view.setSessionLabel(sessionLabel, hideLabel === "1");
      let currentState: PetSessionState = {
        sessionId: "connecting",
        sequence: 0,
        status: "disconnected",
        activity: "idle",
        timestamp: Date.now(),
      };
      view.render(currentState, 0, 0);
      let readinessSent = false;
      let readinessPending = false;
      let streamConnected = false;
      let hasAuthoritativeState = false;
      const markReadyAfterRender = (): void => {
        if (
          readinessSent ||
          readinessPending ||
          !streamConnected ||
          !hasAuthoritativeState
        ) {
          return;
        }
        readinessPending = true;
        const image = requiredElement<HTMLImageElement>("#pet-image");
        void waitForImageRender(image)
          .then(() => notifyOverlayReady(endpoint, capabilityToken))
          .then(() => {
            readinessSent = true;
          })
          .catch((error: unknown) => {
            void shell.reportError(
              error instanceof Error ? error : new Error(String(error)),
            );
          })
          .finally(() => {
            readinessPending = false;
          });
      };
      const stream = createSessionStreamClient({
        endpoint,
        capabilityToken,
        onState(state) {
          currentState = state;
          view.render(state, 0, 0);
          hasAuthoritativeState = true;
          markReadyAfterRender();
        },
        onConnectionChange(connected) {
          streamConnected = connected;
          if (connected) {
            markReadyAfterRender();
            return;
          }
          if (currentState.status === "ended") return;
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
      focusButton.addEventListener("click", () => {
        // Best-effort UX; focus failures must never stall the pet.
        notifyOverlayFocus(endpoint, capabilityToken).catch((error: unknown) => {
          void shell.reportError(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      });
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
