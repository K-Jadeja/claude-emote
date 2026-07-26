import { describe, expect, it } from "vitest";
import {
  buildCapabilityAuthorization,
  isSessionCapability,
  requireSessionCapability,
} from "../../src/shared/session-capability.js";
import { isCapabilityAuthorized } from "../../src/host/session-auth.js";

const TOKEN = "abcdefghijklmnopqrstuvwxyz_ABCDE-1234567890";

describe("session capability", () => {
  it("accepts only bounded base64url tokens", () => {
    expect(isSessionCapability(TOKEN)).toBe(true);
    expect(isSessionCapability("short")).toBe(false);
    expect(isSessionCapability(`${TOKEN}?leaked=query`)).toBe(false);
    expect(() => requireSessionCapability("short")).toThrow("base64url token");
  });

  it("builds and verifies an exact bearer header", () => {
    expect(buildCapabilityAuthorization(TOKEN)).toBe(`Bearer ${TOKEN}`);
    expect(isCapabilityAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isCapabilityAuthorized(`bearer ${TOKEN}`, TOKEN)).toBe(false);
    expect(isCapabilityAuthorized(undefined, TOKEN)).toBe(false);
    expect(isCapabilityAuthorized(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
  });

  it("keeps the legacy unauthenticated server seam explicit", () => {
    expect(isCapabilityAuthorized(undefined, undefined)).toBe(true);
  });
});
