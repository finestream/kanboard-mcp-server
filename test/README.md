# Tests

Three layers:

* **Unit tests** beside the code (`src/*.test.ts`): the credentials file, the configuration, the date and task formatting, the JSON-RPC client against a local stand-in, the two token verifiers with local keys. `npm run test:unit`; no Kanboard needed.
* **Integration tests** (`test/server/*.test.ts`): the server as a child process against a real Kanboard, one MCP client per agent. `01-tools` covers every tool and Kanboard's permission answers; `02-oauth` and `03-cf-access` the two logins against a local issuer and a local team domain, so no identity provider and no Cloudflare account is needed.
* **The acceptance test** (`scripts/acceptance.ts`) against a deployed server, from any machine that reaches it (README, *Acceptance test*).

## The test instance

[`instance.ts`](instance.ts) starts the instance of this working copy: `node test/instance.ts up|down|env`. The compose project name and the port come from the working copy, so two working copies never share an instance:

| Working copy | Project | Port |
| --- | --- | --- |
| branch `claude/task-<id>-…` | `kbmcp-test-<id>` | `10000+<id>` |
| another linked worktree | `kbmcp-test-<hash of the path>` | 20000-39999 |
| a plain clone, and CI | `kbmcp-test` | 8580 |

`COMPOSE_PROJECT_NAME` and `KB_PORT` in the environment win. `up` starts the instance, writes `test/.state/env` (git-ignored, this working copy only; `lib/env.ts` reads the URL from it), and runs the bootstrap. `npm run test:integration` runs `up` first.

[`compose.yaml`](compose.yaml) runs a plain Kanboard (`kanboard/kanboard:v1.2.57` unless `KB_IMAGE` says otherwise) with its SQLite database on `http://127.0.0.1:$KB_PORT`. The image's administrator is `admin` / `admin`.

[`bootstrap.ts`](bootstrap.ts) creates the fixtures through the user API as the administrator, idempotently: the users `alice`, `bob` and `carol` (role `app-user`) and the projects `Alpha` (alice member, bob viewer) and `Beta` (bob member). A user's password is what the credentials file holds as that user's token: Kanboard takes a password or a personal API token as the Basic password alike, and a token cannot be generated through the API.

```sh
node test/instance.ts up      # idempotent
npm run test:integration
node test/instance.ts down    # removes the instance and its volume (down -v)
```

An instance outlives the test run; remove it with `down` when the working copy is finished.

The tests create tasks in `Alpha` with unique titles and remove them afterwards as the administrator (the tools have no delete). `KB_URL` (default: the state file), `KB_ADMIN_USER` and `KB_ADMIN_PASSWORD` point the tests at another instance.
