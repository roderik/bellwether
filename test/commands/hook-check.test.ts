import { describe, it, expect, vi, beforeEach } from "vitest";
import { hookCheckCommand, evaluatePRState } from "../../src/commands/hook-check.js";
import { execFileSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

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

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("hookCheckCommand", () => {
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
      JSON.stringify({
        tool_input: { command: "gitpusher" },
        hook_event_name: "PostToolUse",
      }),
    );
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
  });

  it("does not match gh pr list (only create/ready)", async () => {
    mockStdin(
      JSON.stringify({
        tool_input: { command: "gh pr list" },
        hook_event_name: "PostToolUse",
      }),
    );
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
  });
});

describe("Stop hook", () => {
  it("blocks when PR has failing CI", async () => {
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({
        pr: { state: "open", mergeable: "unstable", ready: false },
        ci: {
          sha: "abc",
          checks: "3 total",
          "FAIL lint": "Error in src/foo.ts:5",
          allPassing: false,
        },
        reviews: { total: "0 unresolved, 0 unanswered" },
      }),
    );
    mockStdin(JSON.stringify({ hook_event_name: "Stop" }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      decision: "block",
      reason: expect.stringContaining("failing CI checks"),
    });
  });

  it("blocks when PR has unresolved reviews", async () => {
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({
        pr: { state: "open", mergeable: "clean", ready: false },
        ci: { sha: "abc", checks: "3 total", allPassing: true },
        reviews: { total: "5 unresolved, 3 unanswered", "REVIEW 1 src/foo.ts:10": "Fix this" },
      }),
    );
    mockStdin(JSON.stringify({ hook_event_name: "Stop" }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      decision: "block",
      reason: expect.stringContaining("5 unresolved review comments"),
    });
  });

  it("blocks when PR has both failing CI and unresolved reviews", async () => {
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({
        pr: { state: "open", mergeable: "unstable", ready: false },
        ci: { sha: "abc", "FAIL test": "Error", allPassing: false },
        reviews: { total: "2 unresolved, 1 unanswered" },
      }),
    );
    mockStdin(JSON.stringify({ hook_event_name: "Stop" }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      decision: "block",
      reason: expect.stringMatching(/failing CI checks.*unresolved review comment/),
    });
  });

  it("allows stop when PR is ready", async () => {
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({
        pr: { state: "open", mergeable: "clean", ready: true },
        ci: { sha: "abc", allPassing: true },
        reviews: { total: "0 unresolved, 0 unanswered" },
      }),
    );
    mockStdin(JSON.stringify({ hook_event_name: "Stop" }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
  });

  it("allows stop when PR is closed", async () => {
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({
        pr: { state: "closed", mergeable: "unknown", ready: false },
      }),
    );
    mockStdin(JSON.stringify({ hook_event_name: "Stop" }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
  });

  it("allows stop when PR is merged", async () => {
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({
        pr: { state: "merged", mergeable: "unknown", ready: false },
      }),
    );
    mockStdin(JSON.stringify({ hook_event_name: "Stop" }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
  });

  it("allows stop when only missing review approval (CI green, 0 unresolved)", async () => {
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({
        pr: { state: "open", mergeable: "blocked", ready: false },
        ci: { sha: "abc", allPassing: true },
        reviews: { total: "0 unresolved, 0 unanswered" },
      }),
    );
    mockStdin(JSON.stringify({ hook_event_name: "Stop" }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
  });

  it("allows stop when bellwether check fails (no PR on branch)", async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("No PR found for branch");
    });
    mockStdin(JSON.stringify({ hook_event_name: "Stop" }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
  });

  it("allows stop when no pr section in output", async () => {
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify({}));
    mockStdin(JSON.stringify({ hook_event_name: "Stop" }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
  });

  it("singular review comment in reason for count of 1", async () => {
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({
        pr: { state: "open", mergeable: "clean", ready: false },
        ci: { sha: "abc", allPassing: true },
        reviews: { total: "1 unresolved, 1 unanswered", "REVIEW 1 src/foo.ts:10": "Fix" },
      }),
    );
    mockStdin(JSON.stringify({ hook_event_name: "Stop" }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({
      decision: "block",
      reason: expect.stringContaining("1 unresolved review comment."),
    });
    // Should NOT say "comments" (plural)
    const reason = (ok.mock.calls[0]![0] as { reason: string }).reason;
    expect(reason).not.toContain("comments");
  });
});

describe("evaluatePRState", () => {
  it("returns null when execFileSync throws", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("not in a git repo");
    });
    expect(evaluatePRState()).toBeNull();
  });

  it("returns null for non-JSON output", () => {
    vi.mocked(execFileSync).mockReturnValue("not json");
    expect(evaluatePRState()).toBeNull();
  });

  it("returns block with correct reason for CI failures only", () => {
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({
        pr: { state: "open", ready: false },
        ci: { "FAIL build": "tsc error" },
        reviews: { total: "0 unresolved, 0 unanswered" },
      }),
    );
    const result = evaluatePRState();
    expect(result).toEqual({
      decision: "block",
      reason: expect.stringContaining("failing CI checks"),
    });
    expect(result!.reason).not.toContain("unresolved");
  });

  it("returns null when CI is pending but no failures or reviews", () => {
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({
        pr: { state: "open", ready: false },
        ci: { sha: "abc", in_progress: "build, test" },
        reviews: { total: "0 unresolved, 0 unanswered" },
      }),
    );
    expect(evaluatePRState()).toBeNull();
  });
});
