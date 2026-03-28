import { Cli } from "incur";
import { reviewsCommand } from "./commands/reviews.ts";
import { ciCommand } from "./commands/ci.ts";

const cli = Cli.create("sheperd", {
  description: "Monitor GitHub PRs — review comments and CI status",
});

cli.command("reviews", reviewsCommand);
cli.command("ci", ciCommand);

export { cli };
