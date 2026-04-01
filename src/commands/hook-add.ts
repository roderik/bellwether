import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "incur";

const HOOK_COMMAND = "bellwether hooks check --format json";
const HOOK_TIMEOUT = 15;
const BELLWETHER_MARKER = "bellwether hooks check";

// ---------------------------------------------------------------------------
// Claude Code: ~/.claude/settings.json
// ---------------------------------------------------------------------------

interface ClaudeHookEntry {
  type: string;
  command: string;
  if?: string;
  timeout?: number;
}

interface ClaudeMatcherGroup {
  matcher?: string;
  hooks: ClaudeHookEntry[];
}

function buildClaudePostToolUseHooks(): ClaudeMatcherGroup {
  return {
    matcher: "Bash",
    hooks: [
      { type: "command", if: "Bash(git push*)", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT },
      { type: "command", if: "Bash(gh pr create*)", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT },
      { type: "command", if: "Bash(gh pr ready*)", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT },
    ],
  };
}

function buildStopHooks(): ClaudeMatcherGroup {
  return {
    hooks: [{ type: "command", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT }],
  };
}

function removeBellwetherHooks<T extends { hooks: { command: string }[] }>(groups: T[]): T[] {
  const cleaned: T[] = [];
  for (const group of groups) {
    const filtered = group.hooks.filter((hook) => !hook.command.includes(BELLWETHER_MARKER));
    if (filtered.length > 0) {
      cleaned.push({ ...group, hooks: filtered });
    }
  }
  return cleaned;
}

async function configureClaude(): Promise<string> {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    settings = JSON.parse(await readFile(settingsPath, "utf-8")) as Record<string, unknown>;
  } else {
    await mkdir(join(homedir(), ".claude"), { recursive: true });
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const postToolUse = (hooks.PostToolUse ?? []) as ClaudeMatcherGroup[];
  const stop = (hooks.Stop ?? []) as ClaudeMatcherGroup[];

  const cleanedPostToolUse = removeBellwetherHooks(postToolUse);
  const cleanedStop = removeBellwetherHooks(stop);

  cleanedPostToolUse.push(buildClaudePostToolUseHooks());
  cleanedStop.push(buildStopHooks());

  hooks.PostToolUse = cleanedPostToolUse;
  hooks.Stop = cleanedStop;
  settings.hooks = hooks;

  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return settingsPath;
}

// ---------------------------------------------------------------------------
// Codex: ~/.codex/hooks.json
// ---------------------------------------------------------------------------

async function configureCodex(): Promise<string | null> {
  const codexDir = join(homedir(), ".codex");
  if (!existsSync(codexDir)) {
    return null; // Codex not installed
  }

  const hooksPath = join(codexDir, "hooks.json");
  let config: Record<string, unknown> = {};

  if (existsSync(hooksPath)) {
    config = JSON.parse(await readFile(hooksPath, "utf-8")) as Record<string, unknown>;
  }

  interface CodexMatcherGroup {
    matcher?: string;
    hooks: { command: string; type: string; timeout?: number }[];
  }

  const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
  const postToolUse = (hooks.PostToolUse ?? []) as CodexMatcherGroup[];
  const stop = (hooks.Stop ?? []) as CodexMatcherGroup[];

  const cleanedPostToolUse = removeBellwetherHooks(postToolUse);
  const cleanedStop = removeBellwetherHooks(stop);

  cleanedPostToolUse.push({
    matcher: "^Bash$",
    hooks: [{ type: "command", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT }],
  });
  cleanedStop.push(buildStopHooks());

  hooks.PostToolUse = cleanedPostToolUse;
  hooks.Stop = cleanedStop;
  config.hooks = hooks;

  await writeFile(hooksPath, JSON.stringify(config, null, 2) + "\n");
  return hooksPath;
}

// ---------------------------------------------------------------------------
// Incur command
// ---------------------------------------------------------------------------

export const hookAddCommand = {
  description: "Install PostToolUse and Stop hooks for Claude Code and Codex",
  output: z.object({
    claude: z.string().describe("Path to Claude Code settings file"),
    codex: z.string().nullable().describe("Path to Codex hooks file, or null if not installed"),
  }),
  async run(c: { ok: (data: { claude: string; codex: string | null }) => unknown }) {
    const claudePath = await configureClaude();
    const codexPath = await configureCodex();
    return c.ok({ claude: claudePath, codex: codexPath });
  },
};
