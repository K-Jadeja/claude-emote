type NeutralinoApi = typeof import("@neutralinojs/lib");

const DESIGN_WIDTH = 272;
const DESIGN_HEIGHT = 324;
const WINDOW_EDGE_MARGIN = 16;

export interface WindowPosition {
  x: number;
  y: number;
}

export interface WindowBounds {
  width: number;
  height: number;
}

export function clampWindowPosition(
  position: WindowPosition,
  size: WindowBounds,
  availableScreen: WindowPosition & WindowBounds,
  displayScale: number,
  margin = WINDOW_EDGE_MARGIN,
): WindowPosition {
  const scale = Math.max(1, displayScale);
  const left = Math.round(availableScreen.x * scale) + margin;
  const top = Math.round(availableScreen.y * scale) + margin;
  const right =
    Math.round((availableScreen.x + availableScreen.width) * scale) - margin;
  const bottom =
    Math.round((availableScreen.y + availableScreen.height) * scale) - margin;
  const maxX = Math.max(left, right - size.width);
  const maxY = Math.max(top, bottom - size.height);
  return {
    x: Math.min(maxX, Math.max(left, position.x)),
    y: Math.min(maxY, Math.max(top, position.y)),
  };
}

export interface PetShell {
  readonly kind: "neutralino" | "browser";
  initialize(): Promise<void>;
  getEnvironmentValue(name: string): Promise<string | null>;
  makeDraggable(element: HTMLElement, exclusions: HTMLElement[]): Promise<void>;
  close(exitCode?: number): Promise<void>;
  reportError(error: Error): Promise<void>;
}

function getNeutralinoApi(): NeutralinoApi | null {
  const runtime = globalThis as typeof globalThis & {
    NL_OS?: string;
    Neutralino?: NeutralinoApi;
  };
  return runtime.NL_OS && runtime.Neutralino ? runtime.Neutralino : null;
}

function waitForNativeReady(api: NeutralinoApi, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Neutralino native API did not become ready within 5 seconds"));
    }, timeoutMs);
    void api.events.on("ready", () => {
      clearTimeout(timeout);
      resolve();
    });
    api.init();
  });
}

async function ensureNativeWindowVisible(api: NeutralinoApi): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await api.window.show();
    if (await api.window.isVisible()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Neutralino native window remained hidden after show()");
}

async function keepNativeWindowOnScreen(
  api: NeutralinoApi,
  displayScale: number,
): Promise<void> {
  const [position, size] = await Promise.all([
    api.window.getPosition(),
    api.window.getSize(),
  ]);
  if (
    typeof position.x !== "number" ||
    typeof position.y !== "number" ||
    typeof size.width !== "number" ||
    typeof size.height !== "number"
  ) {
    throw new Error("Neutralino returned incomplete window geometry");
  }
  const browserScreen = globalThis.screen as Screen & {
    availLeft?: number;
    availTop?: number;
  };
  const clamped = clampWindowPosition(
    { x: position.x, y: position.y },
    { width: size.width, height: size.height },
    {
      x: browserScreen.availLeft ?? 0,
      y: browserScreen.availTop ?? 0,
      width: browserScreen.availWidth,
      height: browserScreen.availHeight,
    },
    displayScale,
  );
  if (clamped.x !== position.x || clamped.y !== position.y) {
    await api.window.move(clamped.x, clamped.y);
  }
}

function createNativeShell(api: NeutralinoApi): PetShell {
  return {
    kind: "neutralino",
    async initialize() {
      await waitForNativeReady(api);
      await api.window.setBorderless(true);
      await api.window.setAlwaysOnTop(true);
      // Neutralino's Windows window size is expressed in physical pixels,
      // while WebView2 lays out in CSS pixels. Scale the native surface so
      // the 272x324 design viewport is not clipped at 125%/150% display DPI.
      const displayScale = Math.max(1, globalThis.devicePixelRatio || 1);
      await api.window.setSize({
        width: Math.round(DESIGN_WIDTH * displayScale),
        height: Math.round(DESIGN_HEIGHT * displayScale),
      });
      await keepNativeWindowOnScreen(api, displayScale);
      await ensureNativeWindowVisible(api);
      await api.events.on("windowClose", () => {
        void api.app.exit(0);
      });
    },
    async getEnvironmentValue(name) {
      const value = await api.os.getEnv(name);
      return value === "" ? null : value;
    },
    async makeDraggable(element, exclusions) {
      await api.window.setDraggableRegion(element, { exclude: exclusions });
    },
    async close(exitCode = 0) {
      await api.app.exit(exitCode);
    },
    async reportError(error) {
      try {
        await api.debug.log(
          `[Claude Pet] ERROR: ${error.stack ?? error.message}`,
        );
      } catch {
        console.error(error);
      }
    },
  };
}

function createBrowserShell(): PetShell {
  return {
    kind: "browser",
    async initialize() {},
    async getEnvironmentValue() {
      return null;
    },
    async makeDraggable() {},
    async close() {
      globalThis.close();
    },
    async reportError(error) {
      console.error(error);
    },
  };
}

export function createPetShell(): PetShell {
  const api = getNeutralinoApi();
  return api ? createNativeShell(api) : createBrowserShell();
}
