import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatSessionLabel } from "../../desktop/src/pet-state.js";

describe("pet session label", () => {
  it("prefers the launcher-provided project label", () => {
    expect(formatSessionLabel("opaque-claude-id", "gp2")).toBe("gp2");
  });

  it("never displays a full opaque live session identifier", () => {
    expect(
      formatSessionLabel(
        "019f9fb3-5fde-7c91-a1e6-bdf46f0a415a",
        null,
      ),
    ).toBe("session 019f9fb3");
  });

  it("keeps the demo label explicit", () => {
    expect(formatSessionLabel("demo", null)).toBe("demo session");
  });

  it("renders no identity when the user explicitly hides it", () => {
    expect(formatSessionLabel("opaque-claude-id", null, true)).toBe("");
  });

  it("writes the preferred label as text rather than executable markup", () => {
    expect(
      formatSessionLabel("opaque-claude-id", "<img onerror=alert(1)>"),
    ).toBe("<img onerror=alert(1)>");
    const viewSource = readFileSync(
      resolve("desktop", "src", "pet-view.ts"),
      "utf8",
    );
    expect(viewSource).toContain("sessionLabel.textContent = formatSessionLabel");
    expect(viewSource).not.toMatch(/sessionLabel\.innerHTML\s*=/u);
  });
});
