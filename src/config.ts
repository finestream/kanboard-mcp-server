// Configuration from the environment (README, "Configuration"): where Kanboard
// is, the credentials file, the rate limit, the log level, and the two optional
// logins beside static bearers. Secrets are files; nothing secret is read from a
// variable. `WatchedFile` is taken from finestream/silverbullet-mcp-server (MIT).

import { readFileSync, statSync, watchFile, unwatchFile } from "node:fs";
import { loadOAuthConfig, type OAuthConfig } from "./oauth.ts";
import { loadCfAccessConfig, type CfAccessConfig } from "./cf-access.ts";

export type Config = {
  /** Kanboard's JSON-RPC endpoint, `…/jsonrpc.php`. */
  kanboardUrl: string;
  port: number;
  credentialsFile: string;
  /** Milliseconds a call to Kanboard may take. */
  kanboardTimeout: number;
  /** Tool calls per user and minute; 0 means no limit. */
  rateLimit: number;
  logLevel: "debug" | "info";
  /** The OAuth resource server settings (docs/oauth.md); null means static bearers only. */
  oauth: OAuthConfig | null;
  /** Cloudflare Access in front of the server (docs/cloudflare-access.md); null means its assertions are not looked at. */
  cfAccess: CfAccessConfig | null;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    kanboardUrl: kanboardEndpoint(env.KANBOARD_URL ?? "http://kanboard"),
    port: Number(env.PORT ?? 4000),
    credentialsFile: env.MCP_CREDENTIALS_FILE ?? "/run/secrets/credentials",
    kanboardTimeout: parseDuration(env.KANBOARD_TIMEOUT ?? "30s"),
    rateLimit: Number(env.MCP_RATE_LIMIT ?? 120),
    logLevel: env.MCP_LOG_LEVEL === "debug" ? "debug" : "info",
    oauth: loadOAuthConfig(env),
    cfAccess: loadCfAccessConfig(env),
  };
}

/** `KANBOARD_URL` is Kanboard's base URL or its `jsonrpc.php` endpoint; either way the endpoint results. */
export function kanboardEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`KANBOARD_URL is not a URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`KANBOARD_URL must be an http or https URL: ${value}`);
  if (url.search || url.hash || url.username || url.password) throw new Error(`KANBOARD_URL must have no query, fragment or credentials: ${value}`);
  if (!url.pathname.endsWith("/jsonrpc.php")) url.pathname = url.pathname.replace(/\/+$/, "") + "/jsonrpc.php";
  return url.toString();
}

/** `0`, `30s`, `15m`, `2h`, `1d`, or plain seconds. */
export function parseDuration(text: string): number {
  const m = text.trim().match(/^(\d+)\s*(ms|s|m|h|d)?$/);
  if (!m) throw new Error(`not a duration: "${text}" (use 0, 30s, 15m, 2h or 1d)`);
  const n = Number(m[1]);
  return n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? "s"] as number);
}

/**
 * A configuration file parsed into a value, re-read when it changes on disk (polled, so that
 * bind-mounted secrets and symlinked files work alike). A file that cannot be read keeps the
 * last good value and records the problem.
 */
export class WatchedFile<T> {
  value: T | null = null;
  problems: string[] = [];
  present = false;
  private mtime = 0;
  private listeners: Array<() => void> = [];

  readonly path: string;
  private readonly parse: (text: string) => { value: T; problems: string[] };

  constructor(path: string, parse: (text: string) => { value: T; problems: string[] }) {
    this.path = path;
    this.parse = parse;
  }

  load(): this {
    try {
      const stat = statSync(this.path);
      this.mtime = stat.mtimeMs;
      const text = readFileSync(this.path, "utf8");
      const { value, problems } = this.parse(text);
      this.value = value;
      this.problems = problems;
      this.present = true;
    } catch (e) {
      this.present = false;
      this.problems = [`cannot read ${this.path}: ${(e as Error).message}`];
    }
    return this;
  }

  watch(intervalMs = 2000): this {
    watchFile(this.path, { interval: intervalMs }, (curr) => {
      if (curr.mtimeMs !== this.mtime || (curr.mtimeMs === 0) !== !this.present) {
        this.load();
        for (const l of this.listeners) l();
      }
    });
    return this;
  }

  onChange(listener: () => void): this {
    this.listeners.push(listener);
    return this;
  }

  close() {
    unwatchFile(this.path);
  }
}
