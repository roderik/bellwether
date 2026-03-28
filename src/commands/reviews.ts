import { z } from "incur";
import { bootstrap, resolvePR } from "../context.ts";
import {
  type ProxyFetch,
  fetchPRComments,
  processComments,
  filterComments,
  replyToComment,
  resolveThread,
} from "../github/index.ts";
import { c } from "../colors.ts";
import { formatComment, formatDetailedComment } from "../format/comments.ts";

// ---------------------------------------------------------------------------
// Watch mode
// ---------------------------------------------------------------------------

function formatTimestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

async function watchForComments(
  context: {
    owner: string;
    repo: string;
    prNumber: number;
    prUrl: string;
    token: string;
    proxyFetch: ProxyFetch;
  },
  options: {
    botsOnly?: boolean;
    humansOnly?: boolean;
    filter?: "unresolved" | "unanswered" | null;
    watchInterval: number;
    watchTimeout: number;
  },
) {
  const { owner, repo, prNumber, prUrl, token, proxyFetch } = context;
  const seenIds = new Set<number>();
  const lastActivityTime = Date.now();

  const filterDesc = options.botsOnly
    ? "bots-only"
    : options.humansOnly
      ? "humans-only"
      : "all";

  console.log(`\n${c.bold}=== PR Comments Watch Mode ===${c.reset}`);
  console.log(`${c.dim}PR #${prNumber}: ${prUrl}${c.reset}`);
  console.log(
    `${c.dim}Polling every ${options.watchInterval}s, exit after ${options.watchTimeout}s of inactivity${c.reset}`,
  );
  console.log(
    `${c.dim}Filters: ${filterDesc}, ${options.filter || "all comments"}${c.reset}`,
  );
  console.log(`${c.dim}Started at ${formatTimestamp()}${c.reset}\n`);

  // Initial fetch
  const initialData = await fetchPRComments(
    owner,
    repo,
    prNumber,
    token,
    proxyFetch,
  );
  const initialProcessed = processComments(initialData);
  const initialFiltered = filterComments(initialProcessed, options);

  for (const comment of initialFiltered) {
    seenIds.add(comment.id);
  }

  console.log(
    `${c.dim}[${formatTimestamp()}] Initial state: ${initialFiltered.length} existing comments tracked${c.reset}`,
  );

  if (initialFiltered.length > 0) {
    console.log(`\n${c.yellow}=== EXISTING COMMENTS ===${c.reset}`);
    for (const comment of initialFiltered) {
      console.log(formatComment(comment));
      console.log("");
    }
  }

  let pollCount = 0;

  while (true) {
    await Bun.sleep(options.watchInterval * 1000);
    pollCount++;

    const rawData = await fetchPRComments(
      owner,
      repo,
      prNumber,
      token,
      proxyFetch,
    );
    const processed = processComments(rawData);
    const filtered = filterComments(processed, options);
    const newComments = filtered.filter((cm) => !seenIds.has(cm.id));

    if (newComments.length > 0) {
      for (const comment of newComments) {
        seenIds.add(comment.id);
      }

      console.log(
        `\n${c.green}=== NEW COMMENTS DETECTED [${formatTimestamp()}] ===${c.reset}`,
      );
      console.log(
        `${c.bold}Found ${newComments.length} new comment${newComments.length === 1 ? "" : "s"}${c.reset}`,
      );

      // Grace period for bot batches
      console.log(
        `${c.dim}Waiting 5s for additional comments...${c.reset}`,
      );
      await Bun.sleep(5_000);

      const graceData = await fetchPRComments(
        owner,
        repo,
        prNumber,
        token,
        proxyFetch,
      );
      const graceProcessed = processComments(graceData);
      const graceFiltered = filterComments(graceProcessed, options);
      const lateComments = graceFiltered.filter(
        (cm) => !seenIds.has(cm.id),
      );

      for (const comment of lateComments) {
        seenIds.add(comment.id);
        newComments.push(comment);
      }

      if (lateComments.length > 0) {
        console.log(
          `${c.bold}Caught ${lateComments.length} additional comment${lateComments.length === 1 ? "" : "s"}${c.reset}`,
        );
      }

      console.log("");
      for (const comment of newComments) {
        console.log(formatComment(comment));
        console.log("");
      }

      console.log(`${c.dim}--- JSON for processing ---${c.reset}`);
      console.log(JSON.stringify(newComments, null, 2));
      console.log(`${c.dim}--- end JSON ---${c.reset}`);

      console.log(
        `\n${c.green}=== WATCH: EXITING WITH NEW COMMENTS ===${c.reset}`,
      );
      return;
    } else {
      const inactiveSeconds = Math.round(
        (Date.now() - lastActivityTime) / 1000,
      );
      console.log(
        `${c.dim}[${formatTimestamp()}] Poll #${pollCount}: No new comments (${inactiveSeconds}s/${options.watchTimeout}s idle)${c.reset}`,
      );

      if (inactiveSeconds >= options.watchTimeout) {
        console.log(`\n${c.green}=== WATCH COMPLETE ===${c.reset}`);
        console.log(
          `${c.dim}No new comments after ${options.watchTimeout}s of inactivity.${c.reset}`,
        );
        console.log(
          `${c.dim}Total comments tracked: ${seenIds.size}${c.reset}`,
        );
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export const reviewsCommand = {
  description: "List, filter, reply to, and watch PR review comments",
  args: z.object({
    pr: z.coerce
      .number()
      .optional()
      .describe("PR number (auto-detects from branch)"),
  }),
  options: z.object({
    unresolved: z
      .boolean()
      .default(false)
      .describe("Show only unresolved/pending comments"),
    unanswered: z
      .boolean()
      .default(false)
      .describe("Show only comments without any replies"),
    botsOnly: z
      .boolean()
      .default(false)
      .describe("Only show comments from bots"),
    humansOnly: z
      .boolean()
      .default(false)
      .describe("Only show comments from humans"),
    expanded: z
      .boolean()
      .default(false)
      .describe("Show full detail for each comment"),
    reply: z
      .string()
      .optional()
      .describe("Reply to a comment: <id>:<message>"),
    resolve: z
      .boolean()
      .default(false)
      .describe("Resolve the thread after replying"),
    detail: z.coerce
      .number()
      .optional()
      .describe("Show full detail for a specific comment ID"),
    watch: z
      .boolean()
      .default(false)
      .describe("Poll for new comments (exits on detection)"),
    interval: z.coerce
      .number()
      .default(30)
      .describe("Poll interval in seconds (watch mode)"),
    timeout: z.coerce
      .number()
      .default(600)
      .describe("Inactivity timeout in seconds (watch mode)"),
  }),
  alias: {
    unresolved: "u",
    unanswered: "a",
    botsOnly: "b",
    humansOnly: "H",
    expanded: "e",
    reply: "r",
    detail: "d",
    watch: "w",
    interval: "i",
  },
  async run(ctx: any) {
    const bctx = await bootstrap();
    const { prNumber, prUrl } = await resolvePR(bctx, ctx.args.pr);
    const { token, repoInfo, proxyFetch } = bctx;
    const opts = ctx.options;
    const filterOpts = {
      botsOnly: opts.botsOnly,
      humansOnly: opts.humansOnly,
      filter: opts.unresolved
        ? ("unresolved" as const)
        : opts.unanswered
          ? ("unanswered" as const)
          : null,
    };

    // Reply
    if (opts.reply) {
      const colonIdx = opts.reply.indexOf(":");
      if (colonIdx === -1) {
        console.error(
          `${c.red}Error: --reply format is <id>:<message>${c.reset}`,
        );
        process.exit(1);
      }
      const commentId = Number(opts.reply.slice(0, colonIdx));
      const message = opts.reply.slice(colonIdx + 1);

      const result = await replyToComment(
        repoInfo.owner,
        repoInfo.repo,
        prNumber,
        commentId,
        message,
        token,
        proxyFetch,
      );

      if (ctx.agent) {
        return { replied: true, commentId, url: result.html_url };
      }

      console.log(`${c.green}✓ Reply posted successfully${c.reset}`);
      console.log(`  ${c.dim}${result.html_url}${c.reset}`);

      if (opts.resolve) {
        try {
          const resolveResult = await resolveThread(
            repoInfo.owner,
            repoInfo.repo,
            prNumber,
            commentId,
            token,
            proxyFetch,
          );
          if ("resolved" in resolveResult && resolveResult.resolved) {
            console.log(`${c.green}✓ Thread resolved${c.reset}`);
          } else if (
            "alreadyResolved" in resolveResult &&
            resolveResult.alreadyResolved
          ) {
            console.log(`${c.dim}Thread already resolved${c.reset}`);
          } else if ("skipped" in resolveResult && resolveResult.skipped) {
            console.log(
              `${c.dim}Thread resolution skipped (${resolveResult.reason})${c.reset}`,
            );
          }
        } catch (error: any) {
          console.warn(
            `${c.yellow}Reply posted, but thread resolution failed: ${error.message}${c.reset}`,
          );
        }
      }

      return { replied: true, commentId };
    }

    // Detail
    if (opts.detail) {
      const rawData = await fetchPRComments(
        repoInfo.owner,
        repoInfo.repo,
        prNumber,
        token,
        proxyFetch,
      );
      const processed = processComments(rawData);
      const comment = processed.find((cm: any) => cm.id === opts.detail);

      if (!comment) {
        console.error(
          `${c.red}Error: Comment ${opts.detail} not found in PR #${prNumber}${c.reset}`,
        );
        process.exit(1);
      }

      if (ctx.agent) return comment;

      console.log(formatDetailedComment(comment));
      return comment;
    }

    // Watch
    if (opts.watch) {
      await watchForComments(
        {
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          prNumber,
          prUrl,
          token,
          proxyFetch,
        },
        {
          ...filterOpts,
          watchInterval: opts.interval,
          watchTimeout: opts.timeout,
        },
      );
      return;
    }

    // List (default)
    const rawData = await fetchPRComments(
      repoInfo.owner,
      repoInfo.repo,
      prNumber,
      token,
      proxyFetch,
    );
    const processed = processComments(rawData);
    const filtered = filterComments(processed, filterOpts);

    if (ctx.agent) return filtered;

    if (filtered.length === 0) {
      const filterDesc = opts.unresolved
        ? "unresolved "
        : opts.unanswered
          ? "unanswered "
          : "";
      console.log(`${c.green}No ${filterDesc}comments found.${c.reset}`);
      return filtered;
    }

    console.log(
      `${c.bold}Found ${filtered.length} comment${filtered.length === 1 ? "" : "s"}${c.reset}\n`,
    );

    const formatter = opts.expanded ? formatDetailedComment : formatComment;
    const separator = opts.expanded
      ? "\n\n" + "=".repeat(60) + "\n\n"
      : "\n\n";

    console.log(filtered.map((cm: any) => formatter(cm)).join(separator));
    return filtered;
  },
} as const;
