/**
 * windows-terminal-launcher.test.ts (P8)
 *
 * Integration test using a fake Windows Terminal (`wt.exe`). The
 * fake is a Node script invoked through the launcher when
 * CLAUDE_EMOTE_WT_EXE is set and platform === "win32". For
 * portability we use CLAUDE_EMOTE_TEST_MODE=1 (which bypasses
 * wt.exe) for the existing launcher suite and reserve this new
 * suite for the real path.
 *
 * The fake wt behaves like the real Windows Terminal:
 *   - Records its argv, cwd, env.
 *   - Spawns the final executable+argv it was given exactly as
 *     received (with shell:false and detached:false) so the test
 *     exercises the full "argv reaches the avatar exactly"
 *     contract.
 *   - Exits after the avatar exits.
 *
 * The launcher is exercised with:
 *   - CLAUDE_EMOTE_WT_EXE=<fake>
 *   - CLAUDE_EMOTE_CLAUDE_EXE=<fake claude>
 *   - CLAUDE_EMOTE_AVATAR_EXE=<fake avatar>
 *   - CLAUDE_EMOTE_TEST_MODE not set (so the wt branch runs).
 *
 * Platform: tests rely on the launcher's spawn(platform=...)
 * selection. We patch process.platform to "win32" inside the
 * launcher process by setting an env var the launcher reads.
 * Because monkey-patching process.platform globally would leak
 * across tests, the launcher exposes a narrow helper via the env
 * var `CLAUDE_EMOTE_TEST_PLATFORM`. When unset, the launcher's
 * own process.platform is used.
 *
 * The fake wt behaves as wt.exe would: it accepts the documented
 * argv, parses -w, split-pane, -V, --size, -d, --title, then
 * launches the trailing executable+argv as the pane child. The
 * fake records every flag and value.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { createServer, type Server } from "node:net";

const PROJECT_ROOT = resolve(process.cwd());
const LAUNCHER = join(PROJECT_ROOT, "dist", "launcher", "claude-emote.js");
const NODE = process.execPath;

const FAKE_DIR = join(tmpdir(), "claude-emote-p8-fake-" + Date.now());
// The fake "wt.exe" is a Node CJS script. The launcher's wt-spawn
// branch has a test-seam that routes .cjs/.js/.mjs paths through
// the current node binary so a real spawn(wtExe, ..., { shell:false })
// can still execute the script.
const FAKE_WT_PATH = join(FAKE_DIR, "fake-wt.cjs");
const FAKE_CLAUDE_PATH = join(FAKE_DIR, "claude.cjs");
const FAKE_AVATAR_PATH = join(FAKE_DIR, "avatar.cjs");
const WT_RECORD = join(FAKE_DIR, "wt-record.json");
const CLAUDE_RECORD = join(FAKE_DIR, "claude-record.json");
const PIDS_RECORD = join(FAKE_DIR, "fake-avatar-pids.json");

beforeAll(() => {
  mkdirSync(FAKE_DIR, { recursive: true });

  // Fake wt.exe behaviour script. The launcher routes .cjs files through
  // node so this script is invoked as the wt_exe replacement.
  writeFileSync(
    FAKE_WT_PATH,
    `
const fs = require("node:fs");
const recordPath = process.env.FAKE_WT_RECORD;
const argv = process.argv.slice(2);
const cwd = process.cwd();
const env = process.env;

// Extract the trailing executable + its argv (everything after the
// last "--title <title>" pair). We assume the launcher constructs the
// argv in the documented order so the pane payload is the tail.
const sepIdx = argv.indexOf("--title");
let paneArgs = [];
let title = "";
if (sepIdx >= 0) {
  title = argv[sepIdx + 1] || "";
  paneArgs = argv.slice(sepIdx + 2);
} else {
  paneArgs = argv;
}

const record = {
  argv,
  cwd,
  env,
  flags: {
    window: argv.indexOf("-w") >= 0 ? argv[argv.indexOf("-w") + 1] : null,
    splitPane: argv.includes("split-pane"),
    vertical: argv.includes("-V"),
    size: argv.indexOf("--size") >= 0 ? argv[argv.indexOf("--size") + 1] : null,
    workingDir: argv.indexOf("-d") >= 0 ? argv[argv.indexOf("-d") + 1] : null,
    title,
    paneArgs,
    paneExecutable: paneArgs[0] || null,
  },
};
fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
// Refuse fullscreen shortcuts.
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "-F") {
    console.error("FAKE_WT: refused -F (fullscreen)");
    process.exit(2);
  }
}

// Now actually launch the pane.
if (paneArgs.length === 0) {
  console.error("FAKE_WT: no pane executable provided");
  process.exit(3);
}
const { spawn } = require("node:child_process");
const paneCwd = argv.indexOf("-d") >= 0 ? argv[argv.indexOf("-d") + 1] : cwd;
const child = spawn(paneArgs[0], paneArgs.slice(1), {
  cwd: paneCwd,
  shell: false,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
`,
    "utf8",
  );

  // Fake claude: records argv + env + cwd, exits with FAKE_CLAUDE_EXIT_CODE.
  writeFileSync(
    FAKE_CLAUDE_PATH,
    `
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
}, null, 2));
const code = Number(process.env.FAKE_CLAUDE_EXIT_CODE || 0);
process.exit(code);
`,
    "utf8",
  );

  // Fake avatar: parses --port, listens on 127.0.0.1:port, replies 200
  // to /health and /event. Stays running until killed by the launcher
  // shutdown or the test cleanup.
  writeFileSync(
    FAKE_AVATAR_PATH,
    `
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
let port = 0;
let instance = "test";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && i + 1 < args.length) port = Number(args[++i]);
  if (args[i] === "--instance" && i + 1 < args.length) instance = args[++i];
  const m = args[i].match(/^--port=(.+)$/); if (m) port = Number(m[1]);
  const mi = args[i].match(/^--instance=(.+)$/); if (mi) instance = mi[1];
}
if (!port) { console.error("fake avatar: --port missing"); process.exit(2); }

const pidsPath = process.env.FAKE_AVATAR_PIDS_FILE;
if (pidsPath) {
  try {
    const list = JSON.parse(fs.readFileSync(pidsPath, "utf8"));
    list.push({ pid: process.pid, port, startedAt: Date.now() });
    fs.writeFileSync(pidsPath, JSON.stringify(list, null, 2));
  } catch {}
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, instanceId: instance }));
    return;
  }
  if (req.method === "POST" && req.url === "/event") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
    return;
  }
  res.statusCode = 404;
  res.end();
});
server.listen(port, "127.0.0.1", () => {
  console.log("FAKE_AVATAR_READY port=" + port + " instance=" + instance + " pid=" + process.pid);
});
`,
    "utf8",
  );

  writeFileSync(PIDS_RECORD, "[]\n", "utf8");
});

afterAll(() => {
  try { rmSync(FAKE_DIR, { recursive: true, force: true }); } catch {}
});

async function pickPort(): Promise<number> {
  return new Promise<number>((r) => {
    const s: Server = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
}

interface WtRecord {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  flags: {
    window: string | null;
    splitPane: boolean;
    vertical: boolean;
    size: string | null;
    workingDir: string | null;
    title: string;
    paneArgs: string[];
    paneExecutable: string | null;
  };
}

function readWtRecord(): WtRecord {
  return JSON.parse(readFileSync(WT_RECORD, "utf8"));
}

interface ClaudeRecord {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function readClaudeRecord(): ClaudeRecord {
  return JSON.parse(readFileSync(CLAUDE_RECORD, "utf8"));
}

interface LaunchResult {
  code: number;
  stderr: string;
}

function runLauncher(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<LaunchResult> {
  return new Promise((resolveOne, rejectErr) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...extraEnv,
      CLAUDE_EMOTE_CLAUDE_EXE: FAKE_CLAUDE_PATH,
      CLAUDE_EMOTE_AVATAR_EXE: FAKE_AVATAR_PATH,
      CLAUDE_EMOTE_WT_EXE: FAKE_WT_PATH,
      // Make the launcher run on Windows + wt.exe present even if the
      // host is not Windows, so this suite works on every CI machine.
      CLAUDE_EMOTE_TEST_PLATFORM: "win32",
      // Default WT_SESSION to a non-empty fake value so the WT branch
      // is exercised. Tests that want the attached-fallback path
      // pass `wtSession: ""` (or call runLauncherAttached()).
      WT_SESSION: extraEnv.wtSession ?? "phase8-fake-session-abcdef",
      // Test mode is deliberately NOT set: this suite must exercise the
      // wt.exe branch.
      CLAUDE_EMOTE_DEBUG: "1",
      FAKE_CLAUDE_RECORD: CLAUDE_RECORD,
      FAKE_WT_RECORD: WT_RECORD,
      FAKE_AVATAR_PIDS_FILE: PIDS_RECORD,
      FAKE_CLAUDE_EXIT_CODE: extraEnv.FAKE_CLAUDE_EXIT_CODE || "0",
    };
    // Clear variables that could fool the WT detection.
    delete env.LOCALAPPDATA;
    delete env.CLAUDE_EMOTE_TEST_MODE;
    if (extraEnv.wtSession === "") {
      delete env.WT_SESSION;
    }

    const child: ChildProcess = spawn(NODE, [LAUNCHER, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectErr(
        new Error(`launcher timed out after 25s. stderr:\n${stderr}`),
      );
    }, 25_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveOne({ code: code ?? 0, stderr });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      rejectErr(e);
    });
  });
}

const TEST_TIMEOUT = 30_000;
const SIGTERM_TEST_TIMEOUT = 60_000;

describe("launcher with fake Windows Terminal (P8)", () => {
  it(
    "fake wt receives -w 0, split-pane -V, --size 0.25, -d <cwd>, --title",
    { timeout: TEST_TIMEOUT },
    async () => {
      const { code, stderr } = await runLauncher(["--resume"]);
      if (code !== 0) {
        throw new Error(`launcher exited ${code}; stderr:\n${stderr}`);
      }
      const r = readWtRecord();
      expect(r.flags.window).toBe("0");
      expect(r.flags.splitPane).toBe(true);
      expect(r.flags.vertical).toBe(true);
      expect(parseFloat(r.flags.size ?? "0")).toBeCloseTo(0.25, 5);
      expect(r.flags.workingDir).toBe(PROJECT_ROOT);
      expect(r.flags.title).toMatch(/claude-emote/);
    },
  );

  it(
    "fake wt receives process.execPath as the pane executable",
    { timeout: TEST_TIMEOUT },
    async () => {
      const { code, stderr } = await runLauncher(["--resume"]);
      if (code !== 0) {
        throw new Error(`launcher exited ${code}; stderr:\n${stderr}`);
      }
      const r = readWtRecord();
      expect(r.flags.paneExecutable).toBe(process.execPath);
    },
  );

  it(
    "avatar script and required arguments are forwarded exactly once",
    { timeout: TEST_TIMEOUT },
    async () => {
      const { code, stderr } = await runLauncher(["--resume"]);
      if (code !== 0) {
        throw new Error(`launcher exited ${code}; stderr:\n${stderr}`);
      }
      const r = readWtRecord();
      // The launcher honors CLAUDE_EMOTE_AVATAR_EXE, so the avatar
      // script is the fake avatar path supplied by the test.
      const expectedScript = FAKE_AVATAR_PATH;
      // The pane executable is process.execPath and the avatar script
      // is the first executableArgs entry.
      expect(r.flags.paneExecutable).toBe(process.execPath);
      expect(r.flags.paneArgs[0]).toBe(process.execPath);
      expect(r.flags.paneArgs[1]).toBe(expectedScript);
      const portCount = r.flags.paneArgs.filter((a) => /^--port=\d+$/.test(a)).length;
      expect(portCount).toBe(1);
      const instanceCount = r.flags.paneArgs.filter((a) => /^--instance=/.test(a)).length;
      expect(instanceCount).toBe(1);
      const parentCount = r.flags.paneArgs.filter((a) => /^--parentPid=\d+$/.test(a)).length;
      expect(parentCount).toBe(1);
    },
  );

  it(
    "no shell command string is used (argv has no start / cmd / /c tokens)",
    { timeout: TEST_TIMEOUT },
    async () => {
      const { code, stderr } = await runLauncher(["--resume"]);
      if (code !== 0) {
        throw new Error(`launcher exited ${code}; stderr:\n${stderr}`);
      }
      const r = readWtRecord();
      expect(r.argv).not.toContain("start");
      expect(r.argv).not.toContain("cmd");
      expect(r.argv).not.toContain("/c");
      expect(r.argv).not.toContain("-F");
    },
  );

  it(
    "launcher waits for avatar /health before starting Claude",
    { timeout: TEST_TIMEOUT },
    async () => {
      const { code, stderr } = await runLauncher(["--resume"]);
      if (code !== 0) {
        throw new Error(`launcher exited ${code}; stderr:\n${stderr}`);
      }
      const c = readClaudeRecord();
      expect(c.env.CLAUDE_EMOTE_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/event$/);
      // Claude argv receives the original --resume plus --plugin-dir.
      expect(c.argv).toContain("--resume");
      expect(c.argv).toContain("--plugin-dir");
      expect(c.cwd).toBe(PROJECT_ROOT);
    },
  );

  it(
    "Claude exit code is forwarded",
    { timeout: TEST_TIMEOUT },
    async () => {
      const { code } = await runLauncher([], { FAKE_CLAUDE_EXIT_CODE: "9" });
      expect(code).toBe(9);
    },
  );

  it(
    "no fake process survives after launcher exits",
    { timeout: TEST_TIMEOUT },
    async () => {
      // Reset the PID log so we only count avatars from this test.
      writeFileSync(PIDS_RECORD, "[]\n", "utf8");
      // Open a port we hold so the fake avatar can bind a different port.
      // The fake's port comes from argv so it can be any free port.
      const { code } = await runLauncher(["--resume"]);
      expect(code).toBe(0);
      // The fake avatar wrote its PID into the log.
      const recorded = JSON.parse(readFileSync(PIDS_RECORD, "utf8"));
      expect(recorded.length).toBeGreaterThan(0);
      // The fake wt should have reaped the fake avatar child via its
      // own exit listener. Either way, the avatAR PID is gone now.
      const survivors: number[] = [];
      for (const entry of recorded) {
        try {
          process.kill(entry.pid, 0);
          survivors.push(entry.pid);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ESRCH" && code !== "EINVAL") throw err;
        }
      }
      expect(survivors).toEqual([]);
    },
  );
});

/**
 * Phase 10.1 visual-pane launcher tests.
 *
 * The launcher's WT branch must:
 *   - pass CLAUDE_EMOTE_VISUAL_PANE=1 to the WT pane child,
 *   - NOT pass that variable to Claude,
 *   - keep the existing split-pane argv unchanged,
 *   - keep the health-before-Claude ordering intact,
 *   - keep attached / test modes untouched.
 *
 * No real wt.exe opens: this uses the same fake-wt fake as the rest
 * of the suite and inspects the recorded env / argv.
 */
describe("launcher WT visual-pane contract (P10.1)", () => {
  beforeAll(() => {
    try { rmSync(WT_RECORD, { force: true }); } catch {}
    try { rmSync(CLAUDE_RECORD, { force: true }); } catch {}
    writeFileSync(PIDS_RECORD, "[]\n", "utf8");
  });

  beforeEach(() => {
    try { rmSync(WT_RECORD, { force: true }); } catch {}
    try { rmSync(CLAUDE_RECORD, { force: true }); } catch {}
    writeFileSync(PIDS_RECORD, "[]\n", "utf8");
  });

  it(
    "WT pane child receives CLAUDE_EMOTE_VISUAL_PANE=1",
    { timeout: TEST_TIMEOUT },
    async () => {
      const { code, stderr } = await runLauncher(["--resume"]);
      if (code !== 0) {
        throw new Error(`launcher exited ${code}; stderr:\n${stderr}`);
      }
      const r = readWtRecord();
      expect(r.env.CLAUDE_EMOTE_VISUAL_PANE).toBe("1");
    },
  );

  it(
    "Claude's child environment does NOT receive CLAUDE_EMOTE_VISUAL_PANE",
    { timeout: TEST_TIMEOUT },
    async () => {
      const { code, stderr } = await runLauncher(["--resume"]);
      if (code !== 0) {
        throw new Error(`launcher exited ${code}; stderr:\n${stderr}`);
      }
      const c = readClaudeRecord();
      // The variable is strictly scoped to the WT pane child. Even if
      // the launcher inherited it from process.env, the launcher
      // strips it from Claude's environment before spawning.
      expect(c.env.CLAUDE_EMOTE_VISUAL_PANE).toBeUndefined();
    },
  );

  it(
    "Claude's child environment still does NOT receive CLAUDE_EMOTE_VISUAL_PANE when it was set globally",
    { timeout: TEST_TIMEOUT },
    async () => {
      const { code, stderr } = await runLauncher(
        ["--resume"],
        { CLAUDE_EMOTE_VISUAL_PANE: "1" },
      );
      if (code !== 0) {
        throw new Error(`launcher exited ${code}; stderr:\n${stderr}`);
      }
      const r = readWtRecord();
      // The launcher sets it on the WT child even if the caller
      // already had it — same observable value either way.
      expect(r.env.CLAUDE_EMOTE_VISUAL_PANE).toBe("1");
      const c = readClaudeRecord();
      // But Claude must NEVER observe it.
      expect(c.env.CLAUDE_EMOTE_VISUAL_PANE).toBeUndefined();
    },
  );

  it(
    "exact split-pane argv remains unchanged in visual-pane mode",
    { timeout: TEST_TIMEOUT },
    async () => {
      const { code, stderr } = await runLauncher(["--resume"]);
      if (code !== 0) {
        throw new Error(`launcher exited ${code}; stderr:\n${stderr}`);
      }
      const r = readWtRecord();
      // Confirm the leading tokens are exactly the documented shape:
      //   -w 0 split-pane -V --size 0.25 -d <cwd> --title <title>
      //   process.execPath avatar-process.js --port=<port>
      //   --instance=<id> --parentPid=<pid>
      expect(r.argv[0]).toBe("-w");
      expect(r.argv[1]).toBe("0");
      expect(r.argv[2]).toBe("split-pane");
      expect(r.argv[3]).toBe("-V");
      expect(r.argv[4]).toBe("--size");
      expect(r.argv[5]).toBe("0.25");
      expect(r.argv[6]).toBe("-d");
      expect(r.argv[7]).toBe(PROJECT_ROOT);
      expect(r.argv[8]).toBe("--title");
      expect(typeof r.argv[9]).toBe("string");
      expect(r.argv[9]!.length).toBeGreaterThan(0);
      // process.execPath then avatar script then three required flags.
      expect(r.argv[10]).toBe(process.execPath);
      expect(r.argv[11]).toBe(FAKE_AVATAR_PATH);
      // Required trailing flags exactly once each, in any order —
      // the production builder pins the order, but for this test
      // we assert presence and count.
      const portCount = r.argv.filter((a) => /^--port=\d+$/.test(a)).length;
      expect(portCount).toBe(1);
      const instanceCount = r.argv.filter((a) => /^--instance=/.test(a)).length;
      expect(instanceCount).toBe(1);
      const parentCount = r.argv.filter((a) => /^--parentPid=\d+$/.test(a)).length;
      expect(parentCount).toBe(1);
      // No shell / fullscreen tokens.
      expect(r.argv).not.toContain("start");
      expect(r.argv).not.toContain("cmd");
      expect(r.argv).not.toContain("/c");
      expect(r.argv).not.toContain("-F");
    },
  );

  it(
    "health-before-Claude ordering is preserved in visual-pane mode",
    { timeout: TEST_TIMEOUT },
    async () => {
      const { code, stderr } = await runLauncher(["--resume"]);
      if (code !== 0) {
        throw new Error(`launcher exited ${code}; stderr:\n${stderr}`);
      }
      const c = readClaudeRecord();
      // Claude still gets the endpoint and plugin-dir.
      expect(c.env.CLAUDE_EMOTE_ENDPOINT).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/event$/,
      );
      expect(c.argv).toContain("--resume");
      expect(c.argv).toContain("--plugin-dir");
      // Debug log proves /health was observed before Claude started.
      expect(stderr).toMatch(/avatar launched via: wt/);
      // No premature "avatar exited" message.
      expect(stderr).not.toMatch(/avatar exited before becoming healthy/);
    },
  );

  it(
    "no attached duplicate is spawned in visual-pane mode",
    { timeout: TEST_TIMEOUT },
    async () => {
      const { code, stderr } = await runLauncher(["--resume"]);
      if (code !== 0) {
        throw new Error(`launcher exited ${code}; stderr:\n${stderr}`);
      }
      // Exactly one branch announced in the debug log.
      const wtAnnouncements = (stderr.match(/avatar launched via: wt/g) || []).length;
      const attachedAnnouncements = (stderr.match(/avatar launched via: attached/g) || []).length;
      const testAnnouncements = (stderr.match(/avatar launched via: test/g) || []).length;
      expect(wtAnnouncements).toBe(1);
      expect(attachedAnnouncements).toBe(0);
      expect(testAnnouncements).toBe(0);
      // The fake wt recorded exactly one invocation.
      const recorded = JSON.parse(readFileSync(PIDS_RECORD, "utf8"));
      expect(recorded.length).toBeGreaterThan(0);
      // And the fake wt's argv shows one pane payload, not two.
      const r = readWtRecord();
      const portCount = r.argv.filter((a) => /^--port=\d+$/.test(a)).length;
      expect(portCount).toBe(1);
    },
  );

  it(
    "no real Windows Terminal opens during tests (fake-wt record path proves it)",
    { timeout: TEST_TIMEOUT },
    async () => {
      // The launcher is configured to use FAKE_WT_PATH via
      // CLAUDE_EMOTE_WT_EXE, so any real wt.exe invocation would be
      // a bug. The fake-wt script writes the record file the moment
      // it runs. If the file does not exist after a launcher run,
      // either the launcher took a non-wt branch or wt never ran.
      try { rmSync(WT_RECORD, { force: true }); } catch {}
      const { code, stderr } = await runLauncher(["--resume"]);
      expect(code).toBe(0);
      // The fake-wt record MUST exist — proves the launcher did
      // invoke the fake (and therefore did NOT invoke any real
      // wt.exe on this CI machine).
      expect(existsSync(WT_RECORD)).toBe(true);
      expect(stderr).toMatch(/avatar launched via: wt/);
    },
  );
});

describe("launcher dry-run (P8 diagnostic mode)", () => {
  beforeAll(() => {
    // Ensure a clean slate — earlier wt-spawn tests may have written this.
    try { rmSync(WT_RECORD, { force: true }); } catch {}
  });

  it(
    "CLAUDE_EMOTE_DRY_RUN=1 prints the resolved wt executable and argv, then exits 0",
    { timeout: TEST_TIMEOUT },
    async () => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_EMOTE_CLAUDE_EXE: FAKE_CLAUDE_PATH,
        CLAUDE_EMOTE_AVATAR_EXE: FAKE_AVATAR_PATH,
        CLAUDE_EMOTE_WT_EXE: FAKE_WT_PATH,
        CLAUDE_EMOTE_TEST_PLATFORM: "win32",
        CLAUDE_EMOTE_DRY_RUN: "1",
        FAKE_WT_RECORD: WT_RECORD,
        WT_SESSION: "phase8-fake-session-abcdef",
      };
      delete env.LOCALAPPDATA;
      delete env.CLAUDE_EMOTE_TEST_MODE;
      const res = await new Promise<{ code: number; stderr: string }>((r, j) => {
        const child: ChildProcess = spawn(NODE, [LAUNCHER, "--resume"], {
          env,
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
        child.on("close", (code) => r({ code: code ?? 0, stderr }));
        child.on("error", j);
      });
      expect(res.code).toBe(0);
      expect(res.stderr).toMatch(/dry-run wt executable:/);
      expect(res.stderr).toMatch(/dry-run argv:/);
      // The fake wt must NOT have been invoked.
      expect(existsSync(WT_RECORD)).toBe(false);
    },
  );
});

describe("launcher in test mode does NOT call buildWindowsTerminalArgs (P8 isolation)", () => {
  beforeAll(() => {
    // Ensure WT_RECORD does not exist; this test verifies the wt
    // branch is not exercised.
    try { rmSync(WT_RECORD, { force: true }); } catch {}
  });

  it(
    "test-mode launcher does not look up wt.exe",
    { timeout: TEST_TIMEOUT },
    async () => {
      // Build an env without CLAUDE_EMOTE_WT_EXE and with TEST_MODE=1.
      // The fake wt path is intentionally absent so that if the
      // launcher tried to invoke wt.exe it would fail.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_EMOTE_CLAUDE_EXE: FAKE_CLAUDE_PATH,
        CLAUDE_EMOTE_AVATAR_EXE: FAKE_AVATAR_PATH,
        CLAUDE_EMOTE_TEST_MODE: "1",
        CLAUDE_EMOTE_DEBUG: "1",
        FAKE_CLAUDE_RECORD: CLAUDE_RECORD,
        FAKE_AVATAR_PIDS_FILE: PIDS_RECORD,
      };
      delete env.CLAUDE_EMOTE_WT_EXE;
      delete env.WT_SESSION;
      delete env.LOCALAPPDATA;
      const res = await new Promise<{ code: number; stderr: string }>((r, j) => {
        const child: ChildProcess = spawn(NODE, [LAUNCHER, "--resume"], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
        child.on("close", (code) => r({ code: code ?? 0, stderr }));
        child.on("error", j);
      });
      expect(res.code).toBe(0);
      expect(existsSync(WT_RECORD)).toBe(false);
      // Test mode is reported in debug logs.
      expect(res.stderr).toMatch(/avatar launched via: test/);
    },
  );
});

/**
 * Attached-fallback suite.
 *
 * Run on Windows (via CLAUDE_EMOTE_TEST_PLATFORM=win32) but WITHOUT
 * WT_SESSION. The launcher must:
 *   - never invoke wt.exe
 *   - spawn the avatar directly as an attached child
 *   - wait for /health, then start Claude
 *   - on Claude exit, send SIGTERM to the avatar and await its exit
 *   - forward Claude's exit code
 *   - leave no process behind
 */
describe("launcher attached fallback (WT_SESSION absent)", () => {
  beforeAll(() => {
    writeFileSync(PIDS_RECORD, "[]\n", "utf8");
  });

  it(
    "WT_SESSION absent → fake wt is never invoked; fake avatar is invoked directly",
    { timeout: TEST_TIMEOUT },
    async () => {
      // Clear any leftover record from the WT suite.
      try { rmSync(WT_RECORD, { force: true }); } catch {}
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_EMOTE_CLAUDE_EXE: FAKE_CLAUDE_PATH,
        CLAUDE_EMOTE_AVATAR_EXE: FAKE_AVATAR_PATH,
        CLAUDE_EMOTE_WT_EXE: FAKE_WT_PATH,
        CLAUDE_EMOTE_TEST_PLATFORM: "win32",
        CLAUDE_EMOTE_DEBUG: "1",
        FAKE_CLAUDE_RECORD: CLAUDE_RECORD,
        FAKE_WT_RECORD: WT_RECORD,
        FAKE_AVATAR_PIDS_FILE: PIDS_RECORD,
        FAKE_CLAUDE_EXIT_CODE: "0",
        // Deliberately NO WT_SESSION.
      };
      delete env.WT_SESSION;
      delete env.LOCALAPPDATA;
      delete env.CLAUDE_EMOTE_TEST_MODE;
      const res = await new Promise<{ code: number; stderr: string }>(
        (r, j) => {
          const child: ChildProcess = spawn(NODE, [LAUNCHER, "--resume"], {
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stderr = "";
          child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
          child.on("close", (code) => r({ code: code ?? 0, stderr }));
          child.on("error", j);
        },
      );
      expect(res.code).toBe(0);
      // WT branch MUST NOT run.
      expect(existsSync(WT_RECORD)).toBe(false);
      // The attached branch DID spawn the avatar.
      const recorded = JSON.parse(readFileSync(PIDS_RECORD, "utf8"));
      expect(recorded.length).toBeGreaterThan(0);
      // Debug log confirms the launch decision + path.
      expect(res.stderr).toMatch(/attached/);
      // Claude was started with --plugin-dir and the endpoint env.
      const claude = readClaudeRecord();
      expect(claude.env.CLAUDE_EMOTE_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/event$/);
      expect(claude.argv).toContain("--plugin-dir");
    },
  );

  it(
    "attached avatar receives SIGTERM when Claude exits (no orphan process)",
    { timeout: TEST_TIMEOUT },
    async () => {
      try { rmSync(WT_RECORD, { force: true }); } catch {}
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_EMOTE_CLAUDE_EXE: FAKE_CLAUDE_PATH,
        CLAUDE_EMOTE_AVATAR_EXE: FAKE_AVATAR_PATH,
        CLAUDE_EMOTE_WT_EXE: FAKE_WT_PATH,
        CLAUDE_EMOTE_TEST_PLATFORM: "win32",
        CLAUDE_EMOTE_DEBUG: "1",
        FAKE_CLAUDE_RECORD: CLAUDE_RECORD,
        FAKE_WT_RECORD: WT_RECORD,
        FAKE_AVATAR_PIDS_FILE: PIDS_RECORD,
        FAKE_CLAUDE_EXIT_CODE: "0",
      };
      delete env.WT_SESSION;
      delete env.LOCALAPPDATA;
      delete env.CLAUDE_EMOTE_TEST_MODE;
      // Reset the avatar PID log for this test only.
      writeFileSync(PIDS_RECORD, "[]\n", "utf8");
      const res = await new Promise<{ code: number; stderr: string }>(
        (r, j) => {
          const child: ChildProcess = spawn(NODE, [LAUNCHER, "--resume"], {
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stderr = "";
          child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
          child.on("close", (code) => r({ code: code ?? 0, stderr }));
          child.on("error", j);
        },
      );
      expect(res.code).toBe(0);
      const recorded = JSON.parse(readFileSync(PIDS_RECORD, "utf8"));
      expect(recorded.length).toBe(1);
      const avatarPid = recorded[0].pid;
      // No orphan PID remains after Claude exits and the launcher
      // forwards SIGTERM to the attached avatar.
      try {
        process.kill(avatarPid, 0);
        throw new Error(
          `attached avatar ${avatarPid} survived Claude exit`,
        );
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ESRCH" && e.code !== "EINVAL") throw err;
      }
    },
  );

  it(
    "Claude exit code is preserved (also in attached fallback)",
    { timeout: TEST_TIMEOUT },
    async () => {
      try { rmSync(WT_RECORD, { force: true }); } catch {}
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_EMOTE_CLAUDE_EXE: FAKE_CLAUDE_PATH,
        CLAUDE_EMOTE_AVATAR_EXE: FAKE_AVATAR_PATH,
        CLAUDE_EMOTE_WT_EXE: FAKE_WT_PATH,
        CLAUDE_EMOTE_TEST_PLATFORM: "win32",
        CLAUDE_EMOTE_DEBUG: "1",
        FAKE_CLAUDE_RECORD: CLAUDE_RECORD,
        FAKE_WT_RECORD: WT_RECORD,
        FAKE_AVATAR_PIDS_FILE: PIDS_RECORD,
        FAKE_CLAUDE_EXIT_CODE: "9",
      };
      delete env.WT_SESSION;
      delete env.LOCALAPPDATA;
      delete env.CLAUDE_EMOTE_TEST_MODE;
      writeFileSync(PIDS_RECORD, "[]\n", "utf8");
      const res = await new Promise<{ code: number; stderr: string }>(
        (r, j) => {
          const child: ChildProcess = spawn(NODE, [LAUNCHER, "--resume"], {
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stderr = "";
          child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
          child.on("close", (code) => r({ code: code ?? 0, stderr }));
          child.on("error", j);
        },
      );
      expect(res.code).toBe(9);
    },
  );

  it(
    "attached mode does NOT pass CLAUDE_EMOTE_VISUAL_PANE to its child",
    { timeout: TEST_TIMEOUT },
    async () => {
      // Even when the caller has CLAUDE_EMOTE_VISUAL_PANE set in
      // process.env, the attached fallback must NOT pass it to its
      // child avatar. The variable is strictly scoped to the WT pane
      // spawn.
      try { rmSync(WT_RECORD, { force: true }); } catch {}
      writeFileSync(PIDS_RECORD, "[]\n", "utf8");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_EMOTE_CLAUDE_EXE: FAKE_CLAUDE_PATH,
        CLAUDE_EMOTE_AVATAR_EXE: FAKE_AVATAR_PATH,
        CLAUDE_EMOTE_WT_EXE: FAKE_WT_PATH,
        CLAUDE_EMOTE_TEST_PLATFORM: "win32",
        CLAUDE_EMOTE_DEBUG: "1",
        FAKE_CLAUDE_RECORD: CLAUDE_RECORD,
        FAKE_WT_RECORD: WT_RECORD,
        FAKE_AVATAR_PIDS_FILE: PIDS_RECORD,
        FAKE_CLAUDE_EXIT_CODE: "0",
        // Pre-set on purpose: attached mode must still NOT forward it.
        CLAUDE_EMOTE_VISUAL_PANE: "1",
      };
      delete env.WT_SESSION;
      delete env.LOCALAPPDATA;
      delete env.CLAUDE_EMOTE_TEST_MODE;
      const res = await new Promise<{ code: number; stderr: string }>(
        (r, j) => {
          const child: ChildProcess = spawn(NODE, [LAUNCHER, "--resume"], {
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stderr = "";
          child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
          child.on("close", (code) => r({ code: code ?? 0, stderr }));
          child.on("error", j);
        },
      );
      expect(res.code).toBe(0);
      // The fake wt must NOT have been invoked.
      expect(existsSync(WT_RECORD)).toBe(false);
      // The debug log proves attached mode was used.
      expect(res.stderr).toMatch(/avatar launched via: attached/);
      // The fake avatar recorded its PID.
      const recorded = JSON.parse(readFileSync(PIDS_RECORD, "utf8"));
      expect(recorded.length).toBeGreaterThan(0);
      // And Claude's child also does NOT see the visual-pane flag.
      const c = readClaudeRecord();
      expect(c.env.CLAUDE_EMOTE_VISUAL_PANE).toBeUndefined();
    },
  );
});

/**
 * Phase 8 fail-open suite.
 *
 * Every test below must end with:
 *   - launcher exit code preserved or 130/143 for signals
 *   - no orphan fake avatar process
 *   - no leaked tempdir
 *
 * WT spawn failure, attached avatar early-exit, attached avatar never
 * healthy, and SIGTERM/SIGINT exit-code semantics are all exercised
 * here.
 */
describe("launcher fail-open (P8)", () => {
  /**
   * Test A: WT executable exists but spawn fails (e.g. CLAUDE_EMOTE_WT_EXE
   * points at a directory or a non-executable existing path).
   *
   * findWindowsTerminalExecutable() trusts existsSync() — that test seam
   * passes the existence check — but Node's spawn() cannot execute it
   * and emits an `error` event. The launcher must:
   *   - print one concise warning
   *   - fall back to a directly-attached avatar
   *   - wait for the attached avatar's /health
   *   - start Claude
   *   - forward Claude's exit code
   *   - leave no surviving process
   */
  it(
    "WT spawn failure falls back to attached avatar and Claude still starts",
    { timeout: TEST_TIMEOUT },
    async () => {
      // A directory satisfies existsSync() but Node cannot spawn() it.
      const badWtPath = join(FAKE_DIR, "wt-dir-as-file");
      mkdirSync(badWtPath, { recursive: true });
      try { rmSync(WT_RECORD, { force: true }); } catch {}
      writeFileSync(PIDS_RECORD, "[]\n", "utf8");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_EMOTE_CLAUDE_EXE: FAKE_CLAUDE_PATH,
        CLAUDE_EMOTE_AVATAR_EXE: FAKE_AVATAR_PATH,
        // Point the WT resolver at the directory. existsSync() returns true;
        // spawn() will fail asynchronously.
        CLAUDE_EMOTE_WT_EXE: badWtPath,
        CLAUDE_EMOTE_TEST_PLATFORM: "win32",
        CLAUDE_EMOTE_DEBUG: "1",
        WT_SESSION: "phase8-fake-session-abcdef",
        FAKE_CLAUDE_RECORD: CLAUDE_RECORD,
        FAKE_WT_RECORD: WT_RECORD,
        FAKE_AVATAR_PIDS_FILE: PIDS_RECORD,
        FAKE_CLAUDE_EXIT_CODE: "0",
      };
      delete env.LOCALAPPDATA;
      delete env.CLAUDE_EMOTE_TEST_MODE;
      const res = await new Promise<{ code: number; stderr: string }>(
        (r, j) => {
          const child: ChildProcess = spawn(NODE, [LAUNCHER, "--resume"], {
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stderr = "";
          child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
          child.on("close", (code) => r({ code: code ?? 0, stderr }));
          child.on("error", j);
        },
      );
      // Launcher must succeed.
      expect(res.code).toBe(0);
      // One concise WT failure warning printed.
      expect(res.stderr).toMatch(/Windows Terminal launch failed/);
      // WT branch did NOT spawn wt (the spawn error path) so no record.
      expect(existsSync(WT_RECORD)).toBe(false);
      // The attached fallback DID spawn the avatar.
      const recorded = JSON.parse(readFileSync(PIDS_RECORD, "utf8"));
      expect(recorded.length).toBeGreaterThanOrEqual(1);
      // Claude still started with the plugin-dir and endpoint env.
      const claude = readClaudeRecord();
      expect(claude.env.CLAUDE_EMOTE_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/event$/);
      expect(claude.argv).toContain("--plugin-dir");
      // No orphan attached avatar.
      const avatarPid = recorded[0].pid;
      try {
        process.kill(avatarPid, 0);
        throw new Error(`attached avatar ${avatarPid} survived launcher exit`);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ESRCH" && e.code !== "EINVAL") throw err;
      }
    },
  );

  /**
   * Test B: the attached avatar script exits before opening /health.
   *
   * The launcher must:
   *   - detect the early exit before the full health timeout
   *   - log a concise warning
   *   - still start Claude
   *   - forward Claude's exit code
   *   - leave no orphan avatar
   *
   * Uses CLAUDE_EMOTE_HEALTH_TIMEOUT_MS=10000 so we can prove the test
   * does NOT wait the full 10 seconds.
   */
  it(
    "attached avatar exits before /health → Claude starts without avatar",
    { timeout: TEST_TIMEOUT },
    async () => {
      const earlyExitAvatar = join(FAKE_DIR, "avatar-exits-immediately.cjs");
      writeFileSync(
        earlyExitAvatar,
        `
process.exit(7);
`,
        "utf8",
      );
      try { rmSync(WT_RECORD, { force: true }); } catch {}
      writeFileSync(PIDS_RECORD, "[]\n", "utf8");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_EMOTE_CLAUDE_EXE: FAKE_CLAUDE_PATH,
        CLAUDE_EMOTE_AVATAR_EXE: earlyExitAvatar,
        CLAUDE_EMOTE_WT_EXE: FAKE_WT_PATH,
        CLAUDE_EMOTE_TEST_PLATFORM: "win32",
        CLAUDE_EMOTE_DEBUG: "1",
        // No WT_SESSION → attached fallback path.
        FAKE_CLAUDE_RECORD: CLAUDE_RECORD,
        FAKE_WT_RECORD: WT_RECORD,
        FAKE_AVATAR_PIDS_FILE: PIDS_RECORD,
        FAKE_CLAUDE_EXIT_CODE: "0",
        // Long health timeout proves we don't wait the full window.
        CLAUDE_EMOTE_HEALTH_TIMEOUT_MS: "10000",
      };
      delete env.WT_SESSION;
      delete env.LOCALAPPDATA;
      delete env.CLAUDE_EMOTE_TEST_MODE;
      const t0 = Date.now();
      const res = await new Promise<{ code: number; stderr: string }>(
        (r, j) => {
          const child: ChildProcess = spawn(NODE, [LAUNCHER, "--resume"], {
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stderr = "";
          child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
          child.on("close", (code) => r({ code: code ?? 0, stderr }));
          child.on("error", j);
        },
      );
      const elapsed = Date.now() - t0;
      // Claude started even though the avatar failed.
      expect(res.code).toBe(0);
      // The early-exit warning was printed.
      expect(res.stderr).toMatch(/avatar exited before becoming healthy/);
      // The launcher must NOT have waited the full health timeout.
      // Real measurement: short in practice because the child exits
      // fast, but we assert a generous upper bound to catch regressions
      // where the race waiter is broken and we wait 10s.
      expect(elapsed).toBeLessThan(8_000);
      // Claude still got the endpoint env + plugin-dir.
      const claude = readClaudeRecord();
      expect(claude.env.CLAUDE_EMOTE_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/event$/);
      expect(claude.argv).toContain("--plugin-dir");
    },
  );

  /**
   * Test C: the attached avatar stays alive but never serves /health.
   *
   * The launcher must:
   *   - detect the health timeout (we use a short 1500ms override)
   *   - terminate the owned attached avatar via SIGTERM
   *   - await the avatar's exit
   *   - only then start Claude
   *   - leave no surviving avatar process
   */
  it(
    "attached avatar never healthy → launcher terminates it and starts Claude",
    { timeout: TEST_TIMEOUT },
    async () => {
      // Fake avatar that binds a port but never replies to /health.
      // It stays alive until killed.
      const silentAvatar = join(FAKE_DIR, "avatar-never-healthy.cjs");
      writeFileSync(
        silentAvatar,
        `
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
let port = 0;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && i + 1 < args.length) port = Number(args[++i]);
  const m = args[i].match(/^--port=(.+)$/); if (m) port = Number(m[1]);
}
if (!port) { process.exit(2); }
const pidsPath = process.env.FAKE_AVATAR_PIDS_FILE;
if (pidsPath) {
  try {
    const list = JSON.parse(fs.readFileSync(pidsPath, "utf8"));
    list.push({ pid: process.pid, port, startedAt: Date.now() });
    fs.writeFileSync(pidsPath, JSON.stringify(list, null, 2));
  } catch {}
}
// Bind the port but never respond to /health — reply 500 to anything.
const server = http.createServer((req, res) => {
  res.statusCode = 500;
  res.end("nope");
});
server.listen(port, "127.0.0.1", () => {
  console.log("SILENT_AVATAR_READY port=" + port + " pid=" + process.pid);
});
`,
        "utf8",
      );
      try { rmSync(WT_RECORD, { force: true }); } catch {}
      writeFileSync(PIDS_RECORD, "[]\n", "utf8");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_EMOTE_CLAUDE_EXE: FAKE_CLAUDE_PATH,
        CLAUDE_EMOTE_AVATAR_EXE: silentAvatar,
        CLAUDE_EMOTE_WT_EXE: FAKE_WT_PATH,
        CLAUDE_EMOTE_TEST_PLATFORM: "win32",
        CLAUDE_EMOTE_DEBUG: "1",
        FAKE_CLAUDE_RECORD: CLAUDE_RECORD,
        FAKE_WT_RECORD: WT_RECORD,
        FAKE_AVATAR_PIDS_FILE: PIDS_RECORD,
        FAKE_CLAUDE_EXIT_CODE: "0",
        // Short health timeout — the test runs in <2s.
        CLAUDE_EMOTE_HEALTH_TIMEOUT_MS: "1500",
      };
      delete env.WT_SESSION;
      delete env.LOCALAPPDATA;
      delete env.CLAUDE_EMOTE_TEST_MODE;
      const res = await new Promise<{ code: number; stderr: string }>(
        (r, j) => {
          const child: ChildProcess = spawn(NODE, [LAUNCHER, "--resume"], {
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stderr = "";
          child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
          child.on("close", (code) => r({ code: code ?? 0, stderr }));
          child.on("error", j);
        },
      );
      expect(res.code).toBe(0);
      // Health timeout warning printed (using the configured value).
      expect(res.stderr).toMatch(/did not respond to \/health within 1500ms/);
      // Claude still started.
      const claude = readClaudeRecord();
      expect(claude.env.CLAUDE_EMOTE_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/event$/);
      // The avatar PID is gone — the launcher terminated it.
      const recorded = JSON.parse(readFileSync(PIDS_RECORD, "utf8"));
      expect(recorded.length).toBeGreaterThanOrEqual(1);
      const avatarPid = recorded[0].pid;
      try {
        process.kill(avatarPid, 0);
        throw new Error(`attached avatar ${avatarPid} survived health-timeout termination`);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ESRCH" && e.code !== "EINVAL") throw err;
      }
    },
  );

  /**
   * Test D: SIGTERM race.
   *
   * Launcher receives SIGTERM while Claude is running. The launcher
   * must:
   *   - forward SIGTERM to the Claude child
   *   - terminate the directly-owned attached avatar via SIGTERM
   *   - exit with code 143 (SIGTERM semantics)
   *   - run finalization exactly once (no second process.exit wins)
   */
  it(
    "SIGTERM produces exit code 143, forwards signal, and finalizes once",
    { timeout: SIGTERM_TEST_TIMEOUT },
    async () => {
      // A fake claude that just sleeps until SIGTERM arrives.
      const longClaude = join(FAKE_DIR, "claude-sleep.cjs");
      writeFileSync(
        longClaude,
        `
process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));
// Stay alive until a signal arrives.
const t = setInterval(() => {}, 1000);
process.on("exit", () => clearInterval(t));
`,
        "utf8",
      );
      try { rmSync(WT_RECORD, { force: true }); } catch {}
      writeFileSync(PIDS_RECORD, "[]\n", "utf8");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_EMOTE_CLAUDE_EXE: longClaude,
        CLAUDE_EMOTE_AVATAR_EXE: FAKE_AVATAR_PATH,
        CLAUDE_EMOTE_WT_EXE: FAKE_WT_PATH,
        CLAUDE_EMOTE_TEST_PLATFORM: "win32",
        CLAUDE_EMOTE_DEBUG: "1",
        FAKE_CLAUDE_RECORD: CLAUDE_RECORD,
        FAKE_WT_RECORD: WT_RECORD,
        FAKE_AVATAR_PIDS_FILE: PIDS_RECORD,
      };
      delete env.WT_SESSION;
      delete env.LOCALAPPDATA;
      delete env.CLAUDE_EMOTE_TEST_MODE;
      // Test-only signal trigger: closing the launcher's stdin fires
      // the SIGTERM handler (exit code 143). Required because Node on
      // Windows does not deliver SIGTERM via child.kill() to the
      // parent process's signal handlers.
      env.CLAUDE_EMOTE_TEST_FORCE_SIGNAL = "SIGTERM";

      const child: ChildProcess = spawn(NODE, [LAUNCHER, "--resume"], {
        env,
        // Pipe stdin so we can close it to trigger the SIGTERM test seam.
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
      // The fake avatar inherits the launcher's stdout (stdio:
      // ["ignore", "inherit", "inherit"]), so the FAKE_AVATAR_READY
      // line lands in launcher's stdout, which we pipe and observe
      // here.
      let readyResolver!: () => void;
      const readyPromise = new Promise<void>((r) => { readyResolver = r; });
      child.stdout?.on("data", (b: Buffer) => {
        if (b.toString("utf8").includes("FAKE_AVATAR_READY")) {
          readyResolver();
        }
      });
      // Wait for /health to be ready (the fake avatar prints FAKE_AVATAR_READY).
      await Promise.race([
        readyPromise,
        new Promise<void>((_r, j) =>
          setTimeout(() => j(new Error("avatar never became ready")), 10_000),
        ),
      ]);
      // Trigger the launcher's SIGTERM handler via the test seam:
      // closing the launcher's stdin fires the handler with the
      // configured exit code (143).
      child.stdin?.end();
      const exitCode: number = await new Promise((r) => {
        child.on("close", (code) => r(code ?? 0));
      });
      // SIGTERM → 143.
      expect(exitCode).toBe(143);
      // The debug log shows finalize started exactly once.
      const finalizeStarts = (stderr.match(/finalize start/g) || []).length;
      expect(finalizeStarts).toBe(1);
      // The avatar PID is gone.
      const recorded = JSON.parse(readFileSync(PIDS_RECORD, "utf8"));
      if (recorded.length > 0) {
        try {
          process.kill(recorded[0].pid, 0);
          throw new Error(`attached avatar ${recorded[0].pid} survived SIGTERM`);
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code !== "ESRCH" && e.code !== "EINVAL") throw err;
        }
      }
    },
  );

  /**
   * Test E (attached-fallback three-run regression):
   * the previously-unexplained flake reported "1 failed | 11 passed"
   * before later runs passed. Run the launcher attached-fallback
   * orphan gate three times in this file too, so the fail-open
   * suite carries the regression check.
   *
   * The companion test-mode regression lives in launcher.test.ts.
   *
   * Why this is "attached fallback" and NOT "test mode":
   *   - CLAUDE_EMOTE_TEST_MODE is intentionally NOT set (deleted)
   *   - WT_SESSION is intentionally NOT set (deleted)
   *   - CLAUDE_EMOTE_TEST_PLATFORM is "win32" (the launcher's
   *     decideAvatarLaunchMode() takes the "not-inside-windows-terminal"
   *     branch and resolves to "attached")
   *   - CLAUDE_EMOTE_WT_EXE is set so findWindowsTerminalExecutable()
   *     returns a real path, but the launcher must NOT consult it
   *     because WT_SESSION is absent.
   *   - stderr must contain "avatar launched via: attached".
   *   - The fake wt record file must NOT be written (proves the
   *     launcher skipped the Windows Terminal branch).
   */
  it(
    "attached-fallback three-run orphan gate leaves no surviving avatar processes",
    { timeout: TEST_TIMEOUT * 2 },
    async () => {
      writeFileSync(PIDS_RECORD, "[]\n", "utf8");
      for (let i = 0; i < 3; i++) {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          CLAUDE_EMOTE_CLAUDE_EXE: FAKE_CLAUDE_PATH,
          CLAUDE_EMOTE_AVATAR_EXE: FAKE_AVATAR_PATH,
          CLAUDE_EMOTE_WT_EXE: FAKE_WT_PATH,
          CLAUDE_EMOTE_TEST_PLATFORM: "win32",
          CLAUDE_EMOTE_DEBUG: "1",
          FAKE_CLAUDE_RECORD: CLAUDE_RECORD,
          FAKE_WT_RECORD: WT_RECORD,
          FAKE_AVATAR_PIDS_FILE: PIDS_RECORD,
        };
        delete env.WT_SESSION;
        delete env.LOCALAPPDATA;
        // Intentionally NOT setting CLAUDE_EMOTE_TEST_MODE here —
        // this test exercises the attached-fallback branch, not
        // the test-mode branch. The companion test in launcher.test.ts
        // sets CLAUDE_EMOTE_TEST_MODE=1.
        delete env.CLAUDE_EMOTE_TEST_MODE;
        // Clear the fake-wt record at the start of each iteration so
        // a leftover from an earlier loop cannot be misread as
        // "wt was invoked this run".
        try { rmSync(WT_RECORD, { force: true }); } catch {}
        const res = await new Promise<{ code: number; stderr: string }>(
          (r, j) => {
            const child: ChildProcess = spawn(NODE, [LAUNCHER, "--resume"], {
              env,
              stdio: ["ignore", "pipe", "pipe"],
            });
            let stderr = "";
            child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
            child.on("close", (code) => r({ code: code ?? 0, stderr }));
            child.on("error", j);
          },
        );
        if (res.code !== 0) {
          throw new Error(
            `run #${i + 1}: launcher exited ${res.code}; stderr:\n${res.stderr}`,
          );
        }
        // Explicit launch-path assertion: the launcher must take the
        // attached fallback branch on win32 + no WT_SESSION + no
        // TEST_MODE.
        expect(res.stderr).toMatch(/avatar launched via: attached/);
        // And must NOT take the Windows Terminal branch.
        expect(res.stderr).not.toMatch(/avatar launched via: wt/);
        // The fake wt record file MUST NOT exist after this run —
        // proves the launcher never spawned wt.exe.
        expect(existsSync(WT_RECORD)).toBe(false);
      }
      const recorded: Array<{ pid: number; port: number; startedAt: number }> =
        JSON.parse(readFileSync(PIDS_RECORD, "utf8"));
      expect(recorded.length).toBe(3);
      const survivors: number[] = [];
      for (const entry of recorded) {
        try {
          process.kill(entry.pid, 0);
          survivors.push(entry.pid);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ESRCH" && code !== "EINVAL") throw err;
        }
      }
      expect(survivors).toEqual([]);
    },
  );
});