import { describe, it, expect, vi } from "vitest";
import { hookCheckCommand } from "../../src/commands/hook-check.js";

type StdinAsyncIterator = typeof process.stdin[typeof Symbol.asyncIterator];

function mockStdin(data: string) {
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(
    (async function* stdinMock() {
      yield Buffer.from(data);
    }) as unknown as StdinAsyncIterator,
  );
}

function makeCtx() {
  const ok = vi.fn((d: unknown) => d);
  return { ok, ctx: () => ok.mock.calls[0]?.[0] };
}

describe("hookCheckCommand", () => {
  it("has description mentioning PostToolUse hook handler", () => {
    expect(hookCheckCommand.description).toContain("PostToolUse");
  });

  it("returns empty object for non-PR command", async () => {
    mockStdin(JSON.stringify({ tool_input: { command: "git status" }, hook_event_name: "PostToolUse" }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
  });

  it("returns hookSpecificOutput for git push", async () => {
    mockStdin(JSON.stringify({ tool_input: { command: "git push origin main" }, hook_event_name: "PostToolUse" }));
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
    mockStdin(JSON.stringify({ tool_input: { command: "gh pr create --title foo" }, hook_event_name: "PushEvent" }));
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
    mockStdin(JSON.stringify({ tool_input: { command: "gh pr ready 123" }, hook_event_name: "PostToolUse" }));
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
      (async function* emptyStdinMock() {
        // yields nothing — empty stream
      }) as unknown as StdinAsyncIterator,
    );
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
  });

  it("does not match gitpusher (no space — word boundary before push)", async () => {
    mockStdin(JSON.stringify({ tool_input: { command: "gitpusher" }, hook_event_name: "PostToolUse" }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
  });

  it("does not match gh pr list (only create/ready)", async () => {
    mockStdin(JSON.stringify({ tool_input: { command: "gh pr list" }, hook_event_name: "PostToolUse" }));
    const { ok } = makeCtx();
    await hookCheckCommand.run({ ok });
    expect(ok).toHaveBeenCalledWith({});
  });
});
