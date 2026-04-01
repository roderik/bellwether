import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type * as NodeOs from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockHomedir } = vi.hoisted(() => ({
  mockHomedir: vi.fn(() => process.env.HOME ?? ""),
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof NodeOs>("node:os");
  return {
    ...actual,
    homedir: mockHomedir,
  };
});

import { hookAddCommand } from "../../src/commands/hook-add.js";

const originalHome = process.env.HOME;
const tempHomes: string[] = [];

afterEach(() => {
  process.env.HOME = originalHome;
  for (const dir of tempHomes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "bellwether-hooks-"));
  tempHomes.push(dir);
  process.env.HOME = dir;
  return dir;
}

describe("hookAddCommand", () => {
  it("installs fresh PostToolUse and Stop hooks without duplicating bellwether entries", async () => {
    const home = makeTempHome();
    const claudeDir = join(home, ".claude");
    const codexDir = join(home, ".codex");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });

    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: "bellwether hooks check --format json", timeout: 15 },
                { type: "command", command: "echo keep-me" },
              ],
            },
          ],
          Stop: [
            {
              hooks: [{ type: "command", command: "bellwether hooks check --format json" }],
            },
          ],
        },
      }),
    );
    writeFileSync(
      join(codexDir, "hooks.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "^Bash$",
              hooks: [
                { type: "command", command: "bellwether hooks check --format json", timeout: 15 },
                { type: "command", command: "echo keep-me-too" },
              ],
            },
          ],
          Stop: [
            {
              hooks: [{ type: "command", command: "bellwether hooks check --format json" }],
            },
          ],
        },
      }),
    );

    const ok = (data: unknown) => data;
    const result = (await hookAddCommand.run({ ok })) as { claude: string; codex: string | null };

    expect(result.claude).toBe(join(claudeDir, "settings.json"));
    expect(result.codex).toBe(join(codexDir, "hooks.json"));

    const claudeConfig = JSON.parse(readFileSync(result.claude, "utf-8")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    const codexConfig = JSON.parse(readFileSync(result.codex!, "utf-8")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };

    expect(claudeConfig.hooks.PostToolUse.flatMap((group) => group.hooks)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "echo keep-me" }),
        expect.objectContaining({ command: "bellwether hooks check --format json" }),
      ]),
    );
    expect(claudeConfig.hooks.Stop.flatMap((group) => group.hooks)).toEqual([
      expect.objectContaining({ command: "bellwether hooks check --format json" }),
    ]);

    expect(codexConfig.hooks.PostToolUse.flatMap((group) => group.hooks)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "echo keep-me-too" }),
        expect.objectContaining({ command: "bellwether hooks check --format json" }),
      ]),
    );
    expect(codexConfig.hooks.Stop.flatMap((group) => group.hooks)).toEqual([
      expect.objectContaining({ command: "bellwether hooks check --format json" }),
    ]);
  });
});
