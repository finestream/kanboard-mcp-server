# kanboard-mcp-server

An MCP server for a [Kanboard](https://kanboard.org) instance: several agents, each acting as its own Kanboard user through Kanboard's JSON-RPC API, with tools for what an agent does with tasks and nothing that changes a project's structure.

## Goals

1. **One Kanboard user per agent.** The server holds each agent's Kanboard API token and calls `/jsonrpc.php` as that user, so Kanboard's roles and project permissions decide what is allowed and Kanboard shows the agent as the author of every change. The agent never holds the Kanboard token.
2. **Three ways in**, beside each other: a static bearer for a local client, an OAuth 2.1 access token of an external identity provider ([docs/oauth.md](docs/oauth.md)), or the assertion of Cloudflare Access in front of the server, which lets hosted clients connect without Kanboard or the identity provider being reachable from the internet ([docs/cloudflare-access.md](docs/cloudflare-access.md)).
3. **Tools designed for agents:** tasks, search, comments, tags, internal links, subtasks, due dates with a time of day; dates as ISO 8601 in Kanboard's time zone; Kanboard's refusals passed on with their reason. No delete, no project, column, swimlane, category or user administration: those are a person's acts ([docs/security.md](docs/security.md)).
4. **Runs as a container next to Kanboard**, secrets from files, read-only root; the image is published on a version tag.
5. **MIT**, with code taken only from MIT, Apache or BSD sources.

It replaces a Kanboard plugin that serves MCP from inside Kanboard with a token in the request: a server of its own can authenticate the way hosted clients need, keeps Kanboard off the internet, and can be tested without Kanboard's PHP.

## Status

**0.1.0:** the server, the 24 tools, the three logins, unit and integration tests against a Kanboard test instance (`kanboard/kanboard:v1.2.57`), the image and the CI. Not yet run against a production Kanboard or a real identity provider or Access application; the two verifiers are the ones of [finestream/silverbullet-mcp](https://github.com/finestream/silverbullet-mcp), which has.

## What is here

| Path | What |
|---|---|
| [`docs/security.md`](docs/security.md) | The security model: terms, the credentials file, the three ways in, the tool surface, Kanboard's answers, the log |
| [`docs/oauth.md`](docs/oauth.md) | OAuth: what the server verifies, what the identity provider must do, connecting a client |
| [`docs/cloudflare-access.md`](docs/cloudflare-access.md) | Cloudflare Access in front of the server: what the server verifies, what the Access application must do, the route |
| [`src/`](src) | The server: `main.ts` (entry, `--hash`), `server.ts` (HTTP, auth), `oauth.ts` and `cf-access.ts` (the two verifiers), `kanboard.ts` (the JSON-RPC client), `tools.ts` (the tools), `format.ts` (dates, task fields), `credentials.ts`, `config.ts`; unit tests beside the code |
| [`config/credentials.example`](config/credentials.example) | The credentials file |
| [`test/`](test) | A compose test instance, its bootstrap, and the integration tests ([test/README.md](test/README.md)) |
| [`scripts/acceptance.ts`](scripts/acceptance.ts) | The acceptance test of a running server (*Acceptance test* below) |
| [`Dockerfile`](Dockerfile), [`compose.example.yaml`](compose.example.yaml) | The image (`node:24-alpine`, non-root) and how to run it next to Kanboard |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | Lint, unit and integration tests on every pull request; the image to `ghcr.io/finestream/kanboard-mcp-server` on a version tag |

## Run

Needs Node.js 24 or newer (it runs the `.ts` files directly) and a Kanboard reachable over HTTP.

```sh
npm install
KANBOARD_URL=http://127.0.0.1:8580 MCP_CREDENTIALS_FILE=./secrets/credentials node src/main.ts
```

The server listens on `PORT` (default 4000): `POST /mcp` is the MCP endpoint (streamable HTTP, stateless, bearer in the `Authorization` header), `GET /healthz` the health check, and, with OAuth configured, `GET /.well-known/oauth-protected-resource` its metadata. The image does the same: see [compose.example.yaml](compose.example.yaml). `printf '%s' "$SECRET" | node src/main.ts --hash` prints the SHA-256 of a client secret for the credentials file.

## Kanboard side

Each agent needs a Kanboard user (role *app-user* is enough) that is a *member* of the projects it works in, and that user's **personal API token**: in Kanboard, the user's profile, *API*, *Generate a new token*. The token, or the user's password, is the third field of the agent's line in the credentials file. With two-factor authentication on the user, only the token works. Three failed logins on the user API lock the user until it logs in through the form (Kanboard's rule), so a wrong token in the file is noticed quickly.

## Clients

The server speaks MCP over streamable HTTP: `POST https://<host>/mcp` with the client's bearer in the `Authorization` header.

```sh
claude mcp add --scope user --transport http kanboard https://kanboard-mcp.example.org/mcp --header "Authorization: Bearer $BEARER"   # Claude Code, static bearer
claude mcp add --scope user --transport http kanboard https://kanboard-mcp.example.org/mcp --client-id <client id> --callback-port 8765   # Claude Code, OAuth
```

Claude on the web, desktop and mobile: *Settings → Connectors → Add custom connector* with the server's public URL, path included; the login is the identity provider's ([docs/oauth.md](docs/oauth.md)) or Cloudflare Access's ([docs/cloudflare-access.md](docs/cloudflare-access.md)). A client that speaks only stdio reaches the server through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) with the bearer as a header.

## Acceptance test

`scripts/acceptance.ts` checks a running server from any machine that reaches it, as one agent, and prints `PASS` or `FAIL` per check: a wrong bearer is refused; `get_me` names the Kanboard user; the project is listed with its columns; a search answers with tags; with `MCP_TASK_ID` the task is read, and with `MCP_COMMENT=yes` a comment is added and changed; a project the user may not see is refused with Kanboard's 403.

```sh
npm ci
MCP_URL=https://kanboard-mcp.example.org/mcp MCP_BEARER=… MCP_PROJECT_ID=2 MCP_TASK_ID=42 node scripts/acceptance.ts
```

Exit code 0 when every check passed, 1 otherwise, 2 when the test could not run. Through Cloudflare Access a static bearer is not accepted: run it against the direct route.

## Configuration

One file and a few variables. The file is re-read when it changes and on `SIGHUP`.

| File | Variable | What |
|---|---|---|
| credentials (a secret) | `MCP_CREDENTIALS_FILE`, default `/run/secrets/credentials` | One line per agent: Kanboard user, its API token, the bearer hashes and, optionally, the e-mail addresses for Cloudflare Access ([example](config/credentials.example); [docs/security.md](docs/security.md), section 2) |

| Variable | Default | What |
|---|---|---|
| `KANBOARD_URL` | `http://kanboard` | Kanboard's base URL (or its `jsonrpc.php` endpoint) on the shared network |
| `KANBOARD_TIMEOUT` | `30s` | The most a call to Kanboard may take |
| `PORT` | `4000` | The listening port |
| `MCP_RATE_LIMIT` | `120` | Tool calls per agent and minute; `0` for none |
| `MCP_LOG_LEVEL` | `info` | `info` or `debug`; the log is JSON lines on stdout |
| `MCP_OAUTH_ISSUER`, `MCP_OAUTH_RESOURCE` | none | Both set: the server verifies OAuth access tokens of that issuer for that resource URL, beside static bearers ([docs/oauth.md](docs/oauth.md)) |
| `MCP_OAUTH_JWKS_URL`, `MCP_OAUTH_USER_CLAIM`, `MCP_OAUTH_SCOPES` | from the issuer; `preferred_username`; none | Where the issuer's keys are, which claim names the agent, which scopes a token must carry |
| `MCP_CF_ACCESS_TEAM_DOMAIN`, `MCP_CF_ACCESS_AUD` | none | Both set: a request that came through Cloudflare Access is authenticated by the assertion Access adds ([docs/cloudflare-access.md](docs/cloudflare-access.md)) |

## Tools

Every tool acts as the agent's Kanboard user. Ids come from the reading tools; dates are `YYYY-MM-DD` or `YYYY-MM-DD HH:MM` on the way in and ISO 8601 with Kanboard's time zone on the way out. Names follow the Kanboard MCP plugin where a tool does the same.

| Tool | What |
|---|---|
| `get_me` | The Kanboard user this connection acts as, and Kanboard's time zone |
| `get_projects` | The projects the user is a member of |
| `get_columns`, `get_swimlanes`, `get_categories`, `get_project_tags`, `get_users` | A project's columns, active swimlanes, categories, tags and members, with ids |
| `get_colors`, `get_link_labels` | Kanboard's task colours; the labels of internal links (a plain user gets the built-in defaults, and `source` says so) |
| `search_tasks` | Kanboard's [search syntax](https://docs.kanboard.org/v1/user/search/) on one project; up to 200 tasks, with tags |
| `get_task_details` | A task with tags, links, subtasks, attachments (names), its recurrence and, on request, comments |
| `get_task_comments` | The comments of a task, oldest first |
| `create_task` | Title, required priority, description, column, swimlane, category, colour, assignee, due date, tags, reference, recurrence |
| `update_task` | Title, description, category, colour, assignee, priority, reference, due and start date, recurrence |
| `move_task` | To a column (and swimlane) of its project, at a position |
| `assign_task`, `set_task_due_date`, `set_task_tags` | Assignee (0 for nobody); due date with or without time, `""` clears; tags added or, with `replace`, set |
| `add_task_comment`, `update_task_comment` | A comment as the user; the text of an own comment |
| `create_task_link`, `remove_task_link` | An internal link by label or id (Kanboard adds the opposite link); its removal |
| `create_subtask`, `update_subtask` | A subtask; its title, status (0 to do, 1 in progress, 2 done) or assignee |

### Recurring tasks

Kanboard keeps a task's recurrence on the task and creates the next task itself when the trigger fires. `create_task` and `update_task` take the fields with Kanboard's names and numbers, and the reading tools return them:

| Field | Values |
|---|---|
| `recurrence_status` | 0 off, 1 on; Kanboard sets 2 once the next task exists (read only) |
| `recurrence_trigger` | 0 moved out of the first column, 1 moved to the last column, 2 closed |
| `recurrence_factor`, `recurrence_timeframe` | The interval (1 or more) and its unit: 0 days, 1 months, 2 years |
| `recurrence_basedate` | What the interval is added to for the next due date: 0 the task's due date, 1 the date the trigger fires (the task still needs a due date) |
| `recurrence_parent`, `recurrence_child` | Read only: the task this one was created from, and the task created from this one |

A weekly task is `recurrence_status: 1, recurrence_trigger: 1, recurrence_factor: 7, recurrence_timeframe: 0, recurrence_basedate: 0` with a due date: `move_task` to the last column creates the next task in the first column, due a week later, with the same recurrence. `recurrence_status: 1` needs a due date and a `recurrence_factor` of 1 or more (given, or already on the task), and the other recurrence fields need status 1; all of these are refused otherwise. A task that already created its next task (it has a `recurrence_child`) cannot be set to status 1 again: change the recurrence on the child. `create_task` also refuses a trigger that cannot fire from the column given (trigger 0 outside the first column, trigger 1 in the last). `update_task` and `set_task_due_date` refuse to clear the due date of a repeating task. The tools do not close a task, so trigger 2 fires when a person or an automatic action closes it.

What a tool answers when Kanboard refuses, and why there is no delete: [docs/security.md](docs/security.md), sections 4 and 6.

## Tests

```sh
npm run lint                                          # eslint and tsc
npm run test:unit                                     # the credentials file, the configuration, the formatting, the client, the verifiers
npm run test:integration                              # starts and bootstraps this working copy's Kanboard instance, then runs the server against it: every tool, the two logins
node test/instance.ts down                            # removes the instance (down -v)
```

Details: [test/README.md](test/README.md).

## Licence

[MIT](LICENSE).

Code is taken only from MIT, Apache-2.0 or BSD-licensed projects and is credited here and in the file it lands in.

## Attributions

* [finestream/silverbullet-mcp](https://github.com/finestream/silverbullet-mcp) (MIT): the HTTP server, the credentials file, the OAuth and Cloudflare Access verifiers, the configuration watcher, the log and the test harness were taken from it, with the SilverBullet parts removed.
* [rtasarz/kanboard-mcp](https://github.com/rtasarz/kanboard-mcp) (MIT; from [ChristianJStarr/kanboard-mcp](https://github.com/ChristianJStarr/kanboard-mcp)): the Kanboard plugin whose tool names this server keeps where a tool does the same. No code was taken from it.
* [Kanboard's API documentation](https://docs.kanboard.org/v1/api/) for the procedures and their parameters.
