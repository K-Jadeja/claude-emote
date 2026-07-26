/**
 * Neutralino installs its drag listener on the pet's root element. Interactive
 * descendants must stop pointerdown before it bubbles to that listener;
 * otherwise clicking a control can begin a native window drag.
 */
export function protectInteractiveRegionFromWindowDrag(
  element: HTMLElement,
): void {
  element.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
}
