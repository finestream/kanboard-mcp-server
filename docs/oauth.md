# OAuth

Status: **built and tested against a test issuer** (2026-11-09); the verifier is the one of [finestream/silverbullet-mcp-server](https://github.com/finestream/silverbullet-mcp-server/blob/main/docs/oauth.md), where it has run against Keycloak since 2026-11-07.

The server can verify OAuth 2.1 access tokens beside the static bearers. It is a **resource server only**: an external authorization server (an OpenID Connect provider such as Keycloak) logs the user in and issues the token, the server checks it and looks the agent up in its credentials file. It runs no authorization server, stores no token and forwards none.

```
client ── authorization code + PKCE ──▶ authorization server (issuer)
client ── Bearer <access token> ──▶ MCP server ── Basic <kanboard-user>:<kanboard-api-token> ──▶ Kanboard /jsonrpc.php
                                     │
                                     ├─ verifies: signature (issuer's JWKS), iss, aud = resource, exp, scopes
                                     └─ credentials file: the token's user claim → the agent's line
```

## 1. What the server does

Off unless `MCP_OAUTH_ISSUER` and `MCP_OAUTH_RESOURCE` are both set. With them:

* **Metadata.** `GET /.well-known/oauth-protected-resource/mcp` and `GET /.well-known/oauth-protected-resource` answer the Protected Resource Metadata of [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728): the resource, the issuer as the only authorization server, the bearer method `header`, and the scopes if any are required.
* **Challenge.** A request to `/mcp` without a valid bearer gets `401` with `WWW-Authenticate: Bearer realm="kanboard-mcp-server", resource_metadata="…"`, and `error="invalid_token"` when a token was sent and refused. A token without a required scope gets `403` with `error="insufficient_scope"`. The reason goes to the log, never to the client, and never the token.
* **Verification** with [jose](https://github.com/panva/jose): the signature with the issuer's keys (asymmetric algorithms only); `iss` equals `MCP_OAUTH_ISSUER`; `aud` contains `MCP_OAUTH_RESOURCE` exactly ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)); `exp` in the future and `nbf` in the past with 30 seconds of tolerance; every scope of `MCP_OAUTH_SCOPES` in `scope`.
* **Keys.** From `MCP_OAUTH_JWKS_URL`, or from the `jwks_uri` of the issuer's metadata, looked for where MCP clients look and accepted only if it names the configured issuer. The look-up happens at the first token, so the server starts without the issuer; while the issuer cannot be reached, tokens get `401` and static bearers keep working.
* **User.** The claim `preferred_username` (or `MCP_OAUTH_USER_CLAIM`) selects the agent's line by its first field: exactly, or, when no line has that name, the only line that has it in another case (an identity provider may fold user names to lower case). A name without a line gets `401`.
* **Static bearers stay** for local clients without OAuth: a bearer is first looked up by its hash, then verified as a token.

| Variable | Default | What |
|---|---|---|
| `MCP_OAUTH_ISSUER` | none | The issuer identifier, as the tokens carry it in `iss`, for example `https://login.example.org/realms/main` |
| `MCP_OAUTH_RESOURCE` | none | This server's URL as the clients enter it, path included, for example `https://kanboard-mcp.example.org/mcp` |
| `MCP_OAUTH_JWKS_URL` | from the issuer's metadata | Where the issuer's keys are, when the server should reach them by another name than the public one |
| `MCP_OAUTH_USER_CLAIM` | `preferred_username` | The claim that names the agent's line in the credentials file |
| `MCP_OAUTH_SCOPES` | none | Scopes every token must carry, space- or comma-separated; advertised in the metadata and the challenge |

The URLs must be `https`; `http` is accepted for a loopback address only. A setting that cannot be right stops the server at start.

## 2. What the authorization server must do

1. **Put the resource into `aud`.** The access token's audience must contain `MCP_OAUTH_RESOURCE`. With Keycloak: a client scope with an *Audience* mapper whose *Included Custom Audience* is the resource URL, as a default scope of the client or an optional one the client asks for (`MCP_OAUTH_SCOPES` makes the server advertise it).
2. **Carry the user's name** in `preferred_username` (or the configured claim), equal to the agent's name in the credentials file, in any case.
3. **Sign with an asymmetric key**, publish it as a JWKS named in its metadata (RFC 8414 or OpenID Connect Discovery), with PKCE `S256` supported.
4. **Know the client**: a client registered by hand (the smallest surface; its redirect URIs are the clients'), dynamic registration, or Client ID Metadata Documents. The server takes no part in this.
5. **Be reachable by the client and by the server.** A client on the agent's own machine needs both from there; a hosted client reaches both from its vendor's network, or comes in through Cloudflare Access instead ([cloudflare-access.md](cloudflare-access.md)).

## 3. Connecting a client

The server's URL is `MCP_OAUTH_RESOURCE`, entered exactly, path included.

```sh
claude mcp add --scope user --transport http kanboard https://kanboard-mcp.example.org/mcp --client-id <client id> --callback-port 8765   # Claude Code
```

Then `/mcp` in a session, choose the server and *Authenticate*: the browser opens the issuer's login; `http://localhost:8765/callback` and `http://127.0.0.1:8765/callback` are the redirect URIs to allow for a client registered by hand. Claude on the web, desktop and mobile: *Settings → Connectors → Add custom connector* with the URL and, for a client registered by hand, the client ID; its redirect URI is `https://claude.ai/api/mcp/auth_callback`. The user logs in as the agent whose name is in the credentials file, not as the person who sets the connector up.

## 4. Tests

* `src/oauth.test.ts`: the verifier alone, with a local key: wrong audience, wrong issuer, expired, not yet valid, no expiry, another key, an unknown key, `alg: none`, an HMAC token keyed with the public key; scopes; the user claim; the metadata and the challenge; the configuration; the user look-up.
* `test/server/02-oauth.test.ts`: the server against the test Kanboard and a test issuer (a local HTTP server with discovery and a JWKS): the metadata checked with the MCP SDK's own client code; the challenge; a token for A acts as A's Kanboard user; every refusal with its logged reason; static bearers beside OAuth; scopes; the issuer unreachable; a wrong configuration.
