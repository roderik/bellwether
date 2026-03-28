import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("../../src/github/repo.js", () => ({
  getRepoRoot: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { getRepoRoot } from "../../src/github/repo.js";
import { getGitHubToken } from "../../src/github/auth.js";

const mockSpawnSync = vi.mocked(spawnSync);
const mockAccess = vi.mocked(access);
const mockReadFile = vi.mocked(readFile);
const mockGetRepoRoot = vi.mocked(getRepoRoot);

beforeEach(() => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  mockGetRepoRoot.mockReturnValue(null);
});

describe("getGitHubToken", () => {
  it("returns GITHUB_TOKEN env var first", async () => {
    process.env.GITHUB_TOKEN = "gh-token-1";
    process.env.GH_TOKEN = "gh-token-2";
    expect(await getGitHubToken()).toBe("gh-token-1");
  });

  it("returns GH_TOKEN env var second", async () => {
    process.env.GH_TOKEN = "gh-token-2";
    expect(await getGitHubToken()).toBe("gh-token-2");
  });

  it("reads from .env.local file", async () => {
    mockGetRepoRoot.mockReturnValue("/repo");
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue('GITHUB_TOKEN="file-token"\nOTHER=val' as any);
    expect(await getGitHubToken()).toBe("file-token");
  });

  it("reads unquoted token from .env.local", async () => {
    mockGetRepoRoot.mockReturnValue("/repo");
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue("GITHUB_TOKEN=bare-token\n" as any);
    expect(await getGitHubToken()).toBe("bare-token");
  });

  it("reads single-quoted token from .env.local", async () => {
    mockGetRepoRoot.mockReturnValue("/repo");
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue("GITHUB_TOKEN='quoted-token'\n" as any);
    expect(await getGitHubToken()).toBe("quoted-token");
  });

  it("skips .env.local when file does not exist", async () => {
    mockGetRepoRoot.mockReturnValue("/repo");
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    mockSpawnSync.mockReturnValue({ stdout: "cli-token", status: 0, stderr: "", pid: 1, output: [], signal: null } as any);
    expect(await getGitHubToken()).toBe("cli-token");
  });

  it("skips .env.local when no GITHUB_TOKEN in content", async () => {
    mockGetRepoRoot.mockReturnValue("/repo");
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue("OTHER_VAR=value\n" as any);
    mockSpawnSync.mockReturnValue({ stdout: "cli-token", status: 0, stderr: "", pid: 1, output: [], signal: null } as any);
    expect(await getGitHubToken()).toBe("cli-token");
  });

  it("falls back to gh auth token CLI", async () => {
    mockSpawnSync.mockReturnValue({ stdout: "cli-token", status: 0, stderr: "", pid: 1, output: [], signal: null } as any);
    expect(await getGitHubToken()).toBe("cli-token");
  });

  it("returns null when gh CLI fails", async () => {
    mockSpawnSync.mockReturnValue({ stdout: "", status: 1, stderr: "error", pid: 1, output: [], signal: null } as any);
    expect(await getGitHubToken()).toBeNull();
  });

  it("returns null when no repo root and CLI fails", async () => {
    mockGetRepoRoot.mockReturnValue(null);
    mockSpawnSync.mockReturnValue({ stdout: "", status: 1, stderr: "", pid: 1, output: [], signal: null } as any);
    expect(await getGitHubToken()).toBeNull();
  });
});
