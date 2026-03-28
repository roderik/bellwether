import type { ProcessedComment } from "../github/comments.ts";
import { c } from "../colors.ts";

function truncate(str: string, maxLength: number): string {
  if (!str) return "";
  const oneLine = str.replace(/\n/g, " ").trim();
  if (oneLine.length <= maxLength) return oneLine;
  return `${oneLine.slice(0, maxLength - 3)}...`;
}

function getReplyStatus(comment: ProcessedComment): string {
  if (!comment.hasAnyReply) return `${c.red}○ no reply${c.reset}`;
  if (comment.hasHumanReply) return `${c.green}✓ replied${c.reset}`;
  return `${c.yellow}⚡ bot replied${c.reset}`;
}

export function formatComment(comment: ProcessedComment): string {
  const typeColors: Record<string, string> = {
    review_comment: c.cyan,
    issue_comment: c.blue,
    review: c.magenta,
  };
  const typeLabels: Record<string, string> = {
    review_comment: "CODE",
    issue_comment: "COMMENT",
    review: "REVIEW",
  };

  const typeColor = typeColors[comment.type] || c.reset;
  const typeLabel = typeLabels[comment.type] || comment.type.toUpperCase();
  const userColor = comment.isBot ? c.yellow : c.green;
  const replyStatus = getReplyStatus(comment);

  let location = "";
  if (comment.path) {
    location = `${c.dim}${comment.path}`;
    if (comment.line) location += `:${comment.line}`;
    location += c.reset;
  }

  const lines = [
    `${c.bold}[${comment.id}]${c.reset} ${typeColor}${typeLabel}${c.reset} by ${userColor}${comment.user}${c.reset} ${replyStatus}`,
  ];

  if (location) lines.push(`  ${location}`);
  lines.push(`  ${c.dim}${truncate(comment.body, 100)}${c.reset}`);

  if (comment.replies.length > 0) {
    lines.push(
      `  ${c.dim}└ ${comment.replies.length} repl${comment.replies.length === 1 ? "y" : "ies"}${c.reset}`,
    );
  }

  return lines.join("\n");
}

export function formatDetailedComment(comment: ProcessedComment): string {
  const typeLabels: Record<string, string> = {
    review_comment: "CODE",
    issue_comment: "COMMENT",
    review: "REVIEW",
  };
  const typeLabel = typeLabels[comment.type] || comment.type.toUpperCase();
  const replyStatus = comment.hasAnyReply
    ? comment.hasHumanReply
      ? "✓ replied"
      : "⚡ bot replied"
    : "○ no reply";

  const lines: string[] = [];
  lines.push(`=== Comment [${comment.id}] ===`);
  lines.push(
    `Type: ${typeLabel} | By: ${comment.user} | Status: ${replyStatus}`,
  );

  if (comment.path) {
    let location = `File: ${comment.path}`;
    if (comment.line) location += `:${comment.line}`;
    lines.push(location);
  }

  lines.push(`URL: ${comment.url}`);

  if (comment.diffHunk) {
    lines.push(
      "",
      "--- Code Context ---",
      comment.diffHunk,
      "--- End Code Context ---",
    );
  }

  lines.push("", comment.body || "(no body)");

  if (comment.replies.length > 0) {
    lines.push("", `--- Replies (${comment.replies.length}) ---`);
    for (const reply of comment.replies) {
      const date = reply.createdAt
        ? new Date(reply.createdAt).toISOString().replace("T", " ").slice(0, 16)
        : "unknown";
      lines.push(`[${reply.id}] ${reply.user} (${date}):`);
      lines.push(reply.body || "(no body)");
      lines.push("");
    }
    lines.push("--- End Replies ---");
  }

  return lines.join("\n");
}
