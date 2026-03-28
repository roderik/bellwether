import { join } from "node:path";
import { getRepoRoot } from "./repo.ts";

function spawnText(cmd: string[]): string | null {
  const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return null;
  return new TextDecoder().decode(result.stdout).trim();
}

/**
 * Resolve a GitHub token from (in priority order):
 * 1. GITHUB_TOKEN env var
 * 2. GH_TOKEN env var
 * 3. .env.local file in the repo root
 * 4. `gh auth token` CLI
 */
export async function getGitHubToken(): Promise<string | null> {
  if (Bun.env.GITHUB_TOKEN) return Bun.env.GITHUB_TOKEN;
  if (Bun.env.GH_TOKEN) return Bun.env.GH_TOKEN;

  const root = getRepoRoot();
  if (root) {
    const envFile = Bun.file(join(root, ".env.local"));
    if (await envFile.exists()) {
      const content = await envFile.text();
      const match = content.match(/^GITHUB_TOKEN=["']?([^"'\n]+)["']?/m);
      if (match?.[1]) return match[1];
    }
  }

  const token = spawnText(["gh", "auth", "token"]);
  if (token) return token;

  return null;
}
