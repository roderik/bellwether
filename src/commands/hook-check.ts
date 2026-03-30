import { z } from "incur";

const PR_PATTERN = /\bgit\s+push\b|\bgh\s+pr\s+(create|ready)\b/;

export const hookCheckCommand = {
  description:
    "PostToolUse hook handler — reads hook event from stdin, outputs context if PR-related",
  output: z.object({
    hookSpecificOutput: z
      .object({
        hookEventName: z.string(),
        additionalContext: z.string(),
      })
      .optional(),
  }),
  async run(c: {
    ok: (data: {
      hookSpecificOutput?: { hookEventName: string; additionalContext: string };
    }) => unknown;
  }) {
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
        return c.ok({
          hookSpecificOutput: {
            hookEventName: input.hook_event_name ?? "PostToolUse",
            additionalContext:
              "PR pushed. Run `npx bellwether check --watch` to monitor CI and reviews until merge-ready.",
          },
        });
      }
    } catch {
      // Malformed input — return empty
    }

    return c.ok({});
  },
};
