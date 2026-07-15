/**
 * hook-event.ts
 *
 * Strongly-typed shape for every Claude Code hook event claude-emote
 * supports. The shape mirrors the documented Claude Code hook schemas —
 * only the fields the avatar server actually reads are declared, but every
 * supported event has a discriminated-union variant so the event mapper
 * is exhaustive.
 *
 * Field names follow the documented Claude Code hook payloads (camelCase).
 * Extra fields present in the payload are intentionally not modelled here:
 * the bridge forwards the unmodified JSON object to the avatar server, so
 * the server can read fields the mapper ignores.
 */

export type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "MessageDisplay"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PostToolBatch"
  | "PermissionRequest"
  | "PermissionDenied"
  | "SubagentStart"
  | "SubagentStop"
  | "TaskCreated"
  | "TaskCompleted"
  | "Stop"
  | "StopFailure"
  | "PreCompact"
  | "PostCompact"
  | "SessionEnd";

export interface HookSessionStart {
  hook_event_name: "SessionStart";
  session_id: string;
  cwd?: string;
  source?: string;
  model?: string;
}
export interface HookUserPromptSubmit {
  hook_event_name: "UserPromptSubmit";
  session_id: string;
  prompt?: string;
}
export interface HookMessageDisplay {
  hook_event_name: "MessageDisplay";
  session_id: string;
  /** "delta" streams; "final" marks the end of one Claude turn. */
  type: "delta" | "final";
  /** Text content. May be empty for empty delta updates. */
  content: string;
  /** Optional message/turn identifier. */
  message_id?: string;
}
export interface HookPreToolUse {
  hook_event_name: "PreToolUse";
  session_id: string;
  tool_name: string;
  tool_input?: unknown;
}
export interface HookPostToolUse {
  hook_event_name: "PostToolUse";
  session_id: string;
  tool_name: string;
  tool_input?: unknown;
  tool_response?: unknown;
}
export interface HookPostToolUseFailure {
  hook_event_name: "PostToolUseFailure";
  session_id: string;
  tool_name: string;
  tool_input?: unknown;
  error?: string;
}
export interface HookPostToolBatch {
  hook_event_name: "PostToolBatch";
  session_id: string;
  /** Subset of tools that ran. */
  tool_names?: string[];
}
export interface HookPermissionRequest {
  hook_event_name: "PermissionRequest";
  session_id: string;
  tool_name?: string;
}
export interface HookPermissionDenied {
  hook_event_name: "PermissionDenied";
  session_id: string;
  tool_name?: string;
}
export interface HookSubagentStart {
  hook_event_name: "SubagentStart";
  session_id: string;
  subagent_id: string;
  subagent_type?: string;
}
export interface HookSubagentStop {
  hook_event_name: "SubagentStop";
  session_id: string;
  subagent_id: string;
}
export interface HookTaskCreated {
  hook_event_name: "TaskCreated";
  session_id: string;
  task_id: string;
  description?: string;
}
export interface HookTaskCompleted {
  hook_event_name: "TaskCompleted";
  session_id: string;
  task_id: string;
}
export interface HookStop {
  hook_event_name: "Stop";
  session_id: string;
}
export interface HookStopFailure {
  hook_event_name: "StopFailure";
  session_id: string;
  reason?: string;
}
export interface HookPreCompact {
  hook_event_name: "PreCompact";
  session_id: string;
}
export interface HookPostCompact {
  hook_event_name: "PostCompact";
  session_id: string;
}
export interface HookSessionEnd {
  hook_event_name: "SessionEnd";
  session_id: string;
  reason?: string;
}

export type HookEvent =
  | HookSessionStart
  | HookUserPromptSubmit
  | HookMessageDisplay
  | HookPreToolUse
  | HookPostToolUse
  | HookPostToolUseFailure
  | HookPostToolBatch
  | HookPermissionRequest
  | HookPermissionDenied
  | HookSubagentStart
  | HookSubagentStop
  | HookTaskCreated
  | HookTaskCompleted
  | HookStop
  | HookStopFailure
  | HookPreCompact
  | HookPostCompact
  | HookSessionEnd;

/** Read-only tools that map to "read" emote. */
export const READ_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);
/** Tools that map to "write" emote. */
export const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
