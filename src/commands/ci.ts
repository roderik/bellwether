import { z } from "incur";
import { bootstrap, resolvePR } from "../context.ts";
import { fetchCIStatus } from "../github/index.ts";
import { c } from "../colors.ts";
import { formatCIStatus, formatCISummary } from "../format/checks.ts";

export const ciCommand = {
  description: "Show CI/check run status for a PR",
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
    interval: z.coerce
      .number()
      .default(15)
      .describe("Poll interval in seconds"),
    timeout: z.coerce
      .number()
      .default(600)
      .describe("Timeout in seconds"),
  }),
  alias: { watch: "w", interval: "i" },
  async run(ctx: any) {
    const bctx = await bootstrap();
    const { prNumber, prUrl } = await resolvePR(bctx, ctx.args.pr);
    const { token, repoInfo, proxyFetch } = bctx;
    const opts = ctx.options;

    if (opts.watch) {
      console.log(
        `${c.bold}Watching CI for PR #${prNumber}${c.reset} ${c.dim}${prUrl}${c.reset}`,
      );
      console.log(
        `${c.dim}Polling every ${opts.interval}s, timeout ${opts.timeout}s${c.reset}\n`,
      );

      const start = Date.now();
      while (true) {
        const status = await fetchCIStatus(
          repoInfo.owner,
          repoInfo.repo,
          prNumber,
          token,
          proxyFetch,
        );
        console.log(formatCIStatus(status));

        const summary = formatCISummary(status);
        if (summary.allPassing) {
          console.log(`\n${c.green}All checks passed!${c.reset}`);
          return { ...status, allPassing: true };
        }
        if (summary.anyFailing && !summary.anyPending) {
          console.log(`\n${c.red}Some checks failed.${c.reset}`);
          return { ...status, allPassing: false };
        }

        const elapsed = (Date.now() - start) / 1000;
        if (elapsed >= opts.timeout) {
          console.log(
            `\n${c.yellow}Timeout reached (${opts.timeout}s).${c.reset}`,
          );
          return { ...status, timedOut: true };
        }

        console.log(
          `\n${c.dim}Waiting ${opts.interval}s...${c.reset}\n`,
        );
        await Bun.sleep(opts.interval * 1000);
      }
    }

    // Single fetch
    const status = await fetchCIStatus(
      repoInfo.owner,
      repoInfo.repo,
      prNumber,
      token,
      proxyFetch,
    );

    if (ctx.agent) return status;

    console.log(
      `${c.bold}PR #${prNumber}${c.reset} ${c.dim}${prUrl}${c.reset}\n`,
    );
    console.log(formatCIStatus(status));
    return status;
  },
} as const;
