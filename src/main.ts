// Entry point. `node src/main.ts` runs the server; `--hash` prints the SHA-256
// of a client bearer read from stdin, for the credentials file.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { loadConfig, WatchedFile, type Config } from "./config.ts";
import { parseCredentials, sha256hex, type Credentials } from "./credentials.ts";
import { Kanboard } from "./kanboard.ts";
import { log } from "./log.ts";
import { accessOr, bearerOrOAuth, createHttpServer, staticBearerAuth } from "./server.ts";
import { OAuthVerifier } from "./oauth.ts";
import { CfAccessVerifier } from "./cf-access.ts";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/** Loads the credentials file and wires the parts. */
export function buildApp(config: Config) {
  log.setLevel(config.logLevel);
  const kb = new Kanboard(config.kanboardUrl, config.kanboardTimeout);
  const credentials = new WatchedFile<Credentials>(config.credentialsFile, (t) => {
    const r = parseCredentials(t);
    return { value: r.credentials, problems: r.problems };
  });
  credentials.load().onChange(() => {
    log.info("config.reloaded", { file: credentials.path, users: credentials.value?.users.size ?? 0 });
    if (credentials.problems.length) log.warn("config.problems", { file: credentials.path, problems: credentials.problems });
  });
  if (credentials.problems.length) log.warn("config.problems", { file: credentials.path, problems: credentials.problems });
  return { config, kb, credentials, version };
}

async function serve(config: Config) {
  const app = buildApp(config);
  log.info("start", { version, kanboardUrl: config.kanboardUrl, port: config.port, rateLimit: config.rateLimit, users: app.credentials.value?.users.size ?? 0 });
  app.credentials.watch();

  // A file with a problem is not used at all: nobody is authenticated until it is corrected.
  const configured = () => ({ ok: app.credentials.present && app.credentials.problems.length === 0, problems: app.credentials.problems });
  const credentials = () => (configured().ok ? app.credentials.value : null);
  const oauth = config.oauth ? new OAuthVerifier(config.oauth) : null;
  if (oauth) log.info("oauth", { issuer: oauth.config.issuer, resource: oauth.config.resource, userClaim: oauth.config.userClaim, scopes: oauth.config.scopes, metadata: oauth.metadataUrl() });
  const cfAccess = config.cfAccess ? new CfAccessVerifier(config.cfAccess) : null;
  if (cfAccess) log.info("cf-access", { teamDomain: cfAccess.config.issuer, aud: cfAccess.config.audience, certs: cfAccess.certsUrl() });
  const bearers = oauth ? bearerOrOAuth(credentials, oauth) : staticBearerAuth(credentials);
  const server = createHttpServer({
    auth: cfAccess ? accessOr(credentials, cfAccess, bearers, log) : bearers,
    oauth,
    cfAccess: cfAccess !== null,
    context: () => ({ kb: app.kb, log }),
    log,
    rateLimit: config.rateLimit,
    version,
    configured,
  });
  server.listen(config.port, () => {
    const address = server.address();
    log.info("listening", { port: typeof address === "object" && address ? address.port : config.port });
  });

  process.on("SIGHUP", () => {
    log.info("sighup");
    app.credentials.load();
    if (app.credentials.problems.length) log.warn("config.problems", { file: app.credentials.path, problems: app.credentials.problems });
  });
  const shutdown = () => {
    log.info("stop");
    app.credentials.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

const mode = process.argv[2];
if (mode === "--hash") {
  const secret = readFileSync(0, "utf8").replace(/\r?\n$/, "");
  process.stdout.write(sha256hex(secret) + "\n");
} else if (mode === undefined) {
  await serve(loadConfig());
} else {
  console.error(`usage: node src/main.ts [--hash]`);
  process.exit(2);
}
