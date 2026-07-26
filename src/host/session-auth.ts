import { timingSafeEqual } from "node:crypto";
import { buildCapabilityAuthorization } from "../shared/session-capability.js";

export function isCapabilityAuthorized(
  authorizationHeader: string | string[] | undefined,
  expectedToken: string | undefined,
): boolean {
  if (expectedToken === undefined) return true;
  if (typeof authorizationHeader !== "string") return false;

  const expected = Buffer.from(
    buildCapabilityAuthorization(expectedToken),
    "utf8",
  );
  const actual = Buffer.from(authorizationHeader, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
