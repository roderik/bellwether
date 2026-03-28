// Standalone hook handler — bypasses incur for speed.
// Reads Claude/Codex PostToolUse JSON from stdin.
// If the command is a PR-related action, outputs additionalContext
// telling the LLM to start monitoring with bellwether.

const PR_PATTERN = /\bgit\s+push\b|\bgh\s+pr\s+(create|ready)\b/;

export async function run(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  let command = "";
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString()) as {
      tool_input?: { command?: string };
      hook_event_name?: string;
    };
    command = input.tool_input?.command ?? "";

    if (PR_PATTERN.test(command)) {
      const output = {
        hookSpecificOutput: {
          hookEventName: input.hook_event_name ?? "PostToolUse",
          additionalContext:
            "PR pushed. Run `npx -y bellwether@latest check --watch` to monitor CI and reviews until merge-ready.",
        },
      };
      process.stdout.write(JSON.stringify(output));
    }
  } catch {
    // Malformed input — exit silently
  }
}
