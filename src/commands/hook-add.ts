import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "incur";

const HOOK_COMMAND = "npx -y bellwether hooks check --format json";
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
  matcher: string;
  hooks: ClaudeHookEntry[];
}

function buildClaudeHooks(): ClaudeMatcherGroup {
  return {
    matcher: "Bash",
    hooks: [
      { type: "command", if: "Bash(git push*)", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT },
      { type: "command", if: "Bash(gh pr create*)", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT },
      { type: "command", if: "Bash(gh pr ready*)", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT },
    ],
  };
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

  // Remove any existing bellwether hooks
  const cleaned: ClaudeMatcherGroup[] = [];
  for (const group of postToolUse) {
    const filtered = group.hooks.filter((h) => !h.command.includes(BELLWETHER_MARKER));
    if (filtered.length > 0) {
      cleaned.push({ ...group, hooks: filtered });
    }
  }

  // Add fresh bellwether hooks
  cleaned.push(buildClaudeHooks());

  hooks.PostToolUse = cleaned;
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
    matcher: string;
    hooks: { command: string; type: string; timeout?: number }[];
  }

  const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
  const postToolUse = (hooks.PostToolUse ?? []) as CodexMatcherGroup[];

  // Remove any existing bellwether hooks
  const cleaned: CodexMatcherGroup[] = [];
  for (const group of postToolUse) {
    const filtered = group.hooks.filter((h) => !h.command.includes(BELLWETHER_MARKER));
    if (filtered.length > 0) {
      cleaned.push({ ...group, hooks: filtered });
    }
  }

  // Add fresh codex hooks (no `if` — codex doesn't support it)
  cleaned.push({
    matcher: "^Bash$",
    hooks: [{ type: "command", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT }],
  });

  hooks.PostToolUse = cleaned;
  config.hooks = hooks;

  await writeFile(hooksPath, JSON.stringify(config, null, 2) + "\n");
  return hooksPath;
}

// ---------------------------------------------------------------------------
// Incur command
// ---------------------------------------------------------------------------

export const hookAddCommand = {
  description: "Install PostToolUse hooks for Claude Code and Codex",
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
