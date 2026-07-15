/**
 * avatar-args.test.ts (P4 correctness repair)
 *
 * The parser exposes exactly one public function:
 *
 *   parseAvatarProcessOptions(argv, env): AvatarProcessOptions
 *
 * Each field has three states: not supplied / valid supplied / invalid
 * supplied. An invalid explicit CLI value throws BEFORE environment
 * fallback. An invalid environment value throws rather than silently
 * becoming a default. Exact defaults:
 *
 *   port       = 0
 *   instanceId = "standalone"
 *   parentPid  = null
 *   emoteDir   = `${cwd}/emotes/ascii`
 */

import { describe, it, expect } from "vitest";
import {
  parseAvatarProcessOptions,
  AvatarParseError,
} from "../../src/host/avatar-args.js";

const EMPTY_ENV: NodeJS.ProcessEnv = {};
const cwd = process.cwd();

describe("parseAvatarProcessOptions (P4)", () => {
  describe("--flag=value and --flag value forms", () => {
    it("parses --port=1234", () => {
      expect(parseAvatarProcessOptions(["--port=1234"], EMPTY_ENV).port).toBe(
        1234,
      );
    });
    it("parses --port 1234", () => {
      expect(parseAvatarProcessOptions(["--port", "1234"], EMPTY_ENV).port).toBe(
        1234,
      );
    });
    it("parses --instance=abc", () => {
      expect(
        parseAvatarProcessOptions(["--instance=abc"], EMPTY_ENV).instanceId,
      ).toBe("abc");
    });
    it("parses --instance abc", () => {
      expect(
        parseAvatarProcessOptions(["--instance", "abc"], EMPTY_ENV).instanceId,
      ).toBe("abc");
    });
    it("parses --emoteDir=path and --emoteDir path", () => {
      const eq = parseAvatarProcessOptions(
        ["--emoteDir=D:/emotes"],
        EMPTY_ENV,
      ).emoteDir;
      const sp = parseAvatarProcessOptions(
        ["--emoteDir", "D:/emotes"],
        EMPTY_ENV,
      ).emoteDir;
      expect(eq).toBe("D:/emotes");
      expect(sp).toBe("D:/emotes");
    });
    it("parses --parentPid=999 and --parentPid 999", () => {
      expect(
        parseAvatarProcessOptions(["--parentPid=999"], EMPTY_ENV).parentPid,
      ).toBe(999);
      expect(
        parseAvatarProcessOptions(["--parentPid", "999"], EMPTY_ENV).parentPid,
      ).toBe(999);
    });
  });

  describe("documented defaults (no CLI, no env)", () => {
    it("port === 0", () => {
      expect(parseAvatarProcessOptions([], EMPTY_ENV).port).toBe(0);
    });
    it('instanceId === "standalone"', () => {
      expect(parseAvatarProcessOptions([], EMPTY_ENV).instanceId).toBe(
        "standalone",
      );
    });
    it("parentPid === null", () => {
      expect(parseAvatarProcessOptions([], EMPTY_ENV).parentPid).toBeNull();
    });
    it("emoteDir === `${cwd}/emotes/ascii`", () => {
      expect(parseAvatarProcessOptions([], EMPTY_ENV).emoteDir).toBe(
        `${cwd}/emotes/ascii`,
      );
    });
  });

  describe("CLI > env > default (valid values)", () => {
    it("CLI beats env for every field", () => {
      const opts = parseAvatarProcessOptions(
        [
          "--port=1234",
          "--instance=cli",
          "--emoteDir=D:/cli",
          "--parentPid=42",
        ],
        {
          CLAUDE_EMOTE_PORT: "8080",
          CLAUDE_EMOTE_INSTANCE_ID: "from-env",
          CLAUDE_EMOTE_EMOTE_DIR: "D:/env",
          CLAUDE_EMOTE_PARENT_PID: "99",
        },
      );
      expect(opts.port).toBe(1234);
      expect(opts.instanceId).toBe("cli");
      expect(opts.emoteDir).toBe("D:/cli");
      expect(opts.parentPid).toBe(42);
    });
    it("env beats default when CLI is absent", () => {
      const opts = parseAvatarProcessOptions([], {
        CLAUDE_EMOTE_PORT: "8080",
        CLAUDE_EMOTE_INSTANCE_ID: "from-env",
        CLAUDE_EMOTE_EMOTE_DIR: "D:/env",
        CLAUDE_EMOTE_PARENT_PID: "99",
      });
      expect(opts.port).toBe(8080);
      expect(opts.instanceId).toBe("from-env");
      expect(opts.emoteDir).toBe("D:/env");
      expect(opts.parentPid).toBe(99);
    });
    it("--port=0 is valid and triggers OS assignment", () => {
      const opts = parseAvatarProcessOptions(
        ["--port=0", "--instance=port-zero"],
        EMPTY_ENV,
      );
      expect(opts.port).toBe(0);
      expect(opts.instanceId).toBe("port-zero");
    });
  });

  describe("invalid explicit CLI throws BEFORE env fallback", () => {
    it("CLI --port=abc with env 8080 → throws", () => {
      expect(() =>
        parseAvatarProcessOptions(["--port=abc"], { CLAUDE_EMOTE_PORT: "8080" }),
      ).toThrow(/--port must be an integer/);
    });
    it("CLI --port=-1 with env 8080 → throws", () => {
      expect(() =>
        parseAvatarProcessOptions(["--port=-1"], { CLAUDE_EMOTE_PORT: "8080" }),
      ).toThrow(/--port must be in \[0, 65535\]/);
    });
    it("CLI --port=70000 with env 8080 → throws", () => {
      expect(() =>
        parseAvatarProcessOptions(["--port=70000"], {
          CLAUDE_EMOTE_PORT: "8080",
        }),
      ).toThrow(/--port must be in \[0, 65535\]/);
    });
    it("CLI --port (bare) with env 8080 → throws", () => {
      expect(() =>
        parseAvatarProcessOptions(["--port"], { CLAUDE_EMOTE_PORT: "8080" }),
      ).toThrow(/--port requires/);
    });
    it("CLI --port --instance=x with env 8080 → throws (port is missing its value)", () => {
      expect(() =>
        parseAvatarProcessOptions(
          ["--port", "--instance=x"],
          { CLAUDE_EMOTE_PORT: "8080" },
        ),
      ).toThrow(/--port requires/);
    });
    it("CLI --parentPid=abc with valid env PID → throws", () => {
      expect(() =>
        parseAvatarProcessOptions(["--parentPid=abc"], {
          CLAUDE_EMOTE_PARENT_PID: "99",
        }),
      ).toThrow(/--parentPid must be an integer/);
    });
    it("CLI --parentPid=0 with valid env PID → throws", () => {
      expect(() =>
        parseAvatarProcessOptions(["--parentPid=0"], {
          CLAUDE_EMOTE_PARENT_PID: "99",
        }),
      ).toThrow(/--parentPid must be a positive integer/);
    });
    it("CLI --parentPid=-5 with valid env PID → throws", () => {
      expect(() =>
        parseAvatarProcessOptions(["--parentPid=-5"], {
          CLAUDE_EMOTE_PARENT_PID: "99",
        }),
      ).toThrow(/--parentPid must be a positive integer/);
    });
    it('CLI --instance= (empty) with valid env instance → throws', () => {
      expect(() =>
        parseAvatarProcessOptions(["--instance="], {
          CLAUDE_EMOTE_INSTANCE_ID: "from-env",
        }),
      ).toThrow(/--instance requires a non-empty value/);
    });
    it("CLI --instance= (empty value, the form bash produces from --instance='') with valid env → throws", () => {
      // After bash strips the quotes from --instance="", the shell passes
      // `--instance=` (empty value). The parser must reject this.
      expect(() =>
        parseAvatarProcessOptions(["--instance="], {
          CLAUDE_EMOTE_INSTANCE_ID: "from-env",
        }),
      ).toThrow(/--instance requires a non-empty value/);
    });
    it("CLI --instance (bare) with valid env → throws", () => {
      expect(() =>
        parseAvatarProcessOptions(["--instance"], {
          CLAUDE_EMOTE_INSTANCE_ID: "from-env",
        }),
      ).toThrow(/--instance requires/);
    });
    it("CLI --emoteDir= (empty) with valid env path → throws", () => {
      expect(() =>
        parseAvatarProcessOptions(["--emoteDir="], {
          CLAUDE_EMOTE_EMOTE_DIR: "D:/env",
        }),
      ).toThrow(/--emoteDir requires a non-empty value/);
    });
  });

  describe("invalid env throws when CLI is absent", () => {
    it("CLAUDE_EMOTE_PORT=abc → throws", () => {
      expect(() =>
        parseAvatarProcessOptions([], { CLAUDE_EMOTE_PORT: "abc" }),
      ).toThrow(/CLAUDE_EMOTE_PORT must be an integer/);
    });
    it("CLAUDE_EMOTE_PORT=99999 → throws", () => {
      expect(() =>
        parseAvatarProcessOptions([], { CLAUDE_EMOTE_PORT: "99999" }),
      ).toThrow(/CLAUDE_EMOTE_PORT must be in \[0, 65535\]/);
    });
    it('CLAUDE_EMOTE_INSTANCE_ID="" → throws', () => {
      expect(() =>
        parseAvatarProcessOptions([], { CLAUDE_EMOTE_INSTANCE_ID: "" }),
      ).toThrow(/CLAUDE_EMOTE_INSTANCE_ID must not be empty/);
    });
    it("CLAUDE_EMOTE_PARENT_PID=abc → throws", () => {
      expect(() =>
        parseAvatarProcessOptions([], { CLAUDE_EMOTE_PARENT_PID: "abc" }),
      ).toThrow(/CLAUDE_EMOTE_PARENT_PID must be an integer/);
    });
    it("CLAUDE_EMOTE_PARENT_PID=-5 → throws", () => {
      expect(() =>
        parseAvatarProcessOptions([], { CLAUDE_EMOTE_PARENT_PID: "-5" }),
      ).toThrow(/CLAUDE_EMOTE_PARENT_PID must be a positive integer/);
    });
    it("CLAUDE_EMOTE_PARENT_PID=0 → throws", () => {
      expect(() =>
        parseAvatarProcessOptions([], { CLAUDE_EMOTE_PARENT_PID: "0" }),
      ).toThrow(/CLAUDE_EMOTE_PARENT_PID must be a positive integer/);
    });
    it("CLAUDE_EMOTE_EMOTE_DIR= (empty) → throws", () => {
      expect(() =>
        parseAvatarProcessOptions([], { CLAUDE_EMOTE_EMOTE_DIR: "" }),
      ).toThrow(/CLAUDE_EMOTE_EMOTE_DIR must not be empty/);
    });
  });

  describe("missing-value handling", () => {
    it("--port (bare, end of argv) → throws", () => {
      expect(() =>
        parseAvatarProcessOptions(["--port"], EMPTY_ENV),
      ).toThrow(/--port requires/);
    });
    it("--instance (bare, end of argv) → throws", () => {
      expect(() =>
        parseAvatarProcessOptions(["--instance"], EMPTY_ENV),
      ).toThrow(/--instance requires/);
    });
    it("--emoteDir (bare, end of argv) → throws", () => {
      expect(() =>
        parseAvatarProcessOptions(["--emoteDir"], EMPTY_ENV),
      ).toThrow(/--emoteDir requires/);
    });
    it("--parentPid (bare, end of argv) → throws", () => {
      expect(() =>
        parseAvatarProcessOptions(["--parentPid"], EMPTY_ENV),
      ).toThrow(/--parentPid requires/);
    });
    it("--port= (empty value) → throws", () => {
      expect(() =>
        parseAvatarProcessOptions(["--port="], EMPTY_ENV),
      ).toThrow(/--port requires/);
    });
    it("--instance= (empty value) → throws", () => {
      expect(() =>
        parseAvatarProcessOptions(["--instance="], EMPTY_ENV),
      ).toThrow(/--instance requires/);
    });
    it("--emoteDir= (empty value) → throws", () => {
      expect(() =>
        parseAvatarProcessOptions(["--emoteDir="], EMPTY_ENV),
      ).toThrow(/--emoteDir requires/);
    });
    it("--parentPid= (empty value) → throws", () => {
      expect(() =>
        parseAvatarProcessOptions(["--parentPid="], EMPTY_ENV),
      ).toThrow(/--parentPid requires/);
    });
  });

  describe("error type", () => {
    it("throws an AvatarParseError", () => {
      try {
        parseAvatarProcessOptions(["--port=abc"], EMPTY_ENV);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(AvatarParseError);
      }
    });
  });
});