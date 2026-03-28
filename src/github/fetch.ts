import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const USER_AGENT = "bellwether";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProxyFetch = (url: string, options?: ProxyFetchOptions) => Promise<ProxyFetchResponse>;

export interface ProxyFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface HeaderMap {
  get(name: string): string | null;
}

export interface ProxyFetchResponse {
  ok: boolean;
  status: number;
  headers: HeaderMap;
  text(): Promise<string>;
  json(): Promise<any>;
}

// ---------------------------------------------------------------------------
// Header parsing (for curl responses & proxied headers)
// ---------------------------------------------------------------------------

function parseHeaderMap(rawHeaders: string): HeaderMap {
  const lines = rawHeaders.split(/\r?\n/).filter(Boolean);
  const map = new Map<string, string>();
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx === -1) {
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    map.set(key, value);
  }
  return {
    get(name: string) {
      return map.get(String(name).toLowerCase()) ?? null;
    },
  };
}

function parseLastHeaderBlock(headerContent: string): string {
  const blocks = headerContent
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block?.startsWith("HTTP/")) {
      return block;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Curl-based fetch (fallback when undici is unavailable behind a proxy)
// ---------------------------------------------------------------------------

function createCurlFetch(): ProxyFetch {
  return async (url: string, options: ProxyFetchOptions = {}) => {
    const tempDir = mkdtempSync(join(tmpdir(), "bellwether-"));
    const headersFile = join(tempDir, "headers.txt");
    const bodyFile = join(tempDir, "body.txt");

    const args = [
      "--silent",
      "--show-error",
      "--location",
      "--connect-timeout",
      "10",
      "--max-time",
      "60",
      "--dump-header",
      headersFile,
      "--output",
      bodyFile,
      "--request",
      options.method ?? "GET",
      "--write-out",
      "%{http_code}",
    ];

    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        args.push("--header", `${key}: ${value}`);
      }
    }
    if (options.body) {
      args.push("--data", options.body);
    }

    args.push(String(url));

    try {
      const result = spawnSync("curl", args, {
        encoding: "utf-8",
        timeout: 65_000,
      });
      const statusCodeRaw = result.stdout.trim();
      const status = Number.parseInt(statusCodeRaw, 10);
      const body = await readFile(bodyFile, "utf-8");
      const headersRaw = await readFile(headersFile, "utf-8");
      const lastHeaderBlock = parseLastHeaderBlock(headersRaw);

      return {
        ok: status >= 200 && status < 300,
        status,
        headers: parseHeaderMap(lastHeaderBlock),
        async text() {
          return body;
        },
        async json() {
          return JSON.parse(body || "null");
        },
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

// ---------------------------------------------------------------------------
// Proxy-aware fetch factory
// ---------------------------------------------------------------------------

export function getProxyFetch(): ProxyFetch {
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (proxyUrl) {
    try {
      const { ProxyAgent, fetch: undiciFetch } = require("undici");
      const agent = new ProxyAgent(proxyUrl);
      return ((url: string, options: ProxyFetchOptions = {}) =>
        undiciFetch(url, { ...options, dispatcher: agent })) as ProxyFetch;
    } catch {
      return createCurlFetch();
    }
  }

  return async (url: string, options: ProxyFetchOptions = {}) => {
    const response = await fetch(url, options);
    return {
      ok: response.ok,
      status: response.status,
      headers: { get: (name: string) => response.headers.get(name) },
      text: () => response.text(),
      json: () => response.json(),
    };
  };
}

// ---------------------------------------------------------------------------
// Authenticated GitHub fetch + pagination
// ---------------------------------------------------------------------------

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": USER_AGENT,
  };
}

export async function ghFetch(
  url: string,
  token: string,
  proxyFetch: ProxyFetch,
  options: ProxyFetchOptions = {},
): Promise<ProxyFetchResponse> {
  return proxyFetch(url, {
    ...options,
    headers: { ...authHeaders(token), ...options.headers },
  });
}

export async function fetchAllPages<T>(
  url: string,
  token: string,
  proxyFetch: ProxyFetch,
): Promise<T[]> {
  const results: T[] = [];
  let nextUrl: string | null = url;

  while (nextUrl) {
    const response = await ghFetch(nextUrl, token, proxyFetch);
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    const data = (await response.json()) as T[];
    results.push(...data);

    const linkHeader = response.headers.get("link");
    nextUrl = null;
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch?.[1]) {
        nextUrl = nextMatch[1];
      }
    }
  }

  return results;
}
