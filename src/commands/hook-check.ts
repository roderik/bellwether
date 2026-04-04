import { spawnSync } from "node:child_process";
import { z } from "incur";
import { bootstrap } from "../context.js";
import { findPRForBranch, getCurrentBranch } from "../github/index.js";

const PR_PATTERN = /\bgit\s+push\b|\bgh\s+pr\s+(create|ready)\b/;
const DEFAULT_POST_TOOL_USE_EVENT = "PostToolUse";
const STOP_EVENT = "Stop";
const CONTINUE_REASON =
  "Current branch has an open PR that is not merge-ready. Resume the Bellwether loop now: run `bellwether check --watch`, and the moment it returns with a CI failure, review comment, merge conflict, or behind branch, act immediately. If CI fails, reproduce the failing command locally, fix it, rerun that command locally until it passes, then push and restart `bellwether check --watch`. Do not stop while any CI job is still pending or in progress.";

function formatCISummary(checks: unknown): string {
  if (checks === undefined || checks === null) {
    return "";
  }
  if (typeof checks === "string") {
    return ` Checks: ${checks}.`;
  }
  return ` Checks: ${JSON.stringify(checks)}.`;
}

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
  ci?: Record<string, string | number | boolean>;
  reviews?: Record<string, string | number>;
  cta?: {
    description?: string;
  };
}

function parseUnresolvedCount(total: string | number | undefined): number {
  if (total === undefined) {
    return 0;
  }
  if (typeof total === "number") {
    return total;
  }
  // Format: "3 unresolved, 1 unanswered"
  const match = total.match(/^(\d+)\s+unresolved/);
  return match ? Number(match[1]) : 0;
}

interface CurrentBranchPR {
  branch: string | null;
  prNumber: number | null;
  error?: string;
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
    const stdMessage = result.stderr.trim() || result.stdout.trim();
    const errorDetail = result.error instanceof Error ? result.error.message : undefined;
    const message =
      stdMessage.length > 0
        ? stdMessage
        : errorDetail
          ? `bellwether check failed: ${errorDetail}`
          : `bellwether check exited with status ${result.status ?? "unknown"}`;
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

async function resolveCurrentBranchPR(): Promise<CurrentBranchPR> {
  const branch = getCurrentBranch();
  if (!branch || branch === "main" || branch === "master") {
    return { branch, prNumber: null };
  }

  try {
    const ctx = await bootstrap();
    const pr = await findPRForBranch(ctx.repoInfo.owner, ctx.repoInfo.repo, branch, ctx.octokit);
    return { branch, prNumber: pr?.number ?? null };
  } catch (error) {
    return {
      branch,
      prNumber: null,
      error: error instanceof Error ? error.message : "PR detection failed",
    };
  }
}

async function handleStopHook(input: HookInput): Promise<{ decision?: "block"; reason?: string }> {
  if (input.stop_hook_active) {
    return {};
  }

  const { prNumber, error: prResolutionError } = await resolveCurrentBranchPR();
  if (prResolutionError) {
    return {
      reason: `Could not determine PR status for current branch (${prResolutionError}). Consider running \`bellwether check --watch\` to verify.`,
    };
  }

  if (!prNumber) {
    return {};
  }

  const { output, error } = runBellwetherCheck(prNumber);
  // On error (rate limit, timeout, CLI crash), don't advise with stale data — let the agent stop
  if (error) {
    return {};
  }

  if (!output?.pr || output.pr.state !== "open" || output.pr.ready === true) {
    return {};
  }

  const mergeableState = typeof output.pr.mergeable === "string" ? output.pr.mergeable : undefined;

  // Block on immediately actionable mergeability states (dirty = conflict, behind = needs sync)
  if (mergeableState === "dirty" || mergeableState === "behind") {
    const mergeable = ` (mergeable: ${mergeableState})`;
    const cta =
      typeof output.cta?.description === "string" && output.cta.description.trim().length > 0
        ? ` ${output.cta.description}`
        : "";
    return {
      decision: "block",
      reason: `${CONTINUE_REASON}${mergeable}${cta}`,
    };
  }

  // Terminal external blocker: blocked + CI green + 0 unresolved reviews = REVIEW_REQUIRED
  // The agent cannot fulfill human review approvals — let it stop without looping
  const ciFailCount =
    typeof output.ci?.codeFailing === "number"
      ? output.ci.codeFailing
      : typeof output.ci?.failing === "number"
        ? output.ci.failing
        : undefined;
  const ciPendingCount = typeof output.ci?.pending === "number" ? output.ci.pending : undefined;
  const unresolvedReviews = parseUnresolvedCount(output.reviews?.total);

  if (
    mergeableState === "blocked" &&
    (ciFailCount === undefined || ciFailCount === 0) &&
    (ciPendingCount === undefined || ciPendingCount === 0) &&
    unresolvedReviews === 0
  ) {
    return {};
  }

  // Pending CI only — don't nag; the watch loop handles waiting
  if (
    (ciFailCount === undefined || ciFailCount === 0) &&
    ciPendingCount !== undefined &&
    ciPendingCount > 0 &&
    unresolvedReviews === 0
  ) {
    return {};
  }

  // Advisory: only when there are code-fixable CI failures or unresolved reviews
  if (output.pr.ready === undefined) {
    return {};
  }

  const hasActionableWork = (ciFailCount !== undefined && ciFailCount > 0) || unresolvedReviews > 0;
  if (!hasActionableWork) {
    return {};
  }

  const mergeable =
    typeof output.pr.mergeable === "string" ? ` (mergeable: ${output.pr.mergeable})` : "";
  const ciSummary = formatCISummary(output.ci?.checks);
  return {
    reason: `PR #${prNumber} is not yet merge-ready${mergeable}.${ciSummary} Consider running \`bellwether check --watch\` when ready to bring it to a mergeable state.`,
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
      // Only nudge about bellwether if there's an open PR for this branch
      const { prNumber: hookPR } = await resolveCurrentBranchPR();
      if (!hookPR) {
        return c.ok({});
      }
      return c.ok({
        hookSpecificOutput: {
          hookEventName: eventName,
          additionalContext:
            "PR pushed. Resume the Bellwether loop now: run `bellwether check --watch`, and the moment it returns with a CI failure, review comment, merge conflict, or behind branch, act immediately. If CI fails, reproduce the failing command locally, fix it, rerun that command locally until it passes, then push and restart `bellwether check --watch`. Do not stop while any CI job is still pending or in progress.",
        },
      });
    }

    return c.ok({});
  },
};
