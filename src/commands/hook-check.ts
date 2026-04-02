import { z } from "incur";
import { execFileSync } from "node:child_process";

const PR_PATTERN = /\bgit\s+push\b|\bgh\s+pr\s+(create|ready)\b/;

interface CheckOutput {
  pr?: { state: string; ready: boolean };
  ci?: Record<string, string | number | boolean>;
  reviews?: Record<string, string | number>;
}

export function evaluatePRState(): { decision: "block"; reason: string } | null {
  try {
    const raw = execFileSync("bellwether", ["check", "--format", "json"], {
      encoding: "utf-8",
      timeout: 12000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const data = JSON.parse(raw) as CheckOutput;

    // No PR or not open — allow stop
    if (!data.pr || data.pr.state !== "open") return null;
    // Already merge-ready — allow stop
    if (data.pr.ready) return null;

    const hasFailingCI = Object.keys(data.ci ?? {}).some((k) => k.startsWith("FAIL "));
    const totalStr = String(data.reviews?.total ?? "0 unresolved");
    const match = totalStr.match(/^(\d+)\s+unresolved/);
    const unresolvedCount = match ? Number(match[1]) : 0;

    // Only failing CI or unresolved reviews block stopping
    if (!hasFailingCI && unresolvedCount === 0) return null;

    const parts: string[] = [];
    if (hasFailingCI) parts.push("failing CI checks");
    if (unresolvedCount > 0)
      parts.push(`${unresolvedCount} unresolved review comment${unresolvedCount === 1 ? "" : "s"}`);

    return {
      decision: "block",
      reason: `PR has ${parts.join(" and ")}. Run \`bellwether check --watch\` to continue.`,
    };
  } catch {
    // bellwether check failed (no PR, no auth, not in git repo) — allow stop
    return null;
  }
}

export const hookCheckCommand = {
  description:
    "PostToolUse and Stop hook handler — reads hook event from stdin, returns hook output",
  output: z.object({
    hookSpecificOutput: z
      .object({
        hookEventName: z.string(),
        additionalContext: z.string(),
      })
      .optional(),
    decision: z.string().optional(),
    reason: z.string().optional(),
  }),
  async run(c: {
    ok: (data: {
      hookSpecificOutput?: { hookEventName: string; additionalContext: string };
      decision?: string;
      reason?: string;
    }) => unknown;
  }) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }

    try {
      const input = JSON.parse(Buffer.concat(chunks).toString()) as {
        tool_input?: { command?: string };
        hook_event_name?: string;
      };

      // Stop hook — check if PR has actionable work before allowing stop
      if (input.hook_event_name === "Stop") {
        const result = evaluatePRState();
        if (result) {
          return c.ok({ decision: result.decision, reason: result.reason });
        }
        return c.ok({});
      }

      // PostToolUse hook — nudge to watch CI/reviews after PR-related commands
      const command = input.tool_input?.command ?? "";
      if (PR_PATTERN.test(command)) {
        return c.ok({
          hookSpecificOutput: {
            hookEventName: input.hook_event_name ?? "PostToolUse",
            additionalContext:
              "PR pushed. Run `bellwether check --watch` to monitor CI and reviews until merge-ready.",
          },
        });
      }
    } catch {
      // Malformed input — return empty
    }

    return c.ok({});
  },
};
