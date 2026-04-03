import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Header parsing (for curl responses)
// ---------------------------------------------------------------------------

function parseHeaders(rawHeaders: string): [string, string][] {
  const entries: [string, string][] = [];
  for (const line of rawHeaders.split(/\r?\n/).filter(Boolean)) {
    const idx = line.indexOf(":");
    if (idx !== -1) {
      entries.push([line.slice(0, idx).trim(), line.slice(idx + 1).trim()]);
    }
  }
  return entries;
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

function createCurlFetch(): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";

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
      method,
      "--write-out",
      "%{http_code}",
    ];

    if (init?.headers) {
      const headers =
        init.headers instanceof Headers
          ? Object.fromEntries(init.headers.entries())
          : Array.isArray(init.headers)
            ? Object.fromEntries(init.headers)
            : (init.headers as Record<string, string>);
      for (const [key, value] of Object.entries(headers)) {
        args.push("--header", `${key}: ${value}`);
      }
    }
    if (init?.body) {
      args.push("--data", typeof init.body === "string" ? init.body : JSON.stringify(init.body));
    }

    args.push(String(url));

    try {
      const result = spawnSync("curl", args, {
        encoding: "utf-8",
        timeout: 65_000,
      });
      if (result.error) {
        throw new Error(`curl failed to start: ${result.error.message}`);
      }
      if (result.status !== 0) {
        const stderr = String(result.stderr).trim();
        throw new Error(
          `curl exited with status ${String(result.status)}${stderr ? `: ${stderr}` : ""}`,
        );
      }
      const statusCodeRaw = String(result.stdout).trim();
      const status = Number.parseInt(statusCodeRaw, 10);
      if (!statusCodeRaw || Number.isNaN(status)) {
        throw new Error("curl did not return a valid HTTP status code");
      }
      const body = await readFile(bodyFile, "utf-8");
      const headersRaw = await readFile(headersFile, "utf-8");
      const lastHeaderBlock = parseLastHeaderBlock(headersRaw);

      return new Response(body, {
        status,
        headers: parseHeaders(lastHeaderBlock),
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }) as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Proxy-aware fetch factory (returns standard fetch or undefined for default)
// ---------------------------------------------------------------------------

export function getProxyAwareFetch(): typeof globalThis.fetch | undefined {
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (!proxyUrl) {
    return undefined;
  }

  try {
    const { ProxyAgent, fetch: undiciFetch } = require("undici");
    const agent = new ProxyAgent(proxyUrl);
    return ((url: string | URL | Request, init?: RequestInit) =>
      undiciFetch(url, { ...init, dispatcher: agent })) as typeof globalThis.fetch;
  } catch {
    return createCurlFetch();
  }
}
