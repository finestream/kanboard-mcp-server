// The instance the tests run against (test/compose.yaml) and its fixtures. The
// administrator is the image's default; the bootstrap creates the rest:
//
//   user   password              Alpha            Beta
//   alice  alice-test-password   project-member   -
//   bob    bob-test-password     project-viewer   project-member
//   carol  carol-test-password   -                -
//
// A user's password is what the credentials file holds as that user's token:
// Kanboard takes a password or a personal API token as the Basic password alike.

import { readFileSync } from "node:fs";
import { Kanboard, type KanboardAuth } from "../../src/kanboard.ts";

/** The URL `node test/instance.ts up` wrote for this working copy (test/.state/env), if it ran. */
function stateUrl(): string | undefined {
  try {
    return readFileSync(new URL("../.state/env", import.meta.url), "utf8").match(/^KB_URL=(.+)$/m)?.[1];
  } catch {
    return undefined;
  }
}

export const KB_URL = process.env.KB_URL ?? stateUrl() ?? "http://127.0.0.1:8580/jsonrpc.php";
export const ADMIN: KanboardAuth = { username: process.env.KB_ADMIN_USER ?? "admin", token: process.env.KB_ADMIN_PASSWORD ?? "admin" };
export const PASSWORDS = { alice: "alice-test-password", bob: "bob-test-password", carol: "carol-test-password" } as const;
export type Fixture = keyof typeof PASSWORDS;
export const PROJECTS = { alpha: "Alpha", beta: "Beta" } as const;

export const kb = new Kanboard(KB_URL);
export const as = (user: Fixture): KanboardAuth => ({ username: user, token: PASSWORDS[user] });

/** The id of a fixture project, looked up by name as the administrator. */
export async function projectId(name: string): Promise<number> {
  const p = await kb.call<{ id: number | string } | null>(ADMIN, "getProjectByName", { name });
  if (!p) throw new Error(`no project "${name}": run node test/bootstrap.ts`);
  return Number(p.id);
}

export async function userId(username: string): Promise<number> {
  const u = await kb.call<{ id: number | string } | null>(ADMIN, "getUserByName", { username });
  if (!u) throw new Error(`no user "${username}": run node test/bootstrap.ts`);
  return Number(u.id);
}
