# Security model

Status: **implemented, tested against a Kanboard test instance** (2026-11-09).

## 1. Terms and threat model

* **Kanboard** is the task system; its users, roles and project permissions are the authority on what may be read or changed.
* An **agent** is a program (an MCP client, usually an AI assistant) that works with tasks. Each agent has its own Kanboard user, so Kanboard shows it as the author of what it did, and its own credentials towards this server.
* The **operator** runs the server and writes its credentials file.
* A **person** uses Kanboard's UI and decides what agents may not: a project's structure, deletion, and who is a member.

What the server protects against:

* **An agent acting as another.** Every request is authenticated to one line of the credentials file, and every call to Kanboard carries that line's Kanboard user and token. There is no shared or application-wide token.
* **An agent reaching Kanboard directly.** The agent never holds a Kanboard token; it holds a bearer for this server, an OAuth token of an identity provider, or a Cloudflare Access session. Revoking any of those does not touch the Kanboard token, and the Kanboard token can be rotated without the agent's client changing.
* **An agent doing more than its person meant.** The tool surface has no delete, no project, column, swimlane, category or action tool, no user administration (section 4). What the tools do is further bounded by Kanboard: a viewer cannot comment, a non-member sees nothing, a plain user cannot list users or link labels.
* **Guessing credentials.** Bearers are compared by hash in constant time; refused requests are rate-limited per address; the reason of a refusal goes to the log, never to the client.

What it does not protect against:

* **Kanboard's own permissions being too wide.** The server adds no permission model of its own; a Kanboard user that is a project manager can do through the tools what Kanboard lets a manager do with a task. Give agents the role *project member*.
* **A compromised server.** It holds every agent's Kanboard token in memory and reads the credentials file; whoever runs code in it acts as any agent.
* **Traffic seen by a proxy that ends TLS** (Cloudflare Access): the route's operator accepts that.

## 2. The credentials file

One line per agent, whitespace-separated ([`config/credentials.example`](../config/credentials.example)):

```
user   kanboard-user   kanboard-api-token   bearer-hashes   [emails]
```

* `user` is the agent's name here, what an OAuth token's user claim must carry ([oauth.md](oauth.md)).
* `kanboard-user` and `kanboard-api-token` are the Kanboard login name and that user's personal API token (or password); they form the HTTP Basic credentials of every call to `/jsonrpc.php`. Kanboard's own documentation: [API authentication](https://docs.kanboard.org/v1/api/authentication/).
* `bearer-hashes`: hex SHA-256 digests of the agent's static bearers, one per client, or `-`. The bearer itself is never stored.
* `emails`, optional: the addresses Cloudflare Access may sign the agent in with ([cloudflare-access.md](cloudflare-access.md)).

The file is a secret: mount it read-only from a secrets store (a compose secret). The server re-reads it when it changes and on `SIGHUP`. **A file with a problem** (a duplicate user, a malformed hash, an address on two lines, a wrong field count) **is not used at all**: `/healthz` answers 503 and nobody is authenticated until it is corrected. The problems are logged (`config.problems`), never served.

## 3. Three ways in

Every request to `/mcp` is authenticated by exactly one of these, in this order; the first that applies decides.

1. **A Cloudflare Access assertion** (`Cf-Access-Jwt-Assertion`), when `MCP_CF_ACCESS_TEAM_DOMAIN` and `MCP_CF_ACCESS_AUD` are set: verified (signature, issuer, audience, expiry), its `email` claim selects the line that names the address. A request with an assertion is decided by the assertion alone; a bearer beside it is ignored. [cloudflare-access.md](cloudflare-access.md).
2. **A static bearer** (`Authorization: Bearer …`): its SHA-256 selects the line that holds that hash.
3. **An OAuth access token**, when `MCP_OAUTH_ISSUER` and `MCP_OAUTH_RESOURCE` are set: verified (signature through the issuer's keys, issuer, audience = the resource URL, expiry, scopes), its user claim selects the line with that name. [oauth.md](oauth.md).

After that nothing differs: the tools are registered for that line's Kanboard user, the rate limit (`MCP_RATE_LIMIT`, per agent and minute) applies, and the request log names the agent.

## 4. The tool surface

The tools read and write **tasks**: search, details, create, update, move, assign, due date, tags, comments, internal links, subtasks; and read what a task refers to: projects, columns, swimlanes, categories, tags, members, colours, link labels (README, *Tools*).

Not offered, on purpose: deleting or closing a task, creating or changing projects, columns, swimlanes, categories, automatic actions, users or memberships, moving a task to another project, files. These are a person's acts in Kanboard's UI. An agent that needs one asks in a comment.

Every write goes to Kanboard as the agent's user, so Kanboard's activity stream and the comment's author show who did it; a comment's `user_id` is always the connected user's (Kanboard refuses any other).

## 5. Input and output

* Ids are checked to be positive integers, dates to be `YYYY-MM-DD` or `YYYY-MM-DD HH:MM` (Kanboard answers `false` to a date it cannot read; the server says why first), texts are bounded in length.
* What Kanboard returns is passed on with ids and counts as numbers, timestamps as ISO 8601 in Kanboard's time zone and `0` dates as null; `getMe`'s secret-bearing fields (token, two-factor secret, fingerprint) are never returned.
* A search returns at most 200 tasks and says when it was cut.

## 6. Kanboard's answers

| Kanboard | The tool |
|---|---|
| 401 | "Kanboard refused the credentials of user … (401)": the line's token is stale |
| 403 | "Kanboard refused … (403 Forbidden)": no permission, or no such task, project or object (Kanboard does not tell them apart) |
| `false` on a write | "Kanboard did not apply …" with a hint at the likely cause |
| no answer | "Kanboard did not answer …" |

The client sees these messages as tool errors; the log line (`request`, `outcome`) says the same without the text.

## 7. The log

One JSON object per line on stdout. `request` lines: agent, tool, outcome (`ok`, `refused:input`, `refused:kanboard`, `error`), milliseconds, a short detail on a refusal. `auth.refused` lines: the connecting address and the reason. Never a token, a bearer, an assertion, or a task's contents.
