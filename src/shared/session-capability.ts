/**
 * Per-session authorization shared by the launcher, hook bridge, host, and
 * desktop client. Tokens are random base64url strings and must never appear in
 * URLs, logs, semantic state, or error messages.
 */

export const SESSION_CAPABILITY_ENV = "CLAUDE_EMOTE_CAPABILITY_TOKEN";
export const MIN_SESSION_CAPABILITY_LENGTH = 32;
export const MAX_SESSION_CAPABILITY_LENGTH = 128;

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isSessionCapability(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= MIN_SESSION_CAPABILITY_LENGTH &&
    value.length <= MAX_SESSION_CAPABILITY_LENGTH &&
    CAPABILITY_PATTERN.test(value)
  );
}

export function requireSessionCapability(
  value: unknown,
  source = SESSION_CAPABILITY_ENV,
): string {
  if (!isSessionCapability(value)) {
    throw new Error(
      `${source} must be a ${MIN_SESSION_CAPABILITY_LENGTH}-${MAX_SESSION_CAPABILITY_LENGTH} character base64url token`,
    );
  }
  return value;
}

export function buildCapabilityAuthorization(token: string): string {
  return `Bearer ${requireSessionCapability(token, "session capability")}`;
}
