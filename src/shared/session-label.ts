/**
 * Environment-only desktop session identity.
 *
 * These values are deliberately separate from PetSessionState. A project
 * label is presentation context, not a Claude lifecycle event, and must never
 * enter the HTTP/SSE protocol.
 */
export const SESSION_LABEL_ENV = "CLAUDE_EMOTE_SESSION_LABEL";
export const HIDE_SESSION_LABEL_ENV = "CLAUDE_EMOTE_HIDE_SESSION_LABEL";
