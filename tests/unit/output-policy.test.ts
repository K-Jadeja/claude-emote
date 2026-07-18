/**
 * output-policy.test.ts (P10.1)
 *
 * Deterministic tests for the AvatarOutputPolicy abstraction.
 * Uses injected stdout / stderr sinks so we can assert exact
 * bytes regardless of the host test runner's stream wiring.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAvatarOutputPolicy,
  type AvatarOutputPolicy,
} from "../../src/host/output-policy.js";

interface Sinks {
  stdout: string;
  stderr: string;
  stdoutSink: (chunk: string) => void;
  stderrSink: (chunk: string) => void;
}

function makeSinks(): Sinks {
  const s: Sinks = {
    stdout: "",
    stderr: "",
    stdoutSink: () => {},
    stderrSink: () => {},
  };
  s.stdoutSink = (chunk: string) => (s.stdout += chunk);
  s.stderrSink = (chunk: string) => (s.stderr += chunk);
  return s;
}

describe("createAvatarOutputPolicy (P10.1)", () => {
  let workDir: string;
  let logFile: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "output-policy-"));
    logFile = join(workDir, "policy.log");
  });

  afterEach(() => {
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  });

  it("normal mode + debug: writes diagnostics to stderr", () => {
    const s = makeSinks();
    const policy: AvatarOutputPolicy = createAvatarOutputPolicy({
      visualPane: false,
      debug: true,
      sinks: { stdout: s.stdoutSink, stderr: s.stderrSink },
    });
    policy.writeDiagnostic("[diag] hello\n");
    expect(s.stderr).toContain("[diag] hello");
    expect(s.stdout).toBe("");
    expect(policy.visualPane).toBe(false);
  });

  it("normal mode + no debug: writeDiagnostic is silent", () => {
    const s = makeSinks();
    const policy = createAvatarOutputPolicy({
      visualPane: false,
      debug: false,
      sinks: { stdout: s.stdoutSink, stderr: s.stderrSink },
    });
    policy.writeDiagnostic("[diag] hidden\n");
    expect(s.stderr).toBe("");
    expect(s.stdout).toBe("");
  });

  it("normal mode: writeWarning goes to stderr unconditionally", () => {
    const s = makeSinks();
    const policy = createAvatarOutputPolicy({
      visualPane: false,
      debug: false,
      sinks: { stdout: s.stdoutSink, stderr: s.stderrSink },
    });
    policy.writeWarning("[warn] hello\n");
    expect(s.stderr).toContain("[warn] hello");
    expect(s.stdout).toBe("");
  });

  it("normal mode: writeReady goes to stdout", () => {
    const s = makeSinks();
    const policy = createAvatarOutputPolicy({
      visualPane: false,
      debug: false,
      sinks: { stdout: s.stdoutSink, stderr: s.stderrSink },
    });
    policy.writeReady("CLAUDE_EMOTE_READY url=http://127.0.0.1:1234\n");
    expect(s.stdout).toContain("CLAUDE_EMOTE_READY");
    expect(s.stderr).toBe("");
  });

  it("normal mode: writeFatal goes to stderr", () => {
    const s = makeSinks();
    const policy = createAvatarOutputPolicy({
      visualPane: false,
      debug: false,
      sinks: { stdout: s.stdoutSink, stderr: s.stderrSink },
    });
    policy.writeFatal("[fatal] no renderer\n");
    expect(s.stderr).toContain("[fatal] no renderer");
    expect(s.stdout).toBe("");
  });

  it("normal mode: initializeVisualSurface is a no-op (no clear sequence emitted)", () => {
    const s = makeSinks();
    const policy = createAvatarOutputPolicy({
      visualPane: false,
      debug: false,
      sinks: { stdout: s.stdoutSink, stderr: s.stderrSink },
    });
    policy.initializeVisualSurface();
    // Sinks are not touched in normal mode — the clear sequence
    // goes to the terminal-output module's active stream. We
    // assert only that the policy did NOT route through the
    // sinks (which would be incorrect in normal mode).
    expect(s.stdout).toBe("");
    expect(s.stderr).toBe("");
  });

  it("visual-pane mode: writeReady is suppressed from stdout", () => {
    const s = makeSinks();
    const policy = createAvatarOutputPolicy({
      visualPane: true,
      debug: true,
      sinks: { stdout: s.stdoutSink, stderr: s.stderrSink },
    });
    policy.writeReady("CLAUDE_EMOTE_READY url=http://127.0.0.1:1234\n");
    expect(s.stdout).toBe("");
    expect(s.stderr).toBe("");
  });

  it("visual-pane mode: writeWarning is suppressed from stderr", () => {
    const s = makeSinks();
    const policy = createAvatarOutputPolicy({
      visualPane: true,
      debug: true,
      sinks: { stdout: s.stdoutSink, stderr: s.stderrSink },
    });
    policy.writeWarning("[warn] falling back to bundled ASCII\n");
    expect(s.stderr).toBe("");
    expect(s.stdout).toBe("");
  });

  it("visual-pane mode: writeDiagnostic is suppressed from stderr", () => {
    const s = makeSinks();
    const policy = createAvatarOutputPolicy({
      visualPane: true,
      debug: true,
      sinks: { stdout: s.stdoutSink, stderr: s.stderrSink },
    });
    policy.writeDiagnostic("[diag] instance=abc port=1234\n");
    expect(s.stderr).toBe("");
    expect(s.stdout).toBe("");
  });

  it("visual-pane mode: writeFatal may write ONE concise line", () => {
    const s = makeSinks();
    const policy = createAvatarOutputPolicy({
      visualPane: true,
      debug: true,
      sinks: { stdout: s.stdoutSink, stderr: s.stderrSink },
    });
    policy.writeFatal("[fatal] no usable renderer\n");
    // First call lands on stderr.
    expect(s.stderr).toContain("[fatal] no usable renderer");
  });

  it("visual-pane mode: writeFatal is deduplicated to a single line per policy", () => {
    const s = makeSinks();
    const policy = createAvatarOutputPolicy({
      visualPane: true,
      debug: true,
      sinks: { stdout: s.stdoutSink, stderr: s.stderrSink },
    });
    policy.writeFatal("[fatal] first\n");
    policy.writeFatal("[fatal] second\n");
    policy.writeFatal("[fatal] third\n");
    // Only the first line is allowed to reach stderr.
    expect((s.stderr.match(/\[fatal\]/g) || []).length).toBe(1);
    expect(s.stderr).toContain("[fatal] first");
    expect(s.stderr).not.toContain("[fatal] second");
  });

  it("visual-pane mode + logFile: suppressed writes land in the log file", () => {
    const s = makeSinks();
    const policy = createAvatarOutputPolicy({
      visualPane: true,
      debug: true,
      logFile,
      sinks: { stdout: s.stdoutSink, stderr: s.stderrSink },
    });
    policy.writeReady("CLAUDE_EMOTE_READY url=http://127.0.0.1:1234 instance=abc\n");
    policy.writeWarning("[warn] falling back to bundled ASCII\n");
    policy.writeDiagnostic("[diag] instance=abc port=1234\n");
    // stdout / stderr stay clean.
    expect(s.stdout).toBe("");
    expect(s.stderr).toBe("");
    // Every suppressed write lands in the log.
    const log = readFileSync(logFile, "utf8");
    expect(log).toContain("CLAUDE_EMOTE_READY");
    expect(log).toContain("falling back to bundled ASCII");
    expect(log).toContain("instance=abc port=1234");
  });

  it("visual-pane mode: log file exists on construction when provided", () => {
    const s = makeSinks();
    expect(existsSync(logFile)).toBe(false);
    const policy = createAvatarOutputPolicy({
      visualPane: true,
      debug: true,
      logFile,
      sinks: { stdout: s.stdoutSink, stderr: s.stderrSink },
    });
    policy.writeDiagnostic("hi\n");
    expect(existsSync(logFile)).toBe(true);
    appendFileSync(logFile, "external\n");
    policy.writeDiagnostic("more\n");
    const log = readFileSync(logFile, "utf8");
    expect(log).toContain("hi");
    expect(log).toContain("external");
    expect(log).toContain("more");
    void policy;
  });

  it("missing sinks fall back to process.stdout / process.stderr without throwing", () => {
    // Construction must not throw when no sinks are supplied; the
    // policy simply writes to the real streams. We do not assert
    // what the real streams received here (the test runner would
    // capture it). We only assert the policy is functional.
    const policy = createAvatarOutputPolicy({
      visualPane: false,
      debug: false,
    });
    expect(policy.visualPane).toBe(false);
    expect(() => policy.writeDiagnostic("a\n")).not.toThrow();
    expect(() => policy.writeWarning("b\n")).not.toThrow();
    expect(() => policy.writeReady("c\n")).not.toThrow();
    expect(() => policy.writeFatal("d\n")).not.toThrow();
    expect(() => policy.initializeVisualSurface()).not.toThrow();
  });

  it("visual-pane mode without sinks and without log file does not throw", () => {
    const policy = createAvatarOutputPolicy({
      visualPane: true,
      debug: true,
    });
    expect(() => policy.writeReady("r\n")).not.toThrow();
    expect(() => policy.writeWarning("w\n")).not.toThrow();
    expect(() => policy.writeDiagnostic("d\n")).not.toThrow();
    expect(() => policy.writeFatal("f1\n")).not.toThrow();
    expect(() => policy.writeFatal("f2\n")).not.toThrow();
  });
});
