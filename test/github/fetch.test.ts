import { describe, it, expect, vi, beforeEach } from "vitest";
import { getProxyFetch, ghFetch, fetchAllPages } from "../../src/github/fetch.js";

beforeEach(() => {
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockProxyFetch(responses: { ok: boolean; status: number; data: any; headers?: Record<string, string> }[]) {
  let callIdx = 0;
  return vi.fn(async () => {
    const resp = responses[callIdx++];
    return {
      ok: resp.ok,
      status: resp.status,
      headers: { get: (name: string) => resp.headers?.[name.toLowerCase()] ?? null },
      text: async () => JSON.stringify(resp.data),
      json: async () => resp.data,
    };
  });
}

// ---------------------------------------------------------------------------
// getProxyFetch
// ---------------------------------------------------------------------------

describe("getProxyFetch", () => {
  it("returns native fetch wrapper when no proxy", () => {
    const pf = getProxyFetch();
    expect(typeof pf).toBe("function");
  });

  it("native fetch wrapper delegates to global fetch", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ "x-test": "val" }),
      text: async () => "body",
      json: async () => ({ data: true }),
    };
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => mockResponse) as any;

    try {
      const pf = getProxyFetch();
      const result = await pf("https://api.github.com/test");
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.headers.get("x-test")).toBe("val");
      expect(await result.text()).toBe("body");
      expect(await result.json()).toEqual({ data: true });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("falls back to curl when proxy set and undici unavailable", () => {
    process.env.HTTPS_PROXY = "http://proxy:8080";
    const pf = getProxyFetch();
    // Should return a function (the curl-based fetch)
    expect(typeof pf).toBe("function");
  });

  it("also reads https_proxy (lowercase)", () => {
    process.env.https_proxy = "http://proxy:8080";
    const pf = getProxyFetch();
    expect(typeof pf).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// ghFetch
// ---------------------------------------------------------------------------

describe("ghFetch", () => {
  it("adds auth headers", async () => {
    let capturedOptions: any;
    const pf = vi.fn(async (_url: string, options: any) => {
      capturedOptions = options;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "", json: async () => ({}) };
    });

    await ghFetch("https://api.github.com/test", "my-token", pf);

    expect(capturedOptions.headers.Authorization).toBe("Bearer my-token");
    expect(capturedOptions.headers.Accept).toBe("application/vnd.github.v3+json");
    expect(capturedOptions.headers["User-Agent"]).toBe("sheperd");
  });

  it("merges custom headers", async () => {
    let capturedOptions: any;
    const pf = vi.fn(async (_url: string, options: any) => {
      capturedOptions = options;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "", json: async () => ({}) };
    });

    await ghFetch("https://api.github.com/test", "tok", pf, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    expect(capturedOptions.method).toBe("POST");
    expect(capturedOptions.headers["Content-Type"]).toBe("application/json");
    expect(capturedOptions.headers.Authorization).toBe("Bearer tok");
  });
});

// ---------------------------------------------------------------------------
// fetchAllPages
// ---------------------------------------------------------------------------

describe("fetchAllPages", () => {
  it("fetches single page", async () => {
    const pf = mockProxyFetch([
      { ok: true, status: 200, data: [{ id: 1 }, { id: 2 }] },
    ]);
    const result = await fetchAllPages("https://api.github.com/test", "tok", pf);
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("follows pagination via Link header", async () => {
    const pf = mockProxyFetch([
      { ok: true, status: 200, data: [{ id: 1 }], headers: { link: '<https://api.github.com/test?page=2>; rel="next"' } },
      { ok: true, status: 200, data: [{ id: 2 }] },
    ]);
    const result = await fetchAllPages("https://api.github.com/test", "tok", pf);
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    expect(pf).toHaveBeenCalledTimes(2);
  });

  it("throws on API error", async () => {
    const pf = mockProxyFetch([
      { ok: false, status: 403, data: { message: "rate limited" } },
    ]);
    await expect(fetchAllPages("https://api.github.com/test", "tok", pf)).rejects.toThrow("API request failed: 403");
  });

  it("handles empty result", async () => {
    const pf = mockProxyFetch([
      { ok: true, status: 200, data: [] },
    ]);
    const result = await fetchAllPages("https://api.github.com/test", "tok", pf);
    expect(result).toEqual([]);
  });
});
