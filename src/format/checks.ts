import type { CIStatus, CheckRun } from "../github/checks.ts";
import { c } from "../colors.ts";

function checkIcon(check: CheckRun): string {
  if (check.status !== "completed") {
    return `${c.yellow}●${c.reset}`;
  }
  switch (check.conclusion) {
    case "success":
      return `${c.green}✓${c.reset}`;
    case "failure":
    case "timed_out":
      return `${c.red}✗${c.reset}`;
    case "cancelled":
      return `${c.dim}⊘${c.reset}`;
    case "skipped":
    case "neutral":
      return `${c.dim}−${c.reset}`;
    case "action_required":
      return `${c.yellow}!${c.reset}`;
    default:
      return `${c.dim}?${c.reset}`;
  }
}

function duration(check: CheckRun): string {
  if (!check.started_at || !check.completed_at) return "";
  const ms =
    new Date(check.completed_at).getTime() -
    new Date(check.started_at).getTime();
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m${remainSecs > 0 ? `${remainSecs}s` : ""}`;
}

export function formatCIStatus(status: CIStatus): string {
  const lines: string[] = [];

  let summaryColor = c.green;
  if (status.failing > 0) summaryColor = c.red;
  else if (status.pending > 0) summaryColor = c.yellow;

  lines.push(
    `${c.bold}CI Status${c.reset} ${c.dim}(${status.sha.slice(0, 7)})${c.reset}`,
  );

  if (status.total === 0) {
    lines.push(`  ${c.dim}No checks found${c.reset}`);
    return lines.join("\n");
  }

  lines.push(
    `  ${summaryColor}${status.passing} passing${c.reset}, ${status.failing > 0 ? c.red : c.dim}${status.failing} failing${c.reset}, ${status.pending > 0 ? c.yellow : c.dim}${status.pending} pending${c.reset} ${c.dim}(${status.total} total)${c.reset}`,
  );

  lines.push("");

  const sorted = [...status.checks].sort((a, b) => {
    const order = (ch: CheckRun) => {
      if (
        ch.conclusion === "failure" ||
        ch.conclusion === "timed_out" ||
        ch.conclusion === "action_required"
      )
        return 0;
      if (ch.status !== "completed") return 1;
      return 2;
    };
    return order(a) - order(b);
  });

  for (const check of sorted) {
    const icon = checkIcon(check);
    const dur = duration(check);
    const statusText =
      check.status !== "completed"
        ? `${c.yellow}${check.status}${c.reset}`
        : check.conclusion || "";
    lines.push(
      `  ${icon} ${check.name} ${c.dim}${statusText}${dur ? ` (${dur})` : ""}${c.reset}`,
    );
  }

  return lines.join("\n");
}

export function formatCISummary(status: CIStatus): {
  allPassing: boolean;
  anyFailing: boolean;
  anyPending: boolean;
  summary: string;
} {
  return {
    allPassing: status.failing === 0 && status.pending === 0,
    anyFailing: status.failing > 0,
    anyPending: status.pending > 0,
    summary: `${status.passing}/${status.total} passing, ${status.failing} failing, ${status.pending} pending`,
  };
}
