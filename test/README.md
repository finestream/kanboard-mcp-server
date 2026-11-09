# Tests

Three layers:

* **Unit tests** beside the code (`src/*.test.ts`): the credentials file, the configuration, the date and task formatting, the JSON-RPC client against a local stand-in, the two token verifiers with local keys. `npm run test:unit`; no Kanboard needed.
* **Integration tests** (`test/server/*.test.ts`): the server as a child process against a real Kanboard, one MCP client per agent. `01-tools` covers every tool and Kanboard's permission answers; `02-oauth` and `03-cf-access` the two logins against a local issuer and a local team domain, so no identity provider and no Cloudflare account is needed.
* **The acceptance test** (`scripts/acceptance.ts`) against a deployed server, from any machine that reaches it (README, *Acceptance test*).

## The test instance

[`compose.yaml`](compose.yaml) runs a plain Kanboard (`kanboard/kanboard:v1.2.57` unless `KB_IMAGE` says otherwise) with its SQLite database on `http://127.0.0.1:8580` (`KB_PORT`). The image's administrator is `admin` / `admin`.

[`bootstrap.ts`](bootstrap.ts) creates the fixtures through the user API as the administrator, idempotently: the users `alice`, `bob` and `carol` (role `app-user`) and the projects `Alpha` (alice member, bob viewer) and `Beta` (bob member). A user's password is what the credentials file holds as that user's token: Kanboard takes a password or a personal API token as the Basic password alike, and a token cannot be generated through the API.

```sh
docker compose -f test/compose.yaml up -d --wait
node test/bootstrap.ts
npm run test:integration
docker compose -f test/compose.yaml down -v
```

The tests create tasks in `Alpha` with unique titles and remove them afterwards as the administrator (the tools have no delete). `KB_URL`, `KB_ADMIN_USER` and `KB_ADMIN_PASSWORD` point the tests at another instance.
