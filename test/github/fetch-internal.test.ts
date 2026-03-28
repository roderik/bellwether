import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node modules before importing fetch
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  mkdtempSync: vi.fn(() => "/tmp/bellwether-test"),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  rm: vi.fn(),
}));

vi.mock("node:module", () => ({
  createRequire: vi.fn(() =>
    vi.fn(() => {
      throw new Error("undici not found");
    }),
  ),
}));

import { spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { getProxyFetch } from "../../src/github/fetch.js";

const mockSpawnSync = vi.mocked(spawnSync);
const mockReadFile = vi.mocked(readFile);
const mockRm = vi.mocked(rm);

beforeEach(() => {
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  mockSpawnSync.mockClear();
  mockReadFile.mockClear();
  mockRm.mockClear();
});

describe("curl-based fetch (via getProxyFetch with proxy)", () => {
  it("creates curl fetch and parses response", async () => {
    process.env.HTTPS_PROXY = "http://proxy:8080";

    const pf = getProxyFetch();

    // Mock curl execution
    mockSpawnSync.mockReturnValue({
      stdout: "200",
      status: 0,
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    } as any);

    // Mock file reads for body and headers
    mockReadFile
      .mockResolvedValueOnce('{"result": true}' as any) // body file
      .mockResolvedValueOnce(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-custom: val\r\n" as any,
      ); // headers file

    mockRm.mockResolvedValue(undefined);

    const result = await pf("https://api.github.com/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"key":"val"}',
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("application/json");
    expect(result.headers.get("x-custom")).toBe("val");
    expect(result.headers.get("nonexistent")).toBeNull();
    expect(await result.text()).toBe('{"result": true}');
    expect(await result.json()).toEqual({ result: true });

    // Verify curl was called with correct args
    const curlArgs = mockSpawnSync.mock.calls[0][1] as string[];
    expect(curlArgs).toContain("POST");
    expect(curlArgs).toContain("--data");
    expect(curlArgs).toContain('{"key":"val"}');
    expect(curlArgs).toContain("Content-Type: application/json");
  });

  it("handles non-ok status", async () => {
    process.env.HTTPS_PROXY = "http://proxy:8080";
    const pf = getProxyFetch();

    mockSpawnSync.mockReturnValue({
      stdout: "404",
      status: 0,
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    } as any);
    mockReadFile
      .mockResolvedValueOnce("Not found" as any)
      .mockResolvedValueOnce("HTTP/1.1 404 Not Found\r\n" as any);
    mockRm.mockResolvedValue(undefined);

    const result = await pf("https://api.github.com/missing");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
  });

  it("parses empty body as null in json()", async () => {
    process.env.HTTPS_PROXY = "http://proxy:8080";
    const pf = getProxyFetch();

    mockSpawnSync.mockReturnValue({
      stdout: "200",
      status: 0,
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    } as any);
    mockReadFile
      .mockResolvedValueOnce("" as any)
      .mockResolvedValueOnce("HTTP/1.1 200 OK\r\n" as any);
    mockRm.mockResolvedValue(undefined);

    const result = await pf("https://api.github.com/empty");
    expect(await result.json()).toBeNull();
  });

  it("handles redirect header blocks (multiple HTTP status lines)", async () => {
    process.env.HTTPS_PROXY = "http://proxy:8080";
    const pf = getProxyFetch();

    mockSpawnSync.mockReturnValue({
      stdout: "200",
      status: 0,
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    } as any);
    mockReadFile
      .mockResolvedValueOnce("{}" as any)
      .mockResolvedValueOnce(
        "HTTP/1.1 302 Found\r\nlocation: /other\r\n\r\nHTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n" as any,
      );
    mockRm.mockResolvedValue(undefined);

    const result = await pf("https://api.github.com/redirect");
    expect(result.headers.get("content-type")).toBe("text/plain");
  });

  it("handles headers with no HTTP/ prefix gracefully", async () => {
    process.env.HTTPS_PROXY = "http://proxy:8080";
    const pf = getProxyFetch();

    mockSpawnSync.mockReturnValue({
      stdout: "200",
      status: 0,
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    } as any);
    mockReadFile.mockResolvedValueOnce("{}" as any).mockResolvedValueOnce("" as any);
    mockRm.mockResolvedValue(undefined);

    const result = await pf("https://api.github.com/test");
    expect(result.headers.get("anything")).toBeNull();
  });

  it("cleans up temp dir even on error", async () => {
    process.env.HTTPS_PROXY = "http://proxy:8080";
    const pf = getProxyFetch();

    mockSpawnSync.mockReturnValue({
      stdout: "200",
      status: 0,
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    } as any);
    mockReadFile.mockRejectedValueOnce(new Error("read fail"));
    mockRm.mockResolvedValue(undefined);

    await expect(pf("https://api.github.com/test")).rejects.toThrow("read fail");
    expect(mockRm).toHaveBeenCalledWith("/tmp/bellwether-test", { recursive: true, force: true });
  });

  it("makes GET request by default", async () => {
    process.env.HTTPS_PROXY = "http://proxy:8080";
    const pf = getProxyFetch();

    mockSpawnSync.mockReturnValue({
      stdout: "200",
      status: 0,
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    } as any);
    mockReadFile
      .mockResolvedValueOnce("{}" as any)
      .mockResolvedValueOnce("HTTP/1.1 200 OK\r\n" as any);
    mockRm.mockResolvedValue(undefined);

    await pf("https://api.github.com/test");
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "curl",
      expect.arrayContaining(["--request", "GET"]),
      expect.anything(),
    );
    // No --data flag when no body
    const curlArgs = mockSpawnSync.mock.calls[0][1] as string[];
    expect(curlArgs).not.toContain("--data");
  });

  it("header parsing ignores lines without colons", async () => {
    process.env.HTTPS_PROXY = "http://proxy:8080";
    const pf = getProxyFetch();

    mockSpawnSync.mockReturnValue({
      stdout: "200",
      status: 0,
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    } as any);
    mockReadFile
      .mockResolvedValueOnce("{}" as any)
      .mockResolvedValueOnce("HTTP/1.1 200 OK\r\nno-colon-line\r\nreal-header: value\r\n" as any);
    mockRm.mockResolvedValue(undefined);

    const result = await pf("https://api.github.com/test");
    expect(result.headers.get("real-header")).toBe("value");
    expect(result.headers.get("no-colon-line")).toBeNull();
  });

  it("throws when curl fails to start", async () => {
    process.env.HTTPS_PROXY = "http://proxy:8080";
    const pf = getProxyFetch();

    mockSpawnSync.mockReturnValue({
      stdout: "",
      status: null,
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
      error: new Error("ENOENT"),
    } as any);
    mockRm.mockResolvedValue(undefined);

    await expect(pf("https://api.github.com/test")).rejects.toThrow("curl failed to start: ENOENT");
  });

  it("throws when curl exits with non-zero status", async () => {
    process.env.HTTPS_PROXY = "http://proxy:8080";
    const pf = getProxyFetch();

    mockSpawnSync.mockReturnValue({
      stdout: "",
      status: 7,
      stderr: "Connection refused",
      pid: 1,
      output: [],
      signal: null,
    } as any);
    mockRm.mockResolvedValue(undefined);

    await expect(pf("https://api.github.com/test")).rejects.toThrow(
      "curl exited with status 7: Connection refused",
    );
  });

  it("throws when curl returns invalid status code", async () => {
    process.env.HTTPS_PROXY = "http://proxy:8080";
    const pf = getProxyFetch();

    mockSpawnSync.mockReturnValue({
      stdout: "",
      status: 0,
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    } as any);
    mockRm.mockResolvedValue(undefined);

    await expect(pf("https://api.github.com/test")).rejects.toThrow(
      "curl did not return a valid HTTP status code",
    );
  });
});
