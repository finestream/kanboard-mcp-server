// OAuth 2.1 resource server (docs/oauth.md) against the compose test instance
// and a test issuer: a local HTTP server that publishes OpenID Connect discovery
// and a JWKS, and signs tokens the way an identity provider does.
// Adapted from finestream/silverbullet-mcp-server (MIT).

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { discoverOAuthProtectedResourceMetadata, extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthProtectedResourceMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { startServer, connect, BEARERS, type RunningServer } from "./harness.ts";
import { PROJECTS } from "../lib/env.ts";

const RESOURCE = "http://localhost:4000/mcp";

let issuerServer: Server;
let ISSUER: string;
let key: CryptoKey;
let foreignKey: CryptoKey;
let server: RunningServer;
let discoveryRequests = 0;

const now = () => Math.floor(Date.now() / 1000);

const token = (claims: Record<string, unknown> = {}, signWith: CryptoKey = key) =>
  new SignJWT({ iss: ISSUER, aud: RESOURCE, exp: now() + 300, iat: now(), preferred_username: "alice", scope: "openid", typ: "Bearer", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-1", typ: "JWT" })
    .sign(signWith);

const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oauth-test", version: "0" } } });

const post = (url: string, bearer?: string) =>
  fetch(`${url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: INITIALIZE });

before(async () => {
  const pair = await generateKeyPair("RS256");
  key = pair.privateKey;
  foreignKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "test-1", alg: "RS256", use: "sig" };
  issuerServer = createServer((req, res) => {
    const send = (body: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/realms/test/.well-known/openid-configuration") {
      discoveryRequests++;
      return send({ issuer: ISSUER, jwks_uri: `${ISSUER}/certs`, authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token`, response_types_supported: ["code"] });
    }
    if (req.url === "/realms/test/certs") return send({ keys: [jwk] });
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => issuerServer.listen(0, "127.0.0.1", resolve));
  ISSUER = `http://127.0.0.1:${(issuerServer.address() as AddressInfo).port}/realms/test`;
  server = await startServer({ env: { MCP_OAUTH_ISSUER: ISSUER, MCP_OAUTH_RESOURCE: RESOURCE } });
});

after(async () => {
  await server?.stop();
  await new Promise((resolve) => issuerServer?.close(resolve));
});

test("metadata: served at both well-known paths, valid for the MCP SDK's client, naming the resource and the issuer", async () => {
  for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
    const res = await fetch(server.url + path);
    assert.equal(res.status, 200, path);
    const meta = OAuthProtectedResourceMetadataSchema.parse(await res.json());
    assert.equal(meta.resource, RESOURCE);
    assert.deepEqual(meta.authorization_servers, [ISSUER]);
  }
  assert.equal((await discoverOAuthProtectedResourceMetadata(`${server.url}/mcp`)).resource, RESOURCE);
  assert.equal((await fetch(`${server.url}/.well-known/oauth-protected-resource`, { method: "POST" })).status, 405);
});

test("challenge: no bearer gets 401 with the metadata URL; a bad token adds error=invalid_token and no reason", async () => {
  const none = await post(server.url);
  assert.equal(none.status, 401);
  assert.equal(none.headers.get("www-authenticate"), 'Bearer realm="kanboard-mcp-server", resource_metadata="http://localhost:4000/.well-known/oauth-protected-resource/mcp"');
  const bad = await post(server.url, await token({ aud: "https://other.example.org/mcp" }));
  assert.equal(bad.status, 401);
  assert.equal(extractWWWAuthenticateParams(bad).error, "invalid_token");
  assert.doesNotMatch(await bad.text(), /aud|audience/);
});

test("valid token: user A's token acts as A, with A's Kanboard user; static bearers keep working beside it", async () => {
  const alice = await connect(server.url, await token({ preferred_username: "alice" }));
  const bob = await connect(server.url, await token({ preferred_username: "Bob" }));
  const stat = await connect(server.url, BEARERS.carol);
  try {
    const me = await alice.call("get_me");
    assert.equal(me.isError, false, me.text);
    assert.equal(me.data!.username, "alice");
    assert.deepEqual((await bob.call("get_projects")).data!.projects.map((p: any) => p.name).sort(), [PROJECTS.alpha, PROJECTS.beta], "a user name in another case selects the only line that matches");
    assert.equal((await stat.call("get_me")).data!.username, "carol");
    assert.ok(server.logs.some((l) => l.includes('"tool":"get_me"') && l.includes('"user":"alice"')));
  } finally {
    await alice.close();
    await bob.close();
    await stat.close();
  }
  assert.equal(discoveryRequests, 1, "the issuer's metadata was read once");
});

test("rejected: wrong audience, expired, wrong issuer, another key and an unknown user all get 401 with the reason logged, not sent", async () => {
  const cases: Array<[string, string, RegExp]> = [
    ["wrong audience", await token({ aud: "https://other.example.org/mcp" }), /claim \\"aud\\"/],
    ["expired", await token({ exp: now() - 120 }), /expired/],
    ["wrong issuer", await token({ iss: "http://127.0.0.1:1/realms/other" }), /claim \\"iss\\"/],
    ["signed by another key", await token({}, foreignKey), /signature/i],
    ["unknown preferred_username", await token({ preferred_username: "nobody" }), /nobody\\" has no line in the credentials file/],
    ["no preferred_username", await token({ preferred_username: undefined }), /no \\"preferred_username\\" claim/],
  ];
  for (const [name, t, reason] of cases) {
    const before = server.logs.length;
    const res = await post(server.url, t);
    assert.equal(res.status, 401, name);
    assert.equal(extractWWWAuthenticateParams(res).error, "invalid_token", name);
    const line = server.logs.slice(before).find((l) => l.includes("auth.refused"));
    assert.match(line ?? "", reason, `${name}: the log says why`);
    assert.ok(!(line ?? "").includes(t), `${name}: the token is not logged`);
  }
});

test("scopes: a token without a required scope gets 403 insufficient_scope; the metadata and the challenge name the scope", async () => {
  const scoped = await startServer({ env: { MCP_OAUTH_ISSUER: ISSUER, MCP_OAUTH_RESOURCE: RESOURCE, MCP_OAUTH_SCOPES: "mcp:tools" } });
  try {
    const meta = (await (await fetch(`${scoped.url}/.well-known/oauth-protected-resource/mcp`)).json()) as { scopes_supported?: string[] };
    assert.deepEqual(meta.scopes_supported, ["mcp:tools"]);
    const without = await post(scoped.url, await token());
    assert.equal(without.status, 403);
    assert.equal(extractWWWAuthenticateParams(without).error, "insufficient_scope");
    const client = await connect(scoped.url, await token({ scope: "openid mcp:tools" }));
    assert.equal((await client.call("get_me")).isError, false);
    await client.close();
  } finally {
    await scoped.stop();
  }
});

test("without OAuth settings, or with the issuer unreachable: no metadata or 401, static bearers unchanged; a half configuration stops the start", async () => {
  const plain = await startServer();
  try {
    assert.equal((await fetch(`${plain.url}/.well-known/oauth-protected-resource`)).status, 404);
    const res = await post(plain.url, await token());
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), 'Bearer realm="kanboard-mcp-server"');
  } finally {
    await plain.stop();
  }
  const lonely = await startServer({ env: { MCP_OAUTH_ISSUER: "http://127.0.0.1:1/realms/none", MCP_OAUTH_RESOURCE: RESOURCE } });
  try {
    const stat = await connect(lonely.url, BEARERS.alice);
    assert.equal((await stat.call("get_me")).isError, false);
    await stat.close();
    assert.equal((await post(lonely.url, await token())).status, 401);
    assert.ok(lonely.logs.some((l) => l.includes("auth.refused") && l.includes("the issuer's metadata is not available")));
  } finally {
    await lonely.stop();
  }
  await assert.rejects(startServer({ env: { MCP_OAUTH_ISSUER: ISSUER } }), /needs both MCP_OAUTH_ISSUER and MCP_OAUTH_RESOURCE/);
  await assert.rejects(startServer({ env: { MCP_OAUTH_ISSUER: "http://login.example.org/realms/main", MCP_OAUTH_RESOURCE: RESOURCE } }), /must be an https URL/);
});
