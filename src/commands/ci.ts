import { z } from "incur";
import { resolvePR, type Context } from "../context.js";
import { fetchCIStatus } from "../github/index.js";

const failingCheckSchema = z.object({
  name: z.string().describe("Check name"),
  conclusion: z.string().describe("Result"),
  html_url: z.string().describe("GitHub URL for full logs"),
  log: z.string().describe("Filtered error output from the failed step"),
});

export const ciCommand = {
  description: "Show CI/check run status for a PR",
  hint: "With --watch, polls until all checks complete, fail, or timeout. Returns immediately on first poll without --watch.",
  args: z.object({
    pr: z.coerce
      .number()
      .optional()
      .describe("PR number (auto-detects from branch)"),
  }),
  options: z.object({
    watch: z
      .boolean()
      .default(false)
      .describe("Poll until all checks complete"),
    interval: z.coerce.number().default(15).describe("Poll interval in seconds"),
    timeout: z.coerce.number().default(600).describe("Timeout in seconds"),
  }),
  alias: { watch: "w", interval: "i" },
  usage: [
    {},
    { args: { pr: true } },
    { args: { pr: true }, options: { watch: true } },
    { args: { pr: true }, options: { watch: true, interval: true, timeout: true } },
  ],
  output: z.object({
    sha: z.string().describe("Head commit SHA"),
    total: z.number().describe("Total number of checks"),
    passing: z.number().describe("Checks that succeeded/skipped"),
    failing: z.number().describe("Checks that failed/timed out"),
    pending: z.number().describe("Checks still running or queued"),
    passed: z.array(z.string()).describe("Names of passing checks"),
    in_progress: z.array(z.string()).describe("Names of running checks"),
    failures: z.array(failingCheckSchema).describe("Failing checks with annotations"),
    allPassing: z.boolean().optional().describe("True when all checks passed"),
    timedOut: z.boolean().optional().describe("True when watch timed out"),
  }),
  examples: [
    { description: "Show CI status for current branch's PR" },
    { args: { pr: 123 }, description: "CI status for PR #123" },
    {
      options: { watch: true },
      description: "Poll until checks complete",
    },
    {
      args: { pr: 123 },
      options: { watch: true, interval: 10, timeout: 300 },
      description: "Watch PR #123, poll every 10s, 5min timeout",
    },
  ],
  async run(c: any) {
    const ctx: Context = c.var.ctx;
    const { prNumber } = await resolvePR(ctx, c.args.pr);
    const { token, repoInfo, proxyFetch } = ctx;
    const opts = c.options;

    if (opts.watch) {
      const start = Date.now();
      while (true) {
        const status = await fetchCIStatus(
          repoInfo.owner,
          repoInfo.repo,
          prNumber,
          token,
          proxyFetch,
        );

        const allPassing = status.failing === 0 && status.pending === 0;
        if (allPassing) return c.ok({ ...status, allPassing: true });

        if (status.failing > 0 && status.pending === 0) {
          return c.ok({ ...status, allPassing: false }, {
            cta: {
              description: "Failed checks detected:",
              commands: [
                {
                  command: "reviews",
                  args: { pr: prNumber },
                  options: { unresolved: true },
                  description: "Check for review comments about failures",
                },
              ],
            },
          });
        }

        if ((Date.now() - start) / 1000 >= opts.timeout) {
          return c.ok({ ...status, timedOut: true }, {
            cta: {
              description: "Timed out, checks still running:",
              commands: [
                {
                  command: "ci",
                  args: { pr: prNumber },
                  options: { watch: true, timeout: opts.timeout * 2 },
                  description: "Retry with longer timeout",
                },
              ],
            },
          });
        }

        await new Promise<void>((r) => setTimeout(r, opts.interval * 1000));
      }
    }

    const status = await fetchCIStatus(
      repoInfo.owner,
      repoInfo.repo,
      prNumber,
      token,
      proxyFetch,
    );

    return c.ok(status, {
      cta: status.pending > 0
        ? {
            description: "Checks still running:",
            commands: [
              {
                command: "ci",
                args: { pr: prNumber },
                options: { watch: true },
                description: "Watch until complete",
              },
            ],
          }
        : status.failing > 0
          ? {
              description: "Checks failing:",
              commands: [
                {
                  command: "reviews",
                  args: { pr: prNumber },
                  options: { unresolved: true },
                  description: "Check review comments",
                },
              ],
            }
          : undefined,
    });
  },
};
