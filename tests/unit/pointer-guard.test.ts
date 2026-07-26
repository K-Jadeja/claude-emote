import { describe, expect, it, vi } from "vitest";
import { protectInteractiveRegionFromWindowDrag } from "../../desktop/src/pointer-guard";

describe("desktop interactive-region drag guard", () => {
  it("stops a control pointerdown before the root drag listener receives it", () => {
    let pointerDownListener: ((event: PointerEvent) => void) | null = null;
    const fakeElement = {
      addEventListener(type: string, listener: (event: PointerEvent) => void) {
        if (type === "pointerdown") pointerDownListener = listener;
      },
    } as unknown as HTMLElement;
    const stopPropagation = vi.fn();

    protectInteractiveRegionFromWindowDrag(fakeElement);
    expect(pointerDownListener).not.toBeNull();
    (pointerDownListener as unknown as (event: Pick<PointerEvent, "stopPropagation">) => void)({
      stopPropagation,
    });

    expect(stopPropagation).toHaveBeenCalledOnce();
  });
});
