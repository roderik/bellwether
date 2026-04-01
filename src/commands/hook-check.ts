import { spawnSync } from "node:child_process";
import { z } from "incur";
import { bootstrap } from "../context.js";
import { findPRForBranch, getCurrentBranch } from "../github/index.js";

const PR_PATTERN = /\bgit\s+push\b|\bgh\s+pr\s+(create|ready)\b/;
const DEFAULT_POST_TOOL_USE_EVENT = "PostToolUse";
const STOP_EVENT = "Stop";
const CONTINUE_REASON =
  "Current branch has an open PR that is not merge-ready. Run `bellwether check --watch` and address the reported CI or review issues before stopping.";

interface HookInput {
  hook_event_name?: string;
  last_assistant_message?: string | null;
  stop_hook_active?: boolean;
  tool_input?: { command?: string };
}

interface BellwetherCheckOutput {
  pr?: {
    mergeable?: string;
    ready?: boolean;
    state?: string;
  };
  cta?: {
    description?: string;
  };
}

function normalizeStdinChunk(chunk: Buffer | string | Uint8Array): Buffer {
  if (typeof chunk === "string") {
    return Buffer.from(chunk);
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  return Buffer.from(chunk);
}

function parseHookInput(stdin: (Buffer | string | Uint8Array)[]): HookInput | null {
  try {
    return JSON.parse(Buffer.concat(stdin.map(normalizeStdinChunk)).toString()) as HookInput;
  } catch {
    return null;
  }
}

function runBellwetherCheck(prNumber: number): { output?: BellwetherCheckOutput; error?: string } {
  const result = spawnSync("bellwether", ["check", String(prNumber), "--format", "json"], {
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    const message =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `bellwether check exited with status ${result.status ?? "unknown"}`;
    return { error: message };
  }

  const stdout = result.stdout.trim();
  if (!stdout) {
    return { error: "bellwether check returned no output" };
  }

  try {
    return { output: JSON.parse(stdout) as BellwetherCheckOutput };
  } catch {
    return { error: "bellwether check returned invalid JSON" };
  }
}

async function resolveCurrentBranchPR(): Promise<number | null> {
  const branch = getCurrentBranch();
  if (!branch || branch === "main" || branch === "master") {
    return null;
  }

  try {
    const ctx = await bootstrap();
    const pr = await findPRForBranch(
      ctx.repoInfo.owner,
      ctx.repoInfo.repo,
      branch,
      ctx.token,
      ctx.proxyFetch,
    );
    return pr?.number ?? null;
  } catch {
    return null;
  }
}

async function handleStopHook(input: HookInput): Promise<{ decision?: "block"; reason?: string }> {
  if (input.stop_hook_active) {
    return {};
  }

  const prNumber = await resolveCurrentBranchPR();
  if (!prNumber) {
    return {};
  }

  const { output, error } = runBellwetherCheck(prNumber);
  if (error) {
    return {
      decision: "block",
      reason: `Current branch has open PR #${prNumber}, but Bellwether could not verify it (${error}). Run \`bellwether check --watch\` before stopping.`,
    };
  }

  if (!output?.pr || output.pr.state !== "open") {
    return {};
  }

  if (output.pr.ready === true) {
    return {};
  }

  if (output.pr.ready === undefined) {
    return {
      decision: "block",
      reason: `Current branch has open PR #${prNumber}, but Bellwether could not verify whether it is merge-ready from the CLI output. This may indicate an older or incompatible Bellwether CLI. Run \`bellwether check --watch\` with an up-to-date CLI before stopping.`,
    };
  }

  const mergeable =
    typeof output.pr.mergeable === "string" ? ` (mergeable: ${output.pr.mergeable})` : "";
  const cta =
    typeof output.cta?.description === "string" && output.cta.description.trim().length > 0
      ? ` ${output.cta.description}`
      : "";
  return {
    decision: "block",
    reason: `${CONTINUE_REASON}${mergeable}${cta}`,
  };
}

export const hookCheckCommand = {
  description:
    "PostToolUse and Stop hook handler — reads hook event from stdin and returns hook output",
  output: z.object({
    hookSpecificOutput: z
      .object({
        hookEventName: z.string(),
        additionalContext: z.string(),
      })
      .optional(),
    decision: z.literal("block").optional(),
    reason: z.string().optional(),
  }),
  async run(c: {
    ok: (data: {
      hookSpecificOutput?: { hookEventName: string; additionalContext: string };
      decision?: "block";
      reason?: string;
    }) => unknown;
  }) {
    const chunks: (Buffer | string | Uint8Array)[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer | string | Uint8Array);
    }

    const input = parseHookInput(chunks);
    if (!input) {
      return c.ok({});
    }

    const eventName = input.hook_event_name ?? DEFAULT_POST_TOOL_USE_EVENT;
    if (eventName === STOP_EVENT) {
      return c.ok(await handleStopHook(input));
    }

    const command = input.tool_input?.command ?? "";
    if (PR_PATTERN.test(command)) {
      return c.ok({
        hookSpecificOutput: {
          hookEventName: eventName,
          additionalContext:
            "PR pushed. Run `bellwether check --watch` to monitor CI and reviews until merge-ready.",
        },
      });
    }

    return c.ok({});
  },
};
