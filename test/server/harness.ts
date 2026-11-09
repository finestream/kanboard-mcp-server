// Runs the server against the compose test instance for the integration tests:
// writes a credentials file into a temporary directory, spawns `node
// src/main.ts`, waits for its "listening" line, and gives the tests an MCP
// client per bearer. Taken from finestream/silverbullet-mcp (MIT).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { KB_URL, PASSWORDS } from "../lib/env.ts";
import { sha256hex } from "../../src/credentials.ts";

export const BEARERS = { alice: "alice-client-secret", bob: "bob-client-secret", carol: "carol-client-secret", mallory: "mallory-client-secret" };

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The credentials file of the fixtures: alice, bob and carol with their passwords as tokens, and mallory, whose line names alice's Kanboard user with a wrong token. */
export function credentialsFile(opts: { emails?: Record<string, string> } = {}): string {
  const e = (u: string) => (opts.emails?.[u] ? ` ${opts.emails[u]}` : "");
  return [
    `alice   alice ${PASSWORDS.alice} ${sha256hex(BEARERS.alice)}${e("alice")}`,
    `bob     bob   ${PASSWORDS.bob}   ${sha256hex(BEARERS.bob)}${e("bob")}`,
    `carol   carol ${PASSWORDS.carol} ${sha256hex(BEARERS.carol)}${e("carol")}`,
    `mallory alice not-alices-token  ${sha256hex(BEARERS.mallory)}${e("mallory")}`,
  ].join("\n") + "\n";
}

export type ServerOptions = { credentials?: string; env?: Record<string, string> };

export type RunningServer = {
  url: string;
  dir: string;
  process: ChildProcess;
  logs: string[];
  stop(): Promise<void>;
  waitFor(event: string, timeoutMs?: number): Promise<Record<string, unknown>>;
};

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const dir = mkdtempSync(join(tmpdir(), "kbmcp-test-"));
  writeFileSync(join(dir, "credentials"), opts.credentials ?? credentialsFile());
  const env = { ...process.env, KANBOARD_URL: KB_URL, PORT: "0", MCP_CREDENTIALS_FILE: join(dir, "credentials"), ...opts.env };
  const child = spawn(process.execPath, [join(ROOT, "src/main.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
  const logs: string[] = [];
  const waiters: Array<{ event: string; resolve: (f: Record<string, unknown>) => void }> = [];
  let buffer = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      logs.push(line);
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(line);
      } catch {}
      if (parsed) for (const w of [...waiters]) if (w.event === parsed.event) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(parsed);
      }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  const waitFor = (event: string, timeoutMs = 30_000) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no "${event}" within ${timeoutMs} ms; log:\n${logs.join("\n")}`)), timeoutMs);
      waiters.push({ event, resolve: (f) => { clearTimeout(timer); resolve(f); } });
    });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const listening = await Promise.race([waitFor("listening"), exited.then(() => { throw new Error(`server exited; log:\n${logs.join("\n")}`); })]);
  const url = `http://127.0.0.1:${listening.port}`;
  return {
    url,
    dir,
    process: child,
    logs,
    waitFor,
    async stop() {
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type ToolResult = { text: string; data: Record<string, any> | undefined; isError: boolean };

export type McpClient = {
  call(tool: string, args?: Record<string, unknown>): Promise<ToolResult>;
  tools(): Promise<string[]>;
  close(): Promise<void>;
};

/** An MCP client that sends `bearer` in the Authorization header, or, given headers, exactly those. */
export async function connect(url: string, bearer: string | Record<string, string>): Promise<McpClient> {
  const client = new Client({ name: "integration-test", version: "0" });
  const headers = typeof bearer === "string" ? { Authorization: `Bearer ${bearer}` } : bearer;
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers } });
  await client.connect(transport);
  return {
    async call(tool, args = {}) {
      const r = (await client.callTool({ name: tool, arguments: args })) as { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, any>; isError?: boolean };
      return { text: r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n"), data: r.structuredContent, isError: r.isError === true };
    },
    async tools() {
      return (await client.listTools()).tools.map((t) => t.name).sort();
    },
    close: () => client.close(),
  };
}

export const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
