// Creates the fixtures of test/lib/env.ts on the test instance, idempotently,
// through the user API as the administrator (the application token of a fresh
// Kanboard is random; the administrator's password is known). Started by
// `node test/instance.ts up`, which also tells it the instance (KB_URL).

import { ADMIN, kb, PASSWORDS, PROJECTS } from "./lib/env.ts";

const ROLES: Record<string, Record<string, string>> = {
  [PROJECTS.alpha]: { alice: "project-member", bob: "project-viewer" },
  [PROJECTS.beta]: { bob: "project-member" },
};

async function waitForKanboard() {
  for (let i = 0; i < 60; i++) {
    try {
      return await kb.call<string>(ADMIN, "getVersion");
    } catch (e) {
      if (i === 59) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

const version = await waitForKanboard();
const users = new Map<string, number>();
for (const [username, password] of Object.entries(PASSWORDS)) {
  const existing = await kb.call<{ id: number | string } | null>(ADMIN, "getUserByName", { username });
  const id = existing ? Number(existing.id) : Number(await kb.call(ADMIN, "createUser", { username, password, name: username === "carol" ? "" : username[0].toUpperCase() + username.slice(1), role: "app-user" }));
  users.set(username, id);
}
const projects = new Map<string, number>();
for (const name of Object.values(PROJECTS)) {
  const existing = await kb.call<{ id: number | string } | null>(ADMIN, "getProjectByName", { name });
  const id = existing ? Number(existing.id) : Number(await kb.call(ADMIN, "createProject", { name }));
  projects.set(name, id);
  for (const [username, role] of Object.entries(ROLES[name] ?? {})) {
    const current = await kb.call<string | false>(ADMIN, "getProjectUserRole", { project_id: id, user_id: users.get(username) });
    if (current === role) continue;
    if (current) await kb.call(ADMIN, "changeProjectUserRole", { project_id: id, user_id: users.get(username), role });
    else await kb.call(ADMIN, "addProjectUser", { project_id: id, user_id: users.get(username), role });
  }
}
console.log(`Kanboard ${version}: users ${[...users].map(([u, id]) => `${u}=${id}`).join(" ")}; projects ${[...projects].map(([p, id]) => `${p}=${id}`).join(" ")}`);
