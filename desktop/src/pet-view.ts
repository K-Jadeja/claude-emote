import {
  STATUS_LABELS,
  getPose,
  type PetState,
} from "./pet-state";

export interface PetView {
  render(state: PetState, step: number, totalSteps: number): void;
  setMode(mode: "demo" | "live"): void;
  setPaused(paused: boolean): void;
  showFatal(message: string): void;
  dispose(): void;
}

export async function waitForImageRender(
  image: Pick<HTMLImageElement, "complete" | "naturalWidth" | "decode">,
): Promise<void> {
  if (!image.complete || image.naturalWidth <= 0) {
    await image.decode();
  }
  if (!image.complete || image.naturalWidth <= 0) {
    throw new Error("Claude Pet frame did not render");
  }
}

function requiredElement<T extends HTMLElement>(
  root: ParentNode,
  selector: string,
): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Desktop markup is missing "${selector}"`);
  return element;
}

export function createPetView(root: HTMLElement): PetView {
  const image = requiredElement<HTMLImageElement>(root, "#pet-image");
  const statusLabel = requiredElement<HTMLElement>(root, "#status-label");
  const activityLabel = requiredElement<HTMLElement>(root, "#activity-label");
  const sessionLabel = requiredElement<HTMLElement>(root, "#session-label");
  const stepLabel = requiredElement<HTMLElement>(root, "#step-label");
  const pauseButton = requiredElement<HTMLButtonElement>(root, "#pause-button");
  const fatalError = requiredElement<HTMLParagraphElement>(root, "#fatal-error");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let frameTimer: ReturnType<typeof setInterval> | null = null;
  let renderVersion = 0;

  function stopFrames(): void {
    if (frameTimer !== null) {
      clearInterval(frameTimer);
      frameTimer = null;
    }
  }

  function showFrame(path: string, alt: string, version: number): void {
    image.onerror = () => {
      if (version === renderVersion) {
        fatalError.hidden = false;
        fatalError.textContent = `Missing required pet frame: ${path}`;
        root.dataset.health = "fatal";
      }
    };
    image.src = path;
    image.alt = alt;
  }

  function render(state: PetState, step: number, totalSteps: number): void {
    renderVersion += 1;
    const version = renderVersion;
    const pose = getPose(state.activity);
    const alt = `Claude Pet is ${pose.label}`;

    root.dataset.activity = state.activity;
    root.dataset.status = state.status;
    root.dataset.health = "ok";
    statusLabel.textContent = STATUS_LABELS[state.status];
    activityLabel.textContent = pose.label;
    sessionLabel.textContent =
      state.sessionId === "demo" ? "demo session" : state.sessionId;
    stepLabel.textContent =
      totalSteps > 0
        ? `${String(step + 1).padStart(2, "0")} / ${String(totalSteps).padStart(
            2,
            "0",
          )}`
        : `#${String(state.sequence).padStart(4, "0")}`;
    fatalError.hidden = true;
    showFrame(pose.frames[0]!, alt, version);

    stopFrames();
    if (reducedMotion || pose.frames.length === 1) return;
    let frameIndex = 0;
    frameTimer = setInterval(() => {
      frameIndex = (frameIndex + 1) % pose.frames.length;
      showFrame(pose.frames[frameIndex]!, alt, version);
    }, pose.intervalMs);
  }

  return {
    render,
    setMode(mode) {
      root.dataset.mode = mode;
      root.setAttribute(
        "aria-label",
        mode === "demo" ? "Claude Pet demo" : "Claude Pet live session",
      );
    },
    setPaused(paused) {
      pauseButton.textContent = paused ? "▶" : "Ⅱ";
      pauseButton.setAttribute(
        "aria-label",
        paused ? "Resume demo" : "Pause demo",
      );
      root.dataset.paused = String(paused);
    },
    showFatal(message) {
      stopFrames();
      root.dataset.health = "fatal";
      fatalError.hidden = false;
      fatalError.textContent = message;
    },
    dispose: stopFrames,
  };
}
