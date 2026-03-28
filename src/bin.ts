#!/usr/bin/env node

const cmd = process.argv[2];

// Fast path for hook commands — bypass incur entirely for speed
if (cmd === "hook-check") {
  const { run } = await import("./commands/hook-check.js");
  await run();
} else if (cmd === "hook-add") {
  const { run } = await import("./commands/hook-add.js");
  await run();
} else {
  const { cli } = await import("./cli.js");
  void cli.serve();
}
