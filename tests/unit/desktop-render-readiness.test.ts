import { describe, expect, it, vi } from "vitest";
import { waitForImageRender } from "../../desktop/src/pet-view.js";

describe("desktop render readiness", () => {
  it("waits for image decode before accepting native readiness", async () => {
    const image = {
      complete: false,
      naturalWidth: 0,
      decode: vi.fn(async function (this: {
        complete: boolean;
        naturalWidth: number;
      }) {
        this.complete = true;
        this.naturalWidth = 176;
      }),
    };
    await waitForImageRender(image);
    expect(image.decode).toHaveBeenCalledOnce();
  });

  it("fails when decode completes without a renderable frame", async () => {
    const image = {
      complete: true,
      naturalWidth: 0,
      decode: vi.fn(async () => {}),
    };
    await expect(waitForImageRender(image)).rejects.toThrow(
      /frame did not render/,
    );
  });
});
