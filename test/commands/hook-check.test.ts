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

type StdinChunk = Buffer | string | Uint8Array;
type StdinAsyncIterator = (typeof process.stdin)[typeof Symbol.asyncIterator];

function mockStdin(
  data: string,
  chunkFactory: (data: string) => StdinChunk = (value) => Buffer.from(value),
) {
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* stdinMock() {
    yield chunkFactory(data);
  } as unknown as StdinAsyncIterator);
}

function makeCtx() {
  const ok = vi.fn((d: unknown) => d);
  return { ok, ctx: () => ok.mock.calls[0]?.[0] };
}

function setupStopMocks(branch: string, prNumber: number | null) {
  mockGetCurrentBranch.mockReturnValue(branch);
  mockBootstrap.mockResolvedValue({
    repoInfo: { owner: "roderik", repo: "bellwether" },
    octokit: {} as never,
  });
  if (prNumber === null) {
    mockFindPRForBranch.mockResolvedValue(null);
  } else {
    mockFindPRForBranch.mockResolvedValue({ number: prNumber });
  }
}

describe("hookCheckCommand", () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockBootstrap.mockReset();
    mockGetCurrentBranch.mockReset();
    mockFindPRForBranch.mockReset();
  });

  it("has description mentioning PostToolUse and Stop hook handler", () => {
    expect(hookCheckCommand.description).toContain("PostToolUse");
    expect(hookCheckCommand.description).toContain("Stop");
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
        additionalContext: expect.stringContaining("Resume the Bellwether loop now"),
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
    setupStopMocks("feature/no-pr", null);
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

  it("advises on Stop when PR detection fails on a non-main branch", async () => {
    mockGetCurrentBranch.mockReturnValue("feature/error");
    mockBootstrap.mockRejectedValue(new Error("bad auth"));
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      reason: expect.stringContaining("Could not determine PR status"),
    });
    const call = (ok as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.decision).toBeUndefined();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("returns empty object for Stop when bellwether reports the PR is ready", async () => {
    setupStopMocks("feature/ready", 42);
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

  it("accepts string stdin chunks without throwing", async () => {
    mockStdin(JSON.stringify({ tool_input: { command: "git push" } }), (data) => data);
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: expect.any(String),
      },
    });
  });

  it("advises on Stop when PR has failing CI", async () => {
    setupStopMocks("feature/failing-ci", 77);
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        pr: { state: "open", mergeable: "unstable", ready: false },
        ci: { sha: "abc", "FAIL lint": "Error in src/foo.ts:5", allPassing: false },
        reviews: { total: "0 unresolved, 0 unanswered" },
        cta: { description: "Failed checks detected:" },
      }),
      stderr: "",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      reason: expect.stringContaining("not yet merge-ready"),
    });
    const call = (ok as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.decision).toBeUndefined();
  });

  it("advises on Stop when PR has unresolved reviews", async () => {
    setupStopMocks("feature/unresolved", 78);
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        pr: { state: "open", mergeable: "clean", ready: false },
        ci: { sha: "abc", allPassing: true },
        reviews: { total: "5 unresolved, 3 unanswered", "REVIEW 1 src/foo.ts:10": "Fix this" },
        cta: { description: "Unresolved review comments:" },
      }),
      stderr: "",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      reason: expect.stringContaining("not yet merge-ready"),
    });
    const call = (ok as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.decision).toBeUndefined();
  });

  it("advises on Stop when only missing review approval (CI green, 0 unresolved)", async () => {
    setupStopMocks("feature/needs-approval", 79);
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        pr: { state: "open", mergeable: "blocked", ready: false },
        ci: { sha: "abc", allPassing: true },
        reviews: { total: "0 unresolved, 0 unanswered" },
      }),
      stderr: "",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      reason: expect.stringContaining("not yet merge-ready"),
    });
    const call = (ok as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.decision).toBeUndefined();
  });

  it("allows Stop when PR is closed", async () => {
    setupStopMocks("feature/closed", 80);
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        pr: { state: "closed", mergeable: "unknown", ready: false },
      }),
      stderr: "",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
  });

  it("allows Stop when PR is merged", async () => {
    setupStopMocks("feature/merged", 81);
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        pr: { state: "merged", mergeable: "unknown", ready: false },
      }),
      stderr: "",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
  });

  it("advises on Stop when bellwether returns no output", async () => {
    setupStopMocks("feature/no-output", 91);
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      reason: expect.stringContaining("could not be verified"),
    });
  });

  it("advises on Stop when bellwether returns invalid JSON", async () => {
    setupStopMocks("feature/invalid-json", 92);
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "{not-json",
      stderr: "",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      reason: expect.stringContaining("could not be verified"),
    });
  });

  it("advises on Stop when bellwether check fails", async () => {
    setupStopMocks("feature/failing-check", 88);
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "network issue",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      reason: expect.stringContaining("could not be verified"),
    });
  });

  it("advises on Stop when bellwether exits non-zero without output", async () => {
    setupStopMocks("feature/exit-status", 93);
    mockSpawnSync.mockReturnValue({
      status: 7,
      stdout: "",
      stderr: "",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      reason: expect.stringContaining("could not be verified"),
    });
  });

  it("advises on Stop when bellwether cannot be launched", async () => {
    setupStopMocks("feature/enoent", 96);
    mockSpawnSync.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("spawnSync bellwether ENOENT"), { code: "ENOENT" }),
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      reason: expect.stringContaining("could not be verified"),
    });
  });

  it("advises on Stop when CI/reviews sections are missing (unknown state)", async () => {
    setupStopMocks("feature/minimal", 94);
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
    expect(ok).toHaveBeenCalledWith({
      reason: expect.stringContaining("not yet merge-ready"),
    });
    const call = (ok as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.decision).toBeUndefined();
  });

  it("blocks Stop when PR has merge conflict (dirty)", async () => {
    setupStopMocks("feature/dirty", 97);
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        pr: { state: "open", mergeable: "dirty", ready: false },
        cta: { description: "Merge conflict with base branch:" },
      }),
      stderr: "",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      decision: "block",
      reason: expect.stringContaining("mergeable: dirty"),
    });
  });

  it("advises on Stop when CI is still pending", async () => {
    setupStopMocks("feature/pending", 101);
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        pr: { state: "open", mergeable: "blocked", ready: false },
        ci: {
          sha: "abc",
          checks: "5 total, 3 passing, 0 failing, 2 pending",
          in_progress: "build, test",
        },
        reviews: { total: "0 unresolved, 0 unanswered" },
      }),
      stderr: "",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      reason: expect.stringContaining("Checks: 5 total, 3 passing, 0 failing, 2 pending"),
    });
    const call = (ok as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.decision).toBeUndefined();
  });

  it("blocks Stop when PR is behind base (behind)", async () => {
    setupStopMocks("feature/behind", 98);
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        pr: { state: "open", mergeable: "behind", ready: false },
        ci: { sha: "abc", allPassing: true },
        reviews: { total: "0 unresolved, 0 unanswered" },
      }),
      stderr: "",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      decision: "block",
      reason: expect.stringContaining("mergeable: behind"),
    });
  });

  it("advises on Stop on TIMED_OUT CI conclusion", async () => {
    setupStopMocks("feature/timed-out", 99);
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        pr: { state: "open", mergeable: "unstable", ready: false },
        ci: { sha: "abc", "TIMED_OUT build": "Build timed out" },
        reviews: { total: "0 unresolved, 0 unanswered" },
      }),
      stderr: "",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      reason: expect.stringContaining("not yet merge-ready"),
    });
    const call = (ok as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.decision).toBeUndefined();
  });

  it("advises on Stop on ACTION_REQUIRED CI conclusion", async () => {
    setupStopMocks("feature/action-required", 100);
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        pr: { state: "open", mergeable: "unstable", ready: false },
        ci: { sha: "abc", "ACTION_REQUIRED deploy": "Needs approval" },
        reviews: { total: "0 unresolved, 0 unanswered" },
      }),
      stderr: "",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      reason: expect.stringContaining("not yet merge-ready"),
    });
    const call = (ok as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.decision).toBeUndefined();
  });

  it("formats object-type checks via JSON.stringify in advisory", async () => {
    setupStopMocks("feature/obj-checks", 102);
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        pr: { state: "open", mergeable: "blocked", ready: false },
        ci: { sha: "abc", checks: { total: 3, passing: 1 } },
      }),
      stderr: "",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      reason: expect.stringContaining('{"total":3,"passing":1}'),
    });
  });

  it("advises on Stop when bellwether omits readiness field", async () => {
    setupStopMocks("feature/missing-ready", 95);
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        pr: { state: "open", mergeable: "clean" },
      }),
      stderr: "",
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      reason: expect.stringContaining("could not be determined"),
    });
    const call = (ok as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.decision).toBeUndefined();
  });
});
