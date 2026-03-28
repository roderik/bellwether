import { join } from "node:path";
import { readFile, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { getRepoRoot } from "./repo.js";

function spawnText(cmd: string[]): string | null {
  const [command, ...args] = cmd;
  if (!command) return null;
  const result = spawnSync(command, args, { encoding: "utf-8" });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

/**
 * Resolve a GitHub token from (in priority order):
 * 1. GITHUB_TOKEN env var
 * 2. GH_TOKEN env var
 * 3. .env.local file in the repo root
 * 4. `gh auth token` CLI
 */
export async function getGitHubToken(): Promise<string | null> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;

  const root = getRepoRoot();
  if (root) {
    const envPath = join(root, ".env.local");
    try {
      await access(envPath);
      const content = await readFile(envPath, "utf-8");
      const match = content.match(/^GITHUB_TOKEN=["']?([^"'\n]+)["']?/m);
      if (match?.[1]) return match[1];
    } catch {}
  }

  const token = spawnText(["gh", "auth", "token"]);
  if (token) return token;

  return null;
}
