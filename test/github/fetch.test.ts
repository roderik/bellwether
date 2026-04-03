import { describe, it, expect, beforeEach } from "vitest";
import { getProxyAwareFetch } from "../../src/github/fetch.js";

beforeEach(() => {
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
});

// ---------------------------------------------------------------------------
// getProxyAwareFetch
// ---------------------------------------------------------------------------

describe("getProxyAwareFetch", () => {
  it("returns undefined when no proxy is set", () => {
    const result = getProxyAwareFetch();
    expect(result).toBeUndefined();
  });

  it("returns a function when HTTPS_PROXY is set", () => {
    process.env.HTTPS_PROXY = "http://proxy:8080";
    const result = getProxyAwareFetch();
    // Should return a function (either undici-based or curl-based fallback)
    expect(typeof result).toBe("function");
  });

  it("also reads https_proxy (lowercase)", () => {
    process.env.https_proxy = "http://proxy:8080";
    const result = getProxyAwareFetch();
    expect(typeof result).toBe("function");
  });
});
