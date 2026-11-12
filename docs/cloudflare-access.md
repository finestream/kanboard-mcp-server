# Cloudflare Access

Status: **built and tested against a test team domain** (2026-11-09); the verifier is the one of [finestream/silverbullet-mcp-server](https://github.com/finestream/silverbullet-mcp-server/blob/main/docs/cloudflare-access.md), which has served hosted MCP clients through a real Access application since 2026-11-07.

A third way in, beside static bearers and OAuth tokens ([oauth.md](oauth.md)), for a server published through [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/): Access logs the user in and lets a request through only then, and the server takes the agent from the assertion Access adds to the request. With Access's [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/), Access is also the OAuth authorization server a hosted MCP client needs, so neither Kanboard nor an identity provider has to be reachable from the internet.

```
client ── OAuth (Managed OAuth) ──▶ Cloudflare Access: logs the user in, issues its own token
client ── Bearer <Access's token> ──▶ Cloudflare edge ══ tunnel ══▶ MCP server ── Basic <kanboard-user>:<token> ──▶ Kanboard
                                       │                             │
                                       └─ adds the signed assertion  ├─ verifies: signature (team domain's keys), iss, aud = AUD tag, exp
                                          Cf-Access-Jwt-Assertion    └─ credentials file: the assertion's e-mail address → the agent's line
```

## 1. What the server does

Off unless `MCP_CF_ACCESS_TEAM_DOMAIN` and `MCP_CF_ACCESS_AUD` are both set. With them:

* **A request with a `Cf-Access-Jwt-Assertion` header came through Access, and the assertion alone decides who it is.** A bearer on the same request is not looked at: a refused assertion is never rescued by another way in. A request without the header did not come through Access and is authenticated as before.
* **Verification** with [jose](https://github.com/panva/jose), as Cloudflare's [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) asks: the signature with the team domain's keys from `https://<team domain>/cdn-cgi/access/certs` (`RS256` only); `iss` equals the team domain; `aud` contains the application's AUD tag; `exp` in the future and `nbf` in the past, with 30 seconds of tolerance. The unsigned `Cf-Access-Authenticated-User-Email` header is not used.
* **Keys** are fetched at the first assertion, so the server starts without the team domain, and again when an assertion names an unknown key, at most every 30 seconds.
* **User.** The assertion's `email` claim selects the line of the credentials file that names that address in its fifth field, in any case. A line may name several addresses; an address on two lines is a problem in the file, and the server refuses to serve until it is corrected. An address without a line gets `401`; an assertion without an address (a service token) selects nobody.
* **Two lists decide together.** The Access policy says which addresses may log in; the credentials file says which of them is an agent of this server.
* **What it answers on that route.** A refused assertion gets `401` with `WWW-Authenticate: Bearer realm="kanboard-mcp-server", error="invalid_token"` and no `resource_metadata`: where a client of that route logs in is Access's to say. The server's own Protected Resource Metadata answers `404` to a request that carries an assertion. The reason of a refusal goes to the log, never to the client, and never the assertion.

| Variable | Default | What |
|---|---|---|
| `MCP_CF_ACCESS_TEAM_DOMAIN` | none | The team domain, `<team>.cloudflareaccess.com` (with or without `https://`) |
| `MCP_CF_ACCESS_AUD` | none | The *Application Audience (AUD) Tag* of the Access application in front of the server |

## 2. What Access must do

1. **A self-hosted application** for the server's public host name, with **Managed OAuth** on if hosted MCP clients are to connect; its AUD tag goes into `MCP_CF_ACCESS_AUD`. An application of its own per MCP server keeps the AUD tags apart and lets one be switched off alone.
2. **A policy that allows exactly the addresses that have a line** in the credentials file: one address per agent.
3. **A login method those addresses can complete** (with the one-time PIN, the address must receive mail; an agent's address can be forwarded to the person who sets its connector up).
4. **Allowed redirect URIs** for the clients: for Claude on the web, desktop and mobile `https://claude.ai/api/mcp/auth_callback`.
5. **Short lifetimes.** The server cannot revoke an assertion; what bounds a leaked token is Access's token lifetime and session duration, and what ends an agent's access is revoking its session, the policy, or the address on its line.

## 3. The route

* **Publish `/mcp` and nothing else.** With a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/), the public host name's route can be limited to that path; `/healthz` and the OAuth metadata stay inside. Kanboard itself is never published: the tunnel's route points at this server, which reaches Kanboard on the internal network.
* **Let the tunnel require Access too** (*Protect with Access*, with the team name and the AUD tag), so that a request without an assertion is refused by `cloudflared` before the server sees it, should the Access application ever be removed while the tunnel stays.
* **A client of that host name always goes through Access.** A client that is to use a static bearer or the OAuth issuer of [oauth.md](oauth.md) reaches the server by another route (an internal host name).
* **Cloudflare sees the traffic.** Access and the tunnel end TLS at Cloudflare's edge.

## 4. Connecting a client

**Claude on the web, desktop and mobile:** *Settings → Connectors → Add custom connector*, with the public URL, path included (`https://kanboard-mcp.example.org/mcp`). No client ID: the client registers itself with Access. *Connect* opens Access's login; log in with the address of the agent the connector is to act as.

## 5. Tests

* `src/cf-access.test.ts`: the verifier alone, with a local key: wrong audience, wrong issuer, expired, not yet valid, no expiry, another key, an unknown key, `alg: none`, an HMAC assertion, another algorithm; no address; the configuration.
* `test/server/03-cf-access.test.ts`: the server against the test Kanboard and a test team domain (a local HTTP server that publishes keys at `/cdn-cgi/access/certs` and signs assertions): an assertion for A acts as A's Kanboard user; every refusal with its logged reason and without a pointer to an authorization server; the assertion decides alone; static bearers and the OAuth challenge unchanged beside it; the header ignored without the settings; the team domain unreachable; a wrong configuration.
* Not tested here: a real client's login through Managed OAuth and its requests through a tunnel. They need the deployment.
