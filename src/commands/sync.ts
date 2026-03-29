import { z } from "incur";
import { resolvePR, type Context } from "../context.js";
import {
  getRepoRoot,
  fetchPRBase,
  syncBranchWithBase,
  parseConflicts,
} from "../github/index.js";

interface SyncCommandContext {
  var: { ctx: Context };
  args: { pr?: number };
  options: { strategy: "rebase" | "merge" };
  ok: (
    data: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ) => unknown;
  error: (data: { message: string }) => unknown;
}

export const syncCommand = {
  description: "Sync PR branch with its base branch; reports conflicts token-efficiently",
  hint: "Fetches origin/<base> and rebases (or merges) your branch onto it. Conflict details are structured for LLM consumption.",
  args: z.object({
    pr: z.coerce.number().optional().describe("PR number (auto-detects from branch)"),
  }),
  options: z.object({
    strategy: z
      .enum(["rebase", "merge"])
      .default("rebase")
      .describe("Sync strategy: rebase (default) or merge"),
  }),
  alias: { strategy: "s" },
  usage: [
    {},
    { args: { pr: true } },
    { options: { strategy: "merge" } },
  ],
  output: z.object({
    synced: z.boolean().describe("true when branch was successfully synced"),
    base: z.string().optional().describe("Base branch synced against (e.g. main)"),
    strategy: z.string().optional().describe("Strategy used: rebase or merge"),
    conflicts: z
      .object({
        count: z.number().describe("Number of conflicted files"),
        files: z.array(z.string()).describe("Conflicted file paths"),
        details: z
          .record(z.string(), z.array(z.string()))
          .describe("Per-file conflict hunks in compact ours/theirs format"),
      })
      .optional()
      .describe("Present when conflicts were detected"),
    message: z.string().optional().describe("Human-readable outcome message"),
  }),
  examples: [
    { description: "Sync current branch with PR base" },
    { args: { pr: 42 }, description: "Sync PR #42's branch" },
    { options: { strategy: "merge" }, description: "Use merge instead of rebase" },
  ],
  async run(c: SyncCommandContext) {
    const ctx = c.var.ctx;
    const { prNumber } = await resolvePR(ctx, c.args.pr);

    const root = getRepoRoot();
    if (!root) {
      return c.error({ message: "Not in a git repository. Run bellwether sync from within the repo." });
    }

    const { base } = await fetchPRBase(
      ctx.repoInfo.owner,
      ctx.repoInfo.repo,
      prNumber,
      ctx.token,
      ctx.proxyFetch,
    );

    const result = syncBranchWithBase(base, c.options.strategy, root);

    if (result.success) {
      return c.ok(
        {
          synced: true,
          base,
          strategy: c.options.strategy,
          message: `Branch synced with origin/${base} via ${c.options.strategy}.`,
        },
        {
          cta: {
            description: "Synced — push and check status:",
            commands: [
              { command: "check --watch", description: "Watch CI after push" },
            ],
          },
        },
      );
    }

    if (result.hasConflicts) {
      const conflicts = parseConflicts(root);
      return c.ok(
        {
          synced: false,
          base,
          strategy: c.options.strategy,
          conflicts,
        },
        {
          cta: {
            description: "Resolve conflicts then re-run:",
            commands: [
              {
                command: c.options.strategy === "rebase" ? "git rebase --continue" : "git merge --continue",
                description: "Continue after resolving",
              },
              { command: "check", description: "Re-check PR status after push" },
            ],
          },
        },
      );
    }

    return c.error({
      message: `Sync failed: ${result.output}`,
    });
  },
};
