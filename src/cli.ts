import { Cli, z } from "incur";
import { bootstrap, type Context } from "./context.js";
import { checkCommand } from "./commands/check.js";

const cli = Cli.create("bellwether", {
  version: "0.0.1",
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
  c.set("ctx", await bootstrap());
  await next();
});

cli.command("check", checkCommand as unknown as Parameters<typeof cli.command>[1]);

export { cli };
export default cli;
