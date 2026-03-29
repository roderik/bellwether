import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Cli, z } from "incur";
import { bootstrap, type Context } from "./context.js";
import { checkCommand } from "./commands/check.js";
import { hookAddCommand } from "./commands/hook-add.js";
import { hookCheckCommand } from "./commands/hook-check.js";

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8")) as {
  version: string;
};

const cli = Cli.create("bellwether", {
  version: pkg.version,
  description: "Monitor GitHub PRs — review comments and CI status",
  vars: z.object({
    ctx: z.custom<Context>(),
  }),
  env: z.object({
    GITHUB_TOKEN: z
      .string()
      .optional()
      .describe("GitHub personal access token (also reads GH_TOKEN, .env.local, gh CLI)"),
    GH_TOKEN: z.string().optional().describe("Alternative GitHub token env var"),
    GH_REPO: z.string().optional().describe("Override repository in owner/repo format"),
    HTTPS_PROXY: z.string().optional().describe("HTTPS proxy URL for corporate/cloud environments"),
  }),
  sync: {
    depth: 1,
    include: ["_root"],
    suggestions: [
      "check CI and reviews for this PR",
      "check CI and reviews for PR 123",
      "watch CI until complete",
      "reply to review comment 12345",
    ],
  },
});

cli.use(async (c, next) => {
  if (!c.command.startsWith("hooks")) {
    c.set("ctx", await bootstrap());
  }
  await next();
});

const hooksCli = Cli.create("hooks", {
  description: "Manage PostToolUse hooks for Claude Code and Codex",
});
hooksCli.command("add", hookAddCommand as unknown as Parameters<typeof hooksCli.command>[1]);
hooksCli.command("check", hookCheckCommand as unknown as Parameters<typeof hooksCli.command>[1]);

cli.command("check", checkCommand as unknown as Parameters<typeof cli.command>[1]);
cli.command(hooksCli as unknown as Parameters<typeof cli.command>[0]);

export { cli };
export default cli;
