// Cloudflare Access in front of the server (docs/cloudflare-access.md) against
// the compose test instance and a test team domain: a local HTTP server that
// publishes signing keys where a team domain does and signs assertions the way
// Access does. Adapted from finestream/silverbullet-mcp-server (MIT).

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { startServer, connect, credentialsFile, BEARERS, type RunningServer } from "./harness.ts";
import { PROJECTS } from "../lib/env.ts";

const AUD = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";
const RESOURCE = "http://localhost:4000/mcp";
const HEADER = "Cf-Access-Jwt-Assertion";

/** alice and bob have an address, carol has none. */
const CREDENTIALS = () => credentialsFile({ emails: { alice: "alice@example.org,a.liddell@example.org", bob: "bob@example.org" } });

let teamServer: Server;
let TEAM: string;
let key: CryptoKey;
let foreignKey: CryptoKey;
let server: RunningServer;
let certRequests = 0;

const now = () => Math.floor(Date.now() / 1000);

const assertion = (claims: Record<string, unknown> = {}, signWith: CryptoKey = key) =>
  new SignJWT({ aud: [AUD], email: "alice@example.org", exp: now() + 300, iat: now(), nbf: now(), iss: TEAM, type: "app", identity_nonce: "n0nce", sub: "7335d417-61da-459d-899c-0a01c76a2f94", country: "CH", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "access-1", typ: "JWT" })
    .sign(signWith);

const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "access-test", version: "0" } } });

const post = (url: string, headers: Record<string, string> = {}) =>
  fetch(`${url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: INITIALIZE });

before(async () => {
  const pair = await generateKeyPair("RS256");
  key = pair.privateKey;
  foreignKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "access-1", alg: "RS256", use: "sig" };
  teamServer = createServer((req, res) => {
    if (req.url === "/cdn-cgi/access/certs") {
      certRequests++;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ keys: [jwk], public_cert: { kid: "access-1", cert: "-----BEGIN CERTIFICATE-----" }, public_certs: [{ kid: "access-1", cert: "-----BEGIN CERTIFICATE-----" }] }));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => teamServer.listen(0, "127.0.0.1", resolve));
  TEAM = `http://127.0.0.1:${(teamServer.address() as AddressInfo).port}`;
  server = await startServer({ credentials: CREDENTIALS(), env: { MCP_CF_ACCESS_TEAM_DOMAIN: TEAM, MCP_CF_ACCESS_AUD: AUD } });
});

after(async () => {
  await server?.stop();
  await new Promise((resolve) => teamServer?.close(resolve));
});

test("valid assertion: an assertion for A's address acts as A's Kanboard user; a second address and another case select the same line", async () => {
  const alice = await connect(server.url, { [HEADER]: await assertion() });
  const bob = await connect(server.url, { [HEADER]: await assertion({ email: "bob@example.org" }) });
  try {
    const me = await alice.call("get_me");
    assert.equal(me.isError, false, me.text);
    assert.equal(me.data!.username, "alice");
    assert.deepEqual((await bob.call("get_projects")).data!.projects.map((p: any) => p.name).sort(), [PROJECTS.alpha, PROJECTS.beta]);
    assert.ok(server.logs.some((l) => l.includes('"tool":"get_me"') && l.includes('"user":"alice"')), "the request log names the agent");
  } finally {
    await alice.close();
    await bob.close();
  }
  for (const email of ["a.liddell@example.org", "Alice@Example.ORG"]) {
    const client = await connect(server.url, { [HEADER]: await assertion({ email }) });
    try {
      assert.equal((await client.call("get_me")).data!.username, "alice", email);
    } finally {
      await client.close();
    }
  }
  assert.equal(certRequests, 1, "the team domain's keys were read once");
});

test("rejected: wrong audience, wrong issuer, expired, unsigned, another key, an unknown address and a service token get 401 without a pointer to an authorization server", async () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64({ aud: [AUD], email: "alice@example.org", exp: now() + 300, iss: TEAM })}.`;
  const cases: Array<[string, string, RegExp]> = [
    ["wrong audience", await assertion({ aud: ["f".repeat(64)] }), /claim \\"aud\\"/],
    ["wrong issuer", await assertion({ iss: "http://127.0.0.1:1" }), /claim \\"iss\\"/],
    ["expired", await assertion({ exp: now() - 120 }), /Access assertion: expired/],
    ["unsigned", unsigned, /Access assertion/],
    ["signed by another key", await assertion({}, foreignKey), /signature/i],
    ["an address without a line", await assertion({ email: "mallory@example.org" }), /no line of the credentials file has the e-mail address \\"mallory@example.org\\"/],
    ["a service token: no e-mail address", await assertion({ email: undefined, sub: "", common_name: "0123456789abcdef.access" }), /no \\"email\\" claim/],
  ];
  for (const [name, a, reason] of cases) {
    const before = server.logs.length;
    const res = await post(server.url, { [HEADER]: a });
    assert.equal(res.status, 401, name);
    assert.equal(res.headers.get("www-authenticate"), 'Bearer realm="kanboard-mcp-server", error="invalid_token"', name);
    assert.doesNotMatch(await res.text(), /aud|iss|expired|mallory|credentials/, `${name}: the reason is logged, not sent`);
    const line = server.logs.slice(before).find((l) => l.includes("auth.refused"));
    assert.match(line ?? "", reason, `${name}: the log says why`);
    assert.ok(!(line ?? "").includes(a), `${name}: the assertion is not logged`);
  }
});

test("the assertion decides alone: a refused assertion is not rescued by a valid bearer, and a bearer beside a valid assertion is not looked at", async () => {
  assert.equal((await post(server.url, { [HEADER]: await assertion({ email: "mallory@example.org" }), Authorization: `Bearer ${BEARERS.alice}` })).status, 401);
  const client = await connect(server.url, { [HEADER]: await assertion({ email: "bob@example.org" }), Authorization: "Bearer an-opaque-token-of-access" });
  try {
    assert.equal((await client.call("get_me")).data!.username, "bob");
  } finally {
    await client.close();
  }
});

test("static bearers are unchanged beside it, and beside OAuth a request through Access is never pointed at the issuer", async () => {
  const stat = await connect(server.url, BEARERS.carol);
  try {
    assert.equal((await stat.call("get_me")).data!.username, "carol", "carol has no address and still her bearer");
  } finally {
    await stat.close();
  }
  assert.equal((await post(server.url)).headers.get("www-authenticate"), 'Bearer realm="kanboard-mcp-server"');
  assert.equal((await fetch(`${server.url}/.well-known/oauth-protected-resource`)).status, 404);

  const both = await startServer({ credentials: CREDENTIALS(), env: { MCP_CF_ACCESS_TEAM_DOMAIN: TEAM, MCP_CF_ACCESS_AUD: AUD, MCP_OAUTH_ISSUER: "http://127.0.0.1:1/realms/none", MCP_OAUTH_RESOURCE: RESOURCE } });
  try {
    const none = await post(both.url);
    assert.equal(extractWWWAuthenticateParams(none).resourceMetadataUrl?.href, "http://localhost:4000/.well-known/oauth-protected-resource/mcp", "without an assertion: the OAuth challenge");
    const refused = await post(both.url, { [HEADER]: await assertion({ email: "mallory@example.org" }) });
    assert.equal(refused.headers.get("www-authenticate"), 'Bearer realm="kanboard-mcp-server", error="invalid_token"', "with an assertion: no resource_metadata");
    assert.equal((await fetch(`${both.url}/.well-known/oauth-protected-resource/mcp`, { headers: { [HEADER]: await assertion() } })).status, 404, "the metadata is not served to a request through Access");
    const access = await connect(both.url, { [HEADER]: await assertion() });
    try {
      assert.equal((await access.call("get_me")).data!.username, "alice");
    } finally {
      await access.close();
    }
  } finally {
    await both.stop();
  }
});

test("without the Access settings the header is not looked at; with the team domain unreachable assertions get 401 and bearers work; a half configuration or a shared address stops serving", async () => {
  const plain = await startServer({ credentials: CREDENTIALS() });
  try {
    const res = await post(plain.url, { [HEADER]: await assertion() });
    assert.equal(res.status, 401);
    assert.ok(plain.logs.some((l) => l.includes("auth.refused") && l.includes("no bearer")));
  } finally {
    await plain.stop();
  }
  const lonely = await startServer({ credentials: CREDENTIALS(), env: { MCP_CF_ACCESS_TEAM_DOMAIN: "http://127.0.0.1:1", MCP_CF_ACCESS_AUD: AUD } });
  try {
    const stat = await connect(lonely.url, BEARERS.alice);
    assert.equal((await stat.call("get_me")).isError, false);
    await stat.close();
    assert.equal((await post(lonely.url, { [HEADER]: await assertion() })).status, 401);
  } finally {
    await lonely.stop();
  }
  await assert.rejects(startServer({ env: { MCP_CF_ACCESS_TEAM_DOMAIN: TEAM } }), /needs both MCP_CF_ACCESS_TEAM_DOMAIN and MCP_CF_ACCESS_AUD/);
  const twice = await startServer({ credentials: credentialsFile({ emails: { alice: "shared@example.org", bob: "shared@example.org" } }), env: { MCP_CF_ACCESS_TEAM_DOMAIN: TEAM, MCP_CF_ACCESS_AUD: AUD } });
  try {
    assert.ok(twice.logs.some((l) => l.includes("config.problems") && l.includes("e-mail address already used by")));
    assert.equal((await post(twice.url, { [HEADER]: await assertion({ email: "shared@example.org" }) })).status, 401);
    assert.equal((await fetch(`${twice.url}/healthz`)).status, 503);
  } finally {
    await twice.stop();
  }
});
