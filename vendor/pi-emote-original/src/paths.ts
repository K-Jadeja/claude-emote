import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const DEFAULT_PROJECT_CONFIG_DIR = ".pi";

/**
 * Pi-owned global state should follow the running agent's configured data dir.
 * Pi defaults to ~/.pi/agent, but forks/wrappers can point PI_CODING_AGENT_DIR
 * at another tree such as ~/.emi/agent.
 */
export function getEmoteAgentDir(): string {
  if (process.env.PI_CODING_AGENT_DIR?.trim()) return getAgentDir();

  const command = normalizeCommandName(process.argv[1]);
  if (command === "emi") return join(homedir(), ".emi", "agent");
  if (command === "pi") return join(homedir(), ".pi", "agent");

  return getAgentDir();
}

export function getUserExtensionDir(): string {
  return join(getEmoteAgentDir(), "extensions", "pi-emote");
}

function normalizeCommandName(value: string | undefined): string | undefined {
  const name = basename(value ?? "").toLowerCase().replace(/\.(cmd|ps1|exe|js|mjs|cjs)$/i, "");
  return name || undefined;
}

function inferProjectConfigDirFromAgentDir(): string | undefined {
  const agentDir = getEmoteAgentDir();
  const agentLeaf = basename(agentDir);
  const parentLeaf = basename(dirname(agentDir));
  if (agentLeaf === "agent" && /^\.[A-Za-z0-9._-]+$/.test(parentLeaf)) {
    return parentLeaf;
  }
  return undefined;
}

function inferProjectConfigDirFromCommand(): string | undefined {
  const command = normalizeCommandName(process.argv[1]) ?? normalizeCommandName(process.env.npm_execpath);
  if (!command || command === "node") return undefined;
  return `.${command}`;
}

/**
 * Project-local overrides live beside the current project under the agent's
 * project config dir. For stock Pi this is .pi; for an Emi fork installed in
 * ~/.emi/agent this becomes .emi.
 */
export function getProjectConfigDirName(): string {
  return inferProjectConfigDirFromAgentDir() ?? inferProjectConfigDirFromCommand() ?? DEFAULT_PROJECT_CONFIG_DIR;
}

export function getProjectExtensionDir(cwd: string): string {
  return join(cwd, getProjectConfigDirName(), "extensions", "pi-emote");
}
