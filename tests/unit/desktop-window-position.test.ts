import { describe, expect, it } from "vitest";
import { clampWindowPosition } from "../../desktop/src/shell.js";

describe("desktop saved-position visibility", () => {
  it("preserves a valid saved position", () => {
    expect(
      clampWindowPosition(
        { x: 600, y: 300 },
        { width: 340, height: 405 },
        { x: 0, y: 0, width: 1228, height: 691 },
        1.25,
      ),
    ).toEqual({ x: 600, y: 300 });
  });

  it("moves a high-DPI window fully inside the right and bottom edges", () => {
    expect(
      clampWindowPosition(
        { x: 1443, y: 700 },
        { width: 340, height: 405 },
        { x: 0, y: 0, width: 1228, height: 691 },
        1.25,
      ),
    ).toEqual({ x: 1179, y: 443 });
  });

  it("recovers a saved position beyond the top-left edge", () => {
    expect(
      clampWindowPosition(
        { x: -900, y: -200 },
        { width: 272, height: 324 },
        { x: 0, y: 0, width: 1536, height: 864 },
        1,
      ),
    ).toEqual({ x: 16, y: 16 });
  });
});
