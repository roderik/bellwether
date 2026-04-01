import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSpawnSync, mockBootstrap, mockGetCurrentBranch, mockFindPRForBranch } = vi.hoisted(
  () => ({
    mockSpawnSync: vi.fn(),
    mockBootstrap: vi.fn(),
    mockGetCurrentBranch: vi.fn(),
    mockFindPRForBranch: vi.fn(),
  }),
);

vi.mock("node:child_process", () => ({
  spawnSync: mockSpawnSync,
}));

vi.mock("../../src/context.js", () => ({
  bootstrap: mockBootstrap,
}));

vi.mock("../../src/github/index.js", () => ({
  getCurrentBranch: mockGetCurrentBranch,
  findPRForBranch: mockFindPRForBranch,
}));

import { hookCheckCommand } from "../../src/commands/hook-check.js";

type StdinAsyncIterator = (typeof process.stdin)[typeof Symbol.asyncIterator];

function mockStdin(data: string) {
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* stdinMock() {
    yield Buffer.from(data);
  } as unknown as StdinAsyncIterator);
}

function makeCtx() {
  const ok = vi.fn((d: unknown) => d);
  return { ok, ctx: () => ok.mock.calls[0]?.[0] };
}

describe("hookCheckCommand", () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockBootstrap.mockReset();
    mockGetCurrentBranch.mockReset();
    mockFindPRForBranch.mockReset();
  });

  it("has description mentioning PostToolUse hook handler", () => {
    expect(hookCheckCommand.description).toContain("PostToolUse");
  });

  it("returns empty object for non-PR command", async () => {
    mockStdin(
      JSON.stringify({ tool_input: { command: "git status" }, hook_event_name: "PostToolUse" }),
    );
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
  });

  it("returns hookSpecificOutput for git push", async () => {
    mockStdin(
      JSON.stringify({
        tool_input: { command: "git push origin main" },
        hook_event_name: "PostToolUse",
      }),
    );
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: expect.stringContaining("bellwether"),
      },
    });
  });

  it("returns hookSpecificOutput for gh pr create", async () => {
    mockStdin(
      JSON.stringify({
        tool_input: { command: "gh pr create --title foo" },
        hook_event_name: "PushEvent",
      }),
    );
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      hookSpecificOutput: {
        hookEventName: "PushEvent",
        additionalContext: expect.stringContaining("bellwether"),
      },
    });
  });

  it("returns hookSpecificOutput for gh pr ready", async () => {
    mockStdin(
      JSON.stringify({
        tool_input: { command: "gh pr ready 123" },
        hook_event_name: "PostToolUse",
      }),
    );
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: expect.any(String),
      },
    });
  });

  it("defaults hook_event_name to PostToolUse when field is absent", async () => {
    mockStdin(JSON.stringify({ tool_input: { command: "git push" } }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: expect.any(String),
      },
    });
  });

  it("returns empty object when tool_input.command is missing", async () => {
    mockStdin(JSON.stringify({ tool_input: {}, hook_event_name: "PostToolUse" }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
  });

  it("returns empty object when tool_input is missing", async () => {
    mockStdin(JSON.stringify({ hook_event_name: "PostToolUse" }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
  });

  it("returns empty object for malformed JSON", async () => {
    mockStdin("not valid json {{ }");
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
  });

  it("returns empty object for empty stdin", async () => {
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(
      async function* emptyStdinMock() {
        // yields nothing — empty stream
      } as unknown as StdinAsyncIterator,
    );
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
  });

  it("does not match gitpusher (no space — word boundary before push)", async () => {
    mockStdin(
      JSON.stringify({ tool_input: { command: "gitpusher" }, hook_event_name: "PostToolUse" }),
    );
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
  });

  it("does not match gh pr list (only create/ready)", async () => {
    mockStdin(
      JSON.stringify({ tool_input: { command: "gh pr list" }, hook_event_name: "PostToolUse" }),
    );
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
  });

  it("returns empty object for Stop when already continuing from a stop hook", async () => {
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: true }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("returns empty object for Stop when current branch has no open PR", async () => {
    mockGetCurrentBranch.mockReturnValue("feature/no-pr");
    mockBootstrap.mockResolvedValue({
      repoInfo: { owner: "roderik", repo: "bellwether" },
      token: "token",
      proxyFetch: vi.fn(),
    });
    mockFindPRForBranch.mockResolvedValue(null);
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("returns empty object for Stop on the main branch", async () => {
    mockGetCurrentBranch.mockReturnValue("main");
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
    expect(mockBootstrap).not.toHaveBeenCalled();
  });

  it("returns empty object for Stop when PR detection fails", async () => {
    mockGetCurrentBranch.mockReturnValue("feature/error");
    mockBootstrap.mockRejectedValue(new Error("bad auth"));
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("returns empty object for Stop when bellwether reports the PR is ready", async () => {
    mockGetCurrentBranch.mockReturnValue("feature/ready");
    mockBootstrap.mockResolvedValue({
      repoInfo: { owner: "roderik", repo: "bellwether" },
      token: "token",
      proxyFetch: vi.fn(),
    });
    mockFindPRForBranch.mockResolvedValue({ number: 42 });
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ pr: { state: "open", mergeable: "clean", ready: true } }),
      stderr: "",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
    expect(mockSpawnSync).toHaveBeenCalledWith("bellwether", ["check", "42", "--format", "json"], {
      encoding: "utf-8",
    });
  });

  it("blocks Stop when bellwether reports the PR is not ready", async () => {
    mockGetCurrentBranch.mockReturnValue("feature/not-ready");
    mockBootstrap.mockResolvedValue({
      repoInfo: { owner: "roderik", repo: "bellwether" },
      token: "token",
      proxyFetch: vi.fn(),
    });
    mockFindPRForBranch.mockResolvedValue({ number: 77 });
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        pr: { state: "open", mergeable: "blocked", ready: false },
        cta: { description: "Checks still running:" },
      }),
      stderr: "",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      decision: "block",
      reason: expect.stringContaining("bellwether check --watch"),
    });
    expect(ok.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        decision: "block",
        reason: expect.stringContaining("mergeable: blocked"),
      }),
    );
  });

  it("blocks Stop when bellwether returns no output", async () => {
    mockGetCurrentBranch.mockReturnValue("feature/no-output");
    mockBootstrap.mockResolvedValue({
      repoInfo: { owner: "roderik", repo: "bellwether" },
      token: "token",
      proxyFetch: vi.fn(),
    });
    mockFindPRForBranch.mockResolvedValue({ number: 91 });
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      decision: "block",
      reason: expect.stringContaining("returned no output"),
    });
  });

  it("blocks Stop when bellwether returns invalid JSON", async () => {
    mockGetCurrentBranch.mockReturnValue("feature/invalid-json");
    mockBootstrap.mockResolvedValue({
      repoInfo: { owner: "roderik", repo: "bellwether" },
      token: "token",
      proxyFetch: vi.fn(),
    });
    mockFindPRForBranch.mockResolvedValue({ number: 92 });
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "{not-json",
      stderr: "",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      decision: "block",
      reason: expect.stringContaining("invalid JSON"),
    });
  });

  it("blocks Stop when bellwether check fails", async () => {
    mockGetCurrentBranch.mockReturnValue("feature/failing-check");
    mockBootstrap.mockResolvedValue({
      repoInfo: { owner: "roderik", repo: "bellwether" },
      token: "token",
      proxyFetch: vi.fn(),
    });
    mockFindPRForBranch.mockResolvedValue({ number: 88 });
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "network issue",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      decision: "block",
      reason: expect.stringContaining("could not verify"),
    });
  });

  it("blocks Stop with a fallback status message when bellwether exits non-zero without output", async () => {
    mockGetCurrentBranch.mockReturnValue("feature/exit-status");
    mockBootstrap.mockResolvedValue({
      repoInfo: { owner: "roderik", repo: "bellwether" },
      token: "token",
      proxyFetch: vi.fn(),
    });
    mockFindPRForBranch.mockResolvedValue({ number: 93 });
    mockSpawnSync.mockReturnValue({
      status: 7,
      stdout: "",
      stderr: "",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      decision: "block",
      reason: expect.stringContaining("status 7"),
    });
  });

  it("blocks Stop without mergeable or CTA suffixes when bellwether omits them", async () => {
    mockGetCurrentBranch.mockReturnValue("feature/minimal");
    mockBootstrap.mockResolvedValue({
      repoInfo: { owner: "roderik", repo: "bellwether" },
      token: "token",
      proxyFetch: vi.fn(),
    });
    mockFindPRForBranch.mockResolvedValue({ number: 94 });
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        pr: { state: "open", ready: false },
        cta: { description: "" },
      }),
      stderr: "",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok.mock.calls[0]?.[0]).toEqual({
      decision: "block",
      reason:
        "Current branch has an open PR that is not merge-ready. Run `bellwether check --watch` and address the reported CI or review issues before stopping.",
    });
  });
});
