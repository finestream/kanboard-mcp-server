// The tools against the compose test instance (test/README.md): each agent acts
// as its own Kanboard user, Kanboard's permissions decide, and every tool
// returns what the README promises.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, connect, BEARERS, unique, type RunningServer, type McpClient } from "./harness.ts";
import { ADMIN, kb, projectId, PROJECTS, userId } from "../lib/env.ts";
import { TOOL_NAMES } from "../../src/tools.ts";

let server: RunningServer;
let alice: McpClient;
let bob: McpClient;
let carol: McpClient;
let alpha: number;
let beta: number;
let aliceId: number;
let bobId: number;
const created: number[] = [];

const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tools-test", version: "0" } } });
const post = (url: string, headers: Record<string, string> = {}) =>
  fetch(`${url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: INITIALIZE });

before(async () => {
  [alpha, beta, aliceId, bobId] = await Promise.all([projectId(PROJECTS.alpha), projectId(PROJECTS.beta), userId("alice"), userId("bob")]);
  server = await startServer();
  alice = await connect(server.url, BEARERS.alice);
  bob = await connect(server.url, BEARERS.bob);
  carol = await connect(server.url, BEARERS.carol);
});

after(async () => {
  await alice?.close();
  await bob?.close();
  await carol?.close();
  await server?.stop();
  // The fixtures' tasks are removed by the administrator: the tools have no delete.
  for (const id of created) await kb.call(ADMIN, "removeTask", { task_id: id }).catch(() => {});
});

const ok = (r: { isError: boolean; text: string; data: any }) => {
  assert.equal(r.isError, false, r.text);
  return r.data!;
};

test("surface: exactly the documented tools, and nothing that changes structure or deletes a task", async () => {
  const names = await alice.tools();
  assert.deepEqual(names, ([...TOOL_NAMES] as string[]).sort());
  for (const forbidden of ["delete_task", "remove_task", "create_project", "create_column", "update_column", "create_swimlane", "create_action", "remove_project", "move_task_to_project"]) {
    assert.ok(!names.includes(forbidden), forbidden);
  }
});

test("identity: each bearer acts as its own Kanboard user, and sees only its projects", async () => {
  const me = ok(await alice.call("get_me"));
  assert.equal(me.username, "alice");
  assert.equal(me.id, aliceId);
  assert.equal(me.role, "app-user");
  assert.equal(me.timezone, "UTC");
  assert.deepEqual(ok(await alice.call("get_projects")).projects.map((p: any) => p.name), [PROJECTS.alpha]);
  assert.deepEqual(ok(await bob.call("get_projects")).projects.map((p: any) => p.name).sort(), [PROJECTS.alpha, PROJECTS.beta]);
  assert.deepEqual(ok(await carol.call("get_projects")).projects, []);
  assert.ok(server.logs.some((l) => l.includes('"tool":"get_projects"') && l.includes('"user":"carol"')), "the request log names the agent");
});

test("structure: columns, swimlanes, categories, tags, members and colours of a project", async () => {
  const columns = ok(await alice.call("get_columns", { project_id: alpha })).columns;
  assert.deepEqual(columns.map((c: any) => c.title), ["Backlog", "Ready", "Work in progress", "Done"]);
  assert.equal(typeof columns[0].id, "number");
  const lanes = ok(await alice.call("get_swimlanes", { project_id: alpha })).swimlanes;
  assert.equal(lanes.length, 1);
  assert.deepEqual(ok(await alice.call("get_categories", { project_id: alpha })).categories, []);
  const users = ok(await alice.call("get_users", { project_id: alpha })).users;
  assert.ok(users.some((u: any) => u.id === aliceId && u.name === "Alice"), JSON.stringify(users));
  assert.ok(users.some((u: any) => u.id === bobId), "the viewer is a member too");
  const colors = ok(await alice.call("get_colors")).colors;
  assert.ok(colors.some((c: any) => c.id === "yellow" && c.name === "Yellow"));
  const labels = ok(await alice.call("get_link_labels"));
  assert.equal(labels.source, "built-in defaults", "a plain user may not list Kanboard's labels");
  assert.ok(labels.labels.some((l: any) => l.label === "is a child of" && l.id === 6));
  // Carol is no member of alpha: Kanboard refuses, and the tool says so without inventing a reason.
  const refused = await alice.call("get_columns", { project_id: beta });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /403 Forbidden.*user "alice" has no permission/);
});

test("tasks: create (priority required, tags created, due date with time), read with tags, search with tags", async () => {
  const title = unique("Tools task");
  const missing = await alice.call("create_task", { project_id: alpha, title });
  assert.equal(missing.isError, true, "priority is required");
  assert.match(missing.text, /priority/);
  const made = ok(await alice.call("create_task", { project_id: alpha, title, priority: 2, description: "A **task**", tags: ["urgent", unique("area")], date_due: "2026-11-20 14:30", owner_id: aliceId }));
  created.push(made.task_id);
  assert.equal(typeof made.task_id, "number");
  assert.match(made.url, /\/task\/\d+$/);

  const t = ok(await alice.call("get_task_details", { task_id: made.task_id }));
  assert.equal(t.title, title);
  assert.equal(t.description, "A **task**");
  assert.equal(t.priority, 2);
  assert.equal(t.owner_id, aliceId);
  assert.equal(t.is_active, true);
  assert.equal(t.date_due, "2026-11-20T14:30:00+00:00");
  assert.equal(t.date_completed, null);
  assert.equal(t.tags.length, 2);
  assert.ok(t.tags.includes("urgent"));
  assert.deepEqual(t.links, []);
  assert.deepEqual(t.subtasks, []);
  assert.deepEqual(t.attachments, []);
  assert.equal("comments" in t, false);

  const found = ok(await alice.call("search_tasks", { project_id: alpha, query: `status:open assignee:me tag:"urgent"` }));
  const hit = found.tasks.find((x: any) => x.id === made.task_id);
  assert.ok(hit, found.text);
  assert.equal(hit.column_name, "Backlog");
  assert.equal(hit.assignee_username, "alice");
  assert.ok(hit.tags.includes("urgent"), "search results carry tags");
  assert.equal(found.truncated, false);
  const none = ok(await alice.call("search_tasks", { project_id: alpha, query: "status:closed id:" + made.task_id }));
  assert.equal(none.count, 0);
  const bad = await alice.call("create_task", { project_id: alpha, title: "x", priority: 1, date_due: "next week" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /"next week" is not a date for date_due/);
});

test("tasks: update, move, assign, due date (set, with time, cleared, refused), tags added and replaced", async () => {
  const id = ok(await alice.call("create_task", { project_id: alpha, title: unique("Mutable"), priority: 3 })).task_id;
  created.push(id);
  const columns = ok(await alice.call("get_columns", { project_id: alpha })).columns;
  const wip = columns.find((c: any) => c.title === "Work in progress");

  const upd = ok(await alice.call("update_task", { task_id: id, title: "Renamed", priority: 1, description: "new text" }));
  assert.deepEqual(upd.changed, ["title", "description", "priority"]);
  const nothing = await alice.call("update_task", { task_id: id });
  assert.match(nothing.text, /Nothing to change/);

  const moved = ok(await alice.call("move_task", { task_id: id, column_id: wip.id }));
  assert.equal(moved.column_id, wip.id);
  assert.equal(moved.from_column_id, columns[0].id);
  const badMove = await alice.call("move_task", { task_id: id, column_id: 999999 });
  assert.equal(badMove.isError, true);
  assert.match(badMove.text, /did not apply moving task/);

  ok(await alice.call("assign_task", { task_id: id, user_id: aliceId }));
  assert.equal(ok(await alice.call("get_task_details", { task_id: id })).owner_id, aliceId);
  ok(await alice.call("assign_task", { task_id: id, user_id: 0 }));
  assert.equal(ok(await alice.call("get_task_details", { task_id: id })).owner_id, 0);
  const viewer = await alice.call("assign_task", { task_id: id, user_id: bobId });
  assert.equal(viewer.isError, true, "a viewer cannot be assigned");
  assert.match(viewer.text, /did not apply assigning task/);

  assert.equal(ok(await alice.call("set_task_due_date", { task_id: id, due_date: "2026-12-01" })).date_due?.slice(0, 10), "2026-12-01");
  assert.equal(ok(await alice.call("set_task_due_date", { task_id: id, due_date: "2026-12-01 09:15" })).date_due, "2026-12-01T09:15:00+00:00");
  assert.equal(ok(await alice.call("set_task_due_date", { task_id: id, due_date: "" })).date_due, null, "an empty string clears the due date");
  const badDate = await alice.call("set_task_due_date", { task_id: id, due_date: "01.12.2026" });
  assert.equal(badDate.isError, true);
  assert.match(badDate.text, /not a date for due_date/);

  assert.deepEqual(ok(await alice.call("set_task_tags", { task_id: id, tags: ["b-tag", "a-tag"] })).tags, ["a-tag", "b-tag"]);
  assert.deepEqual(ok(await alice.call("set_task_tags", { task_id: id, tags: ["c-tag"] })).tags, ["a-tag", "b-tag", "c-tag"], "tags are added by default");
  assert.deepEqual(ok(await alice.call("set_task_tags", { task_id: id, tags: ["c-tag"], replace: true })).tags, ["c-tag"], "replace: true sets the list");
  const detail = ok(await alice.call("get_task_details", { task_id: id }));
  assert.equal(detail.title, "Renamed");
  assert.equal(detail.column_id, wip.id);
});

test("comments: added as the connected user, updated by its author only, listed oldest first", async () => {
  const id = ok(await alice.call("create_task", { project_id: alpha, title: unique("Commented"), priority: 3 })).task_id;
  created.push(id);
  const first = ok(await alice.call("add_task_comment", { task_id: id, comment: "**Journal:** about to start\n\n— test" })).comment_id;
  ok(await alice.call("add_task_comment", { task_id: id, comment: "second" }));
  const list = ok(await alice.call("get_task_comments", { task_id: id })).comments;
  assert.equal(list.length, 2);
  assert.equal(list[0].id, first);
  assert.equal(list[0].username, "alice");
  assert.equal(list[0].user_id, aliceId);
  assert.match(list[0].date_creation, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
  ok(await alice.call("update_task_comment", { comment_id: first, comment: "**Journal:** done" }));
  const withComments = ok(await alice.call("get_task_details", { task_id: id, include_comments: true }));
  assert.equal(withComments.comments[0].comment, "**Journal:** done");
  // bob is a viewer of alpha: he reads the task and its comments, but Kanboard lets him write nothing.
  assert.equal(ok(await bob.call("get_task_details", { task_id: id })).title, withComments.title);
  const viewer = await bob.call("add_task_comment", { task_id: id, comment: "as a viewer" });
  assert.equal(viewer.isError, true);
  assert.match(viewer.text, /403 Forbidden.*user "bob" has no permission/);
  const notAuthor = await bob.call("update_task_comment", { comment_id: first, comment: "hijack" });
  assert.equal(notAuthor.isError, true);
  // carol is no member: the task does not exist for her.
  const outsider = await carol.call("get_task_details", { task_id: id });
  assert.equal(outsider.isError, true);
  assert.match(outsider.text, /403 Forbidden/);
});

test("links and subtasks: a link by label with its opposite on the other task, removal, subtasks created and updated", async () => {
  const parent = ok(await alice.call("create_task", { project_id: alpha, title: unique("Parent"), priority: 2 })).task_id;
  const child = ok(await alice.call("create_task", { project_id: alpha, title: unique("Child"), priority: 2 })).task_id;
  created.push(parent, child);
  const unknown = await alice.call("create_task_link", { task_id: child, opposite_task_id: parent, label: "is a kid of" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /No link label "is a kid of". Known labels: "relates to"/);
  const neither = await alice.call("create_task_link", { task_id: child, opposite_task_id: parent });
  assert.match(neither.text, /Give the link's label or its link_id/);
  const link = ok(await alice.call("create_task_link", { task_id: child, opposite_task_id: parent, label: "Is a Child Of" }));
  assert.equal(link.link_id, 6);
  assert.equal(link.label, "Is a Child Of");
  const childLinks = ok(await alice.call("get_task_details", { task_id: child })).links;
  assert.equal(childLinks.length, 1);
  assert.equal(childLinks[0].label, "is a child of");
  assert.equal(childLinks[0].task_id, parent);
  const parentLinks = ok(await alice.call("get_task_details", { task_id: parent })).links;
  assert.equal(parentLinks[0].label, "is a parent of");
  assert.equal(parentLinks[0].task_id, child);
  ok(await alice.call("remove_task_link", { task_link_id: childLinks[0].id }));
  assert.deepEqual(ok(await alice.call("get_task_details", { task_id: child })).links, []);
  const byId = ok(await alice.call("create_task_link", { task_id: child, opposite_task_id: parent, link_id: 1 }));
  assert.equal(byId.label, "relates to");

  const sub = ok(await alice.call("create_subtask", { task_id: parent, title: "step 1" })).subtask_id;
  ok(await alice.call("create_subtask", { task_id: parent, title: "step 2", status: 1 }));
  ok(await alice.call("update_subtask", { subtask_id: sub, task_id: parent, status: 2, title: "step 1 (done)" }));
  const subtasks = ok(await alice.call("get_task_details", { task_id: parent })).subtasks;
  assert.deepEqual(subtasks.map((s: any) => [s.title, s.status, s.status_name]), [["step 1 (done)", 2, "Done"], ["step 2", 1, "In progress"]]);
});

test("refusals: a stale Kanboard token, no bearer, an unknown bearer, and the health check", async () => {
  const mallory = await connect(server.url, BEARERS.mallory);
  try {
    const r = await mallory.call("get_projects");
    assert.equal(r.isError, true);
    assert.match(r.text, /Kanboard refused the credentials of user "alice" \(401\): the token on this user's line/);
  } finally {
    await mallory.close();
  }
  const none = await post(server.url);
  assert.equal(none.status, 401);
  assert.equal(none.headers.get("www-authenticate"), 'Bearer realm="kanboard-mcp-server"');
  assert.equal((await post(server.url, { Authorization: "Bearer not-a-bearer" })).status, 401);
  assert.ok(server.logs.some((l) => l.includes("auth.refused") && l.includes("unknown bearer")));
  const health = await fetch(`${server.url}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys((await health.json()) as object).sort(), ["ok", "version"]);
  assert.equal((await fetch(`${server.url}/other`)).status, 404);
  assert.equal((await fetch(`${server.url}/mcp`)).status, 405);
});

test("credentials file: a problem in it means nobody is served until it is corrected, and a change is picked up", async () => {
  const broken = await startServer({ credentials: "alice alice x -\nalice alice y -\n" });
  try {
    assert.equal((await fetch(`${broken.url}/healthz`)).status, 503);
    assert.ok(broken.logs.some((l) => l.includes("config.problems") && l.includes("appears twice")));
    assert.equal((await post(broken.url, { Authorization: `Bearer ${BEARERS.alice}` })).status, 401);
  } finally {
    await broken.stop();
  }
});
