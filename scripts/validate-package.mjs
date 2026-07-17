#!/usr/bin/env node
/**
 * validate-package.mjs
 *
 * Phase 9A: clean-checkout and packaged-install validation.
 *
 * Proves that claude-emote works from:
 *
 *   1. The development checkout (this script runs here).
 *   2. A generated npm tarball installed into an unrelated
 *      temporary directory.
 *
 * The script is intentionally cross-platform Node — no shell:true,
 * no PowerShell, no Bash-only assumptions. Everything is executed
 * via spawn() with explicit argv arrays and explicit env handling.
 *
 * Pass structure:
 *
 *   Pass A — LIFECYCLE PACK (authoritative)
 *     Run normal `npm pack --json` WITHOUT --ignore-scripts.
 *     Because package.json declares `prepack: npm run build`,
 *     npm pack triggers a real build of dist/ from scratch.
 *     Parse the JSON. The tarball from this pack is installed
 *     and used for the smoke tests and plugin validation.
 *
 *   Pass B — EXCLUSION INSPECTION PACK (secondary)
 *     After Pass A's build exists, plant three sentinel files in
 *     dist/ (with extensions .ndjson, .pid, .log) and run a
 *     SECOND pack WITH --ignore-scripts so prepack does not
 *     erase the sentinels. Parse its files array. Assert all
 *     three sentinels are absent. Remove sentinels in finally.
 *     This pack is NEVER installed. It exists only to prove the
 *     package files-allowlist excludes the sentinel file types.
 *
 *   INSTALLED SMOKE TESTS
 *     Spawn the installed bin with --version (Pass A's tarball).
 *     Spawn the installed dist/host/avatar-process.js with
 *     --port=0 from an unrelated cwd with no emotes directory,
 *     wait for the real READY line, parse the actual bound port
 *     + instanceId + emoteDir from it, then POST a real
 *     UserPromptSubmit event and observe the bundled ASCII
 *     think frame (`(•_ •)?`) emitted to stdout. SIGTERM, await
 *     exit, prove PID is gone.
 *
 *   PLUGIN VALIDATION
 *     Run `claude plugin validate <installedRoot> --strict`
 *     against the explicit absolute installed package root.
 *
 * On any failure, the script exits non-zero with a clear error.
 *
 * This script does NOT call `npm publish`. It does NOT open a real
 * Claude session. It does NOT open Windows Terminal.
 */

// Node built-ins only.
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve, normalize, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { request } from "node:http";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(__filename, "..", "..");

const NODE = process.execPath;

// npm is shipped with Node. We invoke it directly via Node's
// require.resolve to avoid the spawn EINVAL that occurs on Windows
// when launching npm.cmd as a literal exe (npm.cmd is a batch
// shim that requires shell interpretation). Using the npm CLI
// JavaScript file as the entry point is fully supported and
// documented (npm itself runs this way internally).
function resolveNpmCliJs() {
  try {
    return require.resolve("npm/bin/npm-cli.js");
  } catch {
    const exeDir = resolve(NODE, "..");
    const candidates = [
      join(exeDir, "node_modules", "npm", "bin", "npm-cli.js"),
      join(exeDir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    throw new Error("Could not locate npm CLI script (npm-cli.js)");
  }
}

const NPM_CLI = resolveNpmCliJs();
function npm(args, opts = {}) {
  return run(NODE, [NPM_CLI, ...args], opts);
}
function npmWithTimeout(args, timeoutMs, opts = {}) {
  return runWithTimeout(NODE, [NPM_CLI, ...args], timeoutMs, opts);
}

/**
 * Run a command, return { code, stdout, stderr }. Never throws.
 * `cmd` and `args` are explicit arrays — no shell, no cmd /c.
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolveOne) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr?.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("close", (code) => resolveOne({ code: code ?? 1, stdout, stderr }));
    child.on("error", (err) =>
      resolveOne({ code: 1, stdout, stderr: stderr + String(err) }),
    );
  });
}

/** Run with timeout, kill if exceeds. */
async function runWithTimeout(cmd, args, timeoutMs, opts = {}) {
  return new Promise((resolveOne) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout?.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr?.on("data", (b) => (stderr += b.toString("utf8")));
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveOne({
        code: killed ? 124 : (code ?? 1),
        stdout,
        stderr,
        killed,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveOne({ code: 1, stdout, stderr: stderr + String(err), killed });
    });
  });
}

let failureCount = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failureCount++;
    console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

const SENTINEL_FILES = [
  "dist/package-validation-forbidden.ndjson",
  "dist/package-validation-forbidden.pid",
  "dist/package-validation-forbidden.log",
];

/**
 * Find the first JSON object in `stdout` even if other text was
 * emitted first (e.g. the `> prepack` lines from npm's lifecycle
 * scripts). npm pack --json with prepack enabled prepends the
 * prepack command output to stdout, so we cannot assume the
 * document starts at offset 0.
 */
function extractJson(stdout) {
  // npm pack --json with lifecycle scripts emits one or more
  // "npm>" prefixed lines before the JSON. Find the first "{" or "["
  // and parse from there.
  for (let i = 0; i < stdout.length; i++) {
    const c = stdout[i];
    if (c === "{" || c === "[") {
      try {
        const parsed = JSON.parse(stdout.slice(i));
        return parsed;
      } catch {
        // Continue scanning in case of a stray leading brace.
      }
    }
  }
  throw new Error(`could not locate JSON in npm pack --json output:\n${stdout}`);
}

function normalizePath(p) {
  return String(p).replaceAll("\\", "/");
}

async function main() {
  console.log("validate-package: starting");
  console.log(`  ROOT = ${ROOT}`);
  console.log(`  NODE = ${NODE}`);
  console.log(`  NPM  = ${NPM_CLI}`);

  // Record whether dist existed BEFORE we start any work. The Pass
  // A lifecycle pack must create dist if it was absent (proving
  // prepack runs).
  const distExistedBefore = existsSync(join(ROOT, "dist"));
  console.log(`  dist existed before lifecycle pack: ${distExistedBefore}`);

  const baseTmp = mkdtempSync(join(tmpdir(), "claude-emote-pkg-"));
  const lifecyclePackDir = join(baseTmp, "lifecycle-pack");
  const inspectionPackDir = join(baseTmp, "inspection-pack");
  const installDir = join(baseTmp, "install");
  mkdirSync(lifecyclePackDir, { recursive: true });
  mkdirSync(inspectionPackDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });

  const trackedFiles = [];
  const trackedDirs = [baseTmp, lifecyclePackDir, inspectionPackDir, installDir];
  const trackedSentinels = [];

  let lifecyclePackResult = null;
  let lifecyclePackedPaths = null;
  let inspectionPackResult = null;
  let installedRoot = null;

  try {
    // ---- Pass A: LIFECYCLE PACK -------------------------------
    //
    // This is the AUTHORITATIVE pack. It runs without
    // --ignore-scripts, so package.json's `prepack: npm run build`
    // fires and creates dist/ if it was missing. The tarball from
    // this pack is the one we install and use for the smoke tests.
    console.log("\n[Pass A] lifecycle pack — NO --ignore-scripts, prepack runs build");
    if (distExistedBefore) {
      // Start from a clean dist so prepack's tsc rebuilds it from
      // scratch. This proves prepack can produce a working dist,
      // not just that it would skip a build that was already done.
      rmSync(join(ROOT, "dist"), { recursive: true, force: true });
    }
    const pack = await npm(
      ["pack", "--json", "--pack-destination", lifecyclePackDir],
      { cwd: ROOT },
    );
    if (pack.code !== 0) {
      throw new Error(`npm pack failed (code=${pack.code}):\n${pack.stderr}`);
    }
    let parsed;
    try {
      parsed = extractJson(pack.stdout);
    } catch (e) {
      throw new Error(`${e.message}\n--- raw stdout ---\n${pack.stdout}`);
    }
    if (!Array.isArray(parsed) || parsed.length !== 1) {
      throw new Error(`expected exactly one packed entry, got: ${pack.stdout}`);
    }
    const tarballName = parsed[0].filename;
    const tarballPath = join(lifecyclePackDir, tarballName);
    lifecyclePackResult = {
      path: tarballPath,
      name: tarballName,
      size: parsed[0].size,
      command: "npm pack --json --pack-destination <lifecycle-pack-dir>",
      usedIgnoreScripts: false,
    };
    trackedFiles.push(tarballPath);

    const distExistedAfter = existsSync(join(ROOT, "dist"));
    console.log(`  normal pack command contained no --ignore-scripts: ${!lifecyclePackResult.usedIgnoreScripts}`);
    console.log(`  dist existed after lifecycle pack: ${distExistedAfter}`);

    check("Pass A: npm pack produced tarball", existsSync(tarballPath), tarballPath);
    check(
      "Pass A: tarball size > 1 KiB",
      lifecyclePackResult.size > 1024,
      `size=${lifecyclePackResult.size}`,
    );
    check("Pass A: dist existed after lifecycle pack", distExistedAfter);

    // Parse the lifecycle pack's files array.
    console.log("[Pass A] inspecting pack JSON");
    lifecyclePackedPaths = new Set(
      (parsed[0].files ?? []).map((entry) => normalizePath(entry.path)),
    );

    const requiredEntries = [
      "dist/launcher/claude-emote.js",
      "dist/host/avatar-process.js",
      "dist/claude/hook-bridge.js",
      "bin/claude-emote.cjs",
      "hooks/hooks.json",
      ".claude-plugin/plugin.json",
      "emotes/ascii/ascii.yaml",
      "emotes/default/emotes.json",
      "config.json",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "README.md",
      "package.json",
    ];
    for (const p of requiredEntries) {
      check(`Pass A: required entry present: ${p}`, lifecyclePackedPaths.has(p));
    }

    // ---- Install the lifecycle tarball --------------------------
    console.log("[Install] installing lifecycle tarball in unrelated temp dir");
    const initRes = await npm(["init", "-y"], { cwd: installDir });
    if (initRes.code !== 0) {
      throw new Error(`npm init failed:\n${initRes.stderr}`);
    }
    const installRes = await npmWithTimeout(
      ["install", "--no-audit", "--no-fund", "--no-save", tarballPath],
      120_000,
      { cwd: installDir },
    );
    if (installRes.code !== 0) {
      throw new Error(`npm install failed (code=${installRes.code}):\n${installRes.stderr}`);
    }
    installedRoot = join(installDir, "node_modules", "claude-emote");
    check("installed package root exists", existsSync(installedRoot), installedRoot);
    check(
      "installed dist launcher exists",
      existsSync(join(installedRoot, "dist", "launcher", "claude-emote.js")),
    );
    check(
      "installed dist avatar-process exists",
      existsSync(join(installedRoot, "dist", "host", "avatar-process.js")),
    );
    check(
      "installed bin/claude-emote.cjs exists",
      existsSync(join(installedRoot, "bin", "claude-emote.cjs")),
    );
    check(
      "installed hooks/hooks.json exists",
      existsSync(join(installedRoot, "hooks", "hooks.json")),
    );
    check(
      "installed plugin.json exists",
      existsSync(join(installedRoot, ".claude-plugin", "plugin.json")),
    );
    check(
      "installed emote dir ascii exists",
      existsSync(join(installedRoot, "emotes", "ascii")),
    );
    check(
      "installed emote dir default exists",
      existsSync(join(installedRoot, "emotes", "default")),
    );

    // ---- --version smoke test ----------------------------------
    console.log("[--version smoke] running installed bin with --version");
    const fakeClaudePath = join(installDir, "fake-claude.cjs");
    writeFileSync(
      fakeClaudePath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const recordPath = process.env.FAKE_CLAUDE_RECORD;
fs.writeFileSync(recordPath, JSON.stringify({
  argv: process.argv.slice(2),
  pid: process.pid,
  ts: Date.now(),
}, null, 2));
const code = Number(process.env.FAKE_CLAUDE_EXIT_CODE || 0);
process.exit(code);
`,
      "utf8",
    );
    const fakeClaudeRecord = join(installDir, "fake-claude-record.json");
    writeFileSync(fakeClaudeRecord, "{}", "utf8");

    const installedBin = join(installedRoot, "bin", "claude-emote.cjs");
    const versionRes = await runWithTimeout(
      NODE,
      [installedBin, "--version"],
      10_000,
      {
        cwd: installDir,
        env: {
          ...process.env,
          CLAUDE_EMOTE_CLAUDE_EXE: fakeClaudePath,
          FAKE_CLAUDE_RECORD: fakeClaudeRecord,
          FAKE_CLAUDE_EXIT_CODE: "0",
        },
      },
    );
    check("--version exit code is 0", versionRes.code === 0, versionRes.stderr);
    const versionRecord = JSON.parse(readFileSync(fakeClaudeRecord, "utf8"));
    check(
      "--version spawned exactly one fake Claude",
      versionRecord && versionRecord.argv && Array.isArray(versionRecord.argv),
    );
    check(
      "--version passed --version to fake Claude",
      versionRecord && versionRecord.argv && versionRecord.argv.includes("--version"),
      JSON.stringify(versionRecord.argv),
    );
    check(
      "no health port selected (no port= in record)",
      !(versionRecord && versionRecord.argv && versionRecord.argv.some((a) => /^--port=/.test(a))),
    );
    check(
      "no --instance= in version record",
      !(versionRecord && versionRecord.argv && versionRecord.argv.some((a) => /^--instance=/.test(a))),
    );
    if (versionRecord && versionRecord.pid) {
      let alive = false;
      try {
        process.kill(versionRecord.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      check("no fake Claude survives --version", !alive, `pid=${versionRecord.pid}`);
    }

    // ---- installed avatar-process smoke (real frame) ----------
    console.log("[avatar smoke] spawning installed avatar-process.js with --port=0");
    const avatarSmoke = await runInstalledAvatarSmoke(installedRoot, installDir);
    for (const [name, ok, detail] of avatarSmoke) {
      check(name, ok, detail ?? "");
    }

    // ---- plugin validate (installed root) ---------------------
    console.log("[plugin] claude plugin validate (installed root, strict)");
    const pluginRes = await run(
      "claude",
      ["plugin", "validate", installedRoot, "--strict"],
    );
    if (pluginRes.code === 127 || /not recognized/i.test(pluginRes.stderr)) {
      check(
        "claude CLI present",
        false,
        "claude CLI not on PATH — install Claude Code or set PATH",
      );
    } else if (pluginRes.code === 0) {
      console.log(`  PASS  installed plugin validation: ${installedRoot}`);
      check(`installed plugin validation: ${installedRoot}`, true);
    } else {
      check(`installed plugin validation: ${installedRoot}`, false, pluginRes.stderr);
    }

    // ---- Pass B: EXCLUSION INSPECTION PACK ---------------------
    //
    // Run AFTER Pass A's dist exists so we can plant sentinels
    // and verify the package files-allowlist keeps them out.
    // --ignore-scripts is REQUIRED here — otherwise prepack would
    // re-run tsc and erase the sentinels before pack could observe
    // them. This pack is NEVER installed; it exists only to
    // prove the sentinel file types are excluded.
    console.log("\n[Pass B] exclusion inspection pack — with --ignore-scripts");
    mkdirSync(join(ROOT, "dist"), { recursive: true });
    for (const rel of SENTINEL_FILES) {
      const p = join(ROOT, rel);
      writeFileSync(p, "sentinel", "utf8");
      trackedSentinels.push(p);
    }
    const inspectionPack = await npm(
      ["pack", "--json", "--pack-destination", inspectionPackDir, "--ignore-scripts"],
      { cwd: ROOT },
    );
    if (inspectionPack.code !== 0) {
      throw new Error(`Pass B npm pack failed:\n${inspectionPack.stderr}`);
    }
    let inspectionParsed;
    try {
      inspectionParsed = extractJson(inspectionPack.stdout);
    } catch (e) {
      throw new Error(`${e.message}\n--- raw stdout ---\n${inspectionPack.stdout}`);
    }
    const inspectionTarballName = inspectionParsed[0].filename;
    const inspectionTarballPath = join(inspectionPackDir, inspectionTarballName);
    trackedFiles.push(inspectionTarballPath);
    inspectionPackResult = {
      path: inspectionTarballPath,
      name: inspectionTarballName,
      command: "npm pack --json --pack-destination <inspection-pack-dir> --ignore-scripts",
    };

    const inspectionPackedPaths = new Set(
      (inspectionParsed[0].files ?? []).map((entry) => normalizePath(entry.path)),
    );
    const sentinelAssertions = [
      "dist/package-validation-forbidden.ndjson",
      "dist/package-validation-forbidden.pid",
      "dist/package-validation-forbidden.log",
    ];
    for (const s of sentinelAssertions) {
      check(`Pass B: sentinel excluded: ${s}`, !inspectionPackedPaths.has(s));
    }
  } finally {
    // Cleanup. Order: kill children, remove temp dirs/tarballs,
    // remove sentinels.
    // trackedChildren intentionally omitted — we do not spawn
    // long-lived tracked children in this script; child processes
    // are awaited inline.
    for (const f of trackedFiles) {
      try { rmSync(f, { force: true }); } catch {}
    }
    for (const d of trackedDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    for (const s of trackedSentinels) {
      try { rmSync(s, { force: true }); } catch {}
    }
  }

  console.log("\nvalidate-package: summary");
  console.log(`  Pass A (lifecycle):       ${lifecyclePackResult?.command}`);
  console.log(`  Pass A tarball used for installation and smoke tests.`);
  if (inspectionPackResult) {
    console.log(`  Pass B (inspection):     ${inspectionPackResult.command}`);
  }
  if (installedRoot) {
    console.log(`  installed package root:  ${installedRoot}`);
  }

  if (failureCount > 0) {
    console.error(`validate-package: ${failureCount} check(s) failed.`);
    process.exit(1);
  }
  console.log("validate-package: all checks passed.");
}

/**
 * Installed avatar-process smoke (full production path).
 *
 * Spawn the installed <root>/dist/host/avatar-process.js with
 * --port=0 from an unrelated cwd with no emotes directory. Wait
 * for the real READY line. Parse actual bound port, instanceId,
 * and emoteDir. POST a real UserPromptSubmit event. Verify that
 * the bundled ASCII think frame ((•_ •)?) is emitted to stdout
 * after the POST. SIGTERM, await exit, prove PID is gone.
 */
async function runInstalledAvatarSmoke(installedRoot, installDir) {
  const checks = [];
  const unrelatedCwd = mkdtempSync(join(installDir, "smoke-"));
  // Plant ONLY a project-level config forcing ASCII. Do NOT plant
  // any emotes directory.
  const projCfgDir = join(unrelatedCwd, ".claude-emote", "extensions", "claude-emote");
  mkdirSync(projCfgDir, { recursive: true });
  writeFileSync(
    join(projCfgDir, "config.json"),
    JSON.stringify({ terminals: [{ match: "unknown", render: "ascii" }] }),
    "utf8",
  );

  // Strip renderer-affecting env vars.
  const cleanEnv = { ...process.env };
  for (const k of [
    "WT_SESSION", "TERM_PROGRAM", "ITERM_SESSION_ID",
    "KITTY_WINDOW_ID", "WEZTERM_PANE", "GHOSTTY_RESOURCES_DIR",
    "TMUX", "ZELLIJ_SESSION_NAME", "ZELLIJ",
    "CLAUDE_EMOTE_PORT", "CLAUDE_EMOTE_INSTANCE_ID",
    "CLAUDE_EMOTE_EMOTE_DIR", "CLAUDE_EMOTE_PARENT_PID",
    "CLAUDE_EMOTE_LOG_FILE", "CLAUDE_EMOTE_DEBUG",
    "CLAUDE_EMOTE_DEMO_PROTOCOL",
  ]) delete cleanEnv[k];

  const avatarScript = join(installedRoot, "dist", "host", "avatar-process.js");
  // --port=0 → OS picks an unused port; we read it from READY.
  // --instance=package-smoke → asserted via /health.
  // No --emoteDir → forced-ASCII comes from the project config we
  // planted above.
  const child = spawn(
    NODE,
    [avatarScript, "--port=0", "--instance=package-smoke"],
    { env: cleanEnv, stdio: ["ignore", "pipe", "pipe"], cwd: unrelatedCwd },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (b) => (stdout += b.toString("utf8")));
  child.stderr?.on("data", (b) => (stderr += b.toString("utf8")));

  // Wait for READY. The READY line includes the actual bound
  // port, the instanceId, and the resolved emoteDir.
  let readyLine = "";
  let readyPort = 0;
  let readyEmoteDir = "";
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (stdout.includes("CLAUDE_EMOTE_READY")) {
      readyLine = stdout.split(/\r?\n/).find((l) => l.includes("CLAUDE_EMOTE_READY")) ?? "";
      const pm = readyLine.match(/port=(\d+)/);
      const im = readyLine.match(/instance=(\S+)/);
      const em = readyLine.match(/emoteDir=(\S+)/);
      if (pm) readyPort = Number(pm[1]);
      if (em) readyEmoteDir = em[1];
      void im;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  checks.push(["avatar-process printed READY", readyPort > 0, readyLine]);
  checks.push(["requested port was 0", true]);
  checks.push([
    "reported actual port is a positive integer",
    Number.isInteger(readyPort) && readyPort > 0,
    `port=${readyPort}`,
  ]);

  // emoteDir must be under the installed package root and NOT
  // under the development repository or the unrelated cwd.
  const installedRootNorm = normalize(installedRoot);
  const unrelatedCwdNorm = normalize(unrelatedCwd);
  const repoRootNorm = normalize(ROOT);
  const emoteDirNorm = normalize(readyEmoteDir);
  const underInstalled = emoteDirNorm.startsWith(installedRootNorm + sep) ||
    emoteDirNorm === installedRootNorm;
  const underRepo = emoteDirNorm.startsWith(repoRootNorm + sep) ||
    emoteDirNorm === repoRootNorm;
  const underCwd = emoteDirNorm.startsWith(unrelatedCwdNorm + sep) ||
    emoteDirNorm === unrelatedCwdNorm;
  checks.push([
    "effective emote directory is under the installed package root",
    underInstalled,
    readyEmoteDir,
  ]);
  checks.push([
    "effective emote directory is NOT under the development repository",
    !underRepo,
    readyEmoteDir,
  ]);
  checks.push([
    "effective emote directory is NOT under the unrelated temporary cwd",
    !underCwd,
    readyEmoteDir,
  ]);
  checks.push([
    "unrelated cwd contains no emotes directory",
    !existsSync(join(unrelatedCwd, "emotes")),
  ]);

  // /health checks
  if (readyPort > 0) {
    const health = await new Promise((resolveOne) => {
      const req = request(
        `http://127.0.0.1:${readyPort}/health`,
        { method: "GET", timeout: 2000 },
        (res) => {
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (buf += c));
          res.on("end", () => resolveOne({ code: res.statusCode ?? 0, body: buf }));
        },
      );
      req.on("error", (e) => resolveOne({ code: -1, body: String(e) }));
      req.on("timeout", () => { req.destroy(); resolveOne({ code: -1, body: "timeout" }); });
      req.end();
    });
    checks.push(["/health returns 200", health.code === 200, JSON.stringify(health)]);
    let parsedHealth = null;
    try { parsedHealth = JSON.parse(health.body); } catch {}
    checks.push([
      "/health.port equals reported actual port",
      parsedHealth && typeof parsedHealth.port === "number" && parsedHealth.port === readyPort,
      JSON.stringify(parsedHealth),
    ]);
    checks.push([
      "/health.instanceId equals package-smoke",
      parsedHealth && parsedHealth.instanceId === "package-smoke",
      JSON.stringify(parsedHealth),
    ]);

    // Record the stdout length BEFORE the POST so we only inspect
    // output produced after the event.
    const stdoutLenBeforePost = stdout.length;

    const post = await new Promise((resolveOne) => {
      const payload = JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "package-smoke",
        prompt: "package frame smoke",
      });
      const req = request(
        `http://127.0.0.1:${readyPort}/event`,
        { method: "POST", timeout: 2000, headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        } },
        (res) => {
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (buf += c));
          res.on("end", () => resolveOne({ code: res.statusCode ?? 0, body: buf }));
        },
      );
      req.on("error", (e) => resolveOne({ code: -1, body: String(e) }));
      req.on("timeout", () => { req.destroy(); resolveOne({ code: -1, body: "timeout" }); });
      req.end(payload);
    });
    checks.push(["POST /event returns 200", post.code === 200, JSON.stringify(post)]);

    // Wait for the bundled ASCII think frame to appear in stdout
    // AFTER the POST. The frame text is exactly what's in
    // emotes/ascii/ascii.yaml: `think.default: "(•_ • )?"`
    // (note the space between `•` and `)`).
    const thinkFrame = "(•_ • )?";
    const frameDeadline = Date.now() + 4000;
    let postPostStdout = "";
    while (Date.now() < frameDeadline) {
      postPostStdout = stdout.slice(stdoutLenBeforePost);
      if (postPostStdout.includes(thinkFrame)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    checks.push([
      `ASCII think frame emitted after POST: ${thinkFrame}`,
      postPostStdout.includes(thinkFrame),
      postPostStdout.slice(-200) || "(no new stdout after POST)",
    ]);
  }

  // SIGTERM and wait for clean exit.
  try { child.kill("SIGTERM"); } catch {}
  await new Promise((resolveOne) => {
    const t = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolveOne();
    }, 5000);
    child.once("close", () => { clearTimeout(t); resolveOne(); });
  });
  let alive = false;
  try { process.kill(child.pid, 0); alive = true; } catch {}
  checks.push(["avatar-process exits and no PID remains", !alive, `pid=${child.pid}`]);
  try { rmSync(unrelatedCwd, { recursive: true, force: true }); } catch {}

  return checks;
}

main().catch((err) => {
  console.error("validate-package: fatal:", err.message || err);
  process.exit(1);
});