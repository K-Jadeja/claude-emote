type NeutralinoApi = typeof import("@neutralinojs/lib");

const DESIGN_WIDTH = 272;
const DESIGN_HEIGHT = 324;

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
