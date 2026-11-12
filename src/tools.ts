// The tool surface (README, "Tools"), registered per request for the
// authenticated agent. Every tool calls Kanboard's JSON-RPC API as that agent's
// own Kanboard user, so Kanboard's roles and project permissions decide what is
// allowed and every write is attributed to that user. The tools cover what an
// agent does with tasks: read, search, create, update, move, assign, tag,
// comment, link, subtasks. Nothing here changes a project's structure or
// deletes a task: those are a person's acts in the Kanboard UI.
// Tool names follow the Kanboard MCP plugin (rtasarz/kanboard-mcp, MIT) where
// the tool does the same, so prompts written for it keep working.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Credential } from "./credentials.ts";
import { Kanboard, KanboardError, type KanboardAuth } from "./kanboard.ts";
import { RECURRENCE_WRITABLE, commentView, dateInput, fileView, isoAt, linkView, subtaskView, tagNames, taskView } from "./format.ts";
import type { Log } from "./log.ts";

/** The Kanboard user behind the agent, and Kanboard's time zone, as `getMe` and `getTimezone` tell them. */
export type Me = { id: number; username: string; name: string; role: string; timezone: string };

const ME_TTL = 10 * 60_000;

/** `Me` per agent, 10 minutes; nothing else is cached, so a task is always read fresh. */
export class MeCache {
  private readonly entries = new Map<string, { me: Me; expires: number }>();

  get(user: string): Me | null {
    const e = this.entries.get(user);
    return e && e.expires > Date.now() ? e.me : null;
  }
  set(user: string, me: Me) {
    this.entries.set(user, { me, expires: Date.now() + ME_TTL });
  }
}

export type Context = {
  user: Credential;
  kb: Kanboard;
  log: Log;
  me: MeCache;
};

/** A refusal by the server itself (bad input) or by Kanboard; the message says which. */
export class Refusal extends Error {
  readonly control: "input" | "kanboard";

  constructor(control: Refusal["control"], message: string) {
    super(message);
    this.name = "Refusal";
    this.control = control;
  }
}

/**
 * Kanboard's built-in link labels, with the ids of a fresh installation. A plain user may not
 * list them (`getAllLinks` is for managers), so a tool falls back to these and says so.
 */
export const DEFAULT_LINK_LABELS: Array<{ id: number; label: string; opposite_id: number }> = [
  { id: 1, label: "relates to", opposite_id: 0 },
  { id: 2, label: "blocks", opposite_id: 3 },
  { id: 3, label: "is blocked by", opposite_id: 2 },
  { id: 4, label: "duplicates", opposite_id: 5 },
  { id: 5, label: "is duplicated by", opposite_id: 4 },
  { id: 6, label: "is a child of", opposite_id: 7 },
  { id: 7, label: "is a parent of", opposite_id: 6 },
  { id: 8, label: "targets milestone", opposite_id: 9 },
  { id: 9, label: "is a milestone of", opposite_id: 8 },
  { id: 10, label: "fixes", opposite_id: 11 },
  { id: 11, label: "is fixed by", opposite_id: 10 },
];

export const TOOL_NAMES = [
  "get_me", "get_projects", "get_columns", "get_swimlanes", "get_categories", "get_project_tags", "get_users", "get_colors", "get_link_labels",
  "search_tasks", "get_task_details", "get_task_comments",
  "create_task", "update_task", "move_task", "assign_task", "set_task_due_date", "set_task_tags",
  "add_task_comment", "update_task_comment", "create_task_link", "remove_task_link", "create_subtask", "update_subtask",
] as const;

type Raw = Record<string, unknown>;

const result = (data: Record<string, unknown>): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data });
const failure = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

const id = (what: string) => z.number().int().positive().describe(what);
const text = (what: string, max = 100_000) => z.string().max(max).describe(what);
const DATE_HELP = "YYYY-MM-DD or YYYY-MM-DD HH:MM, in Kanboard's time zone";

/**
 * A task's recurrence, with Kanboard's field names and numbers. Kanboard creates the next task
 * when the trigger fires and then sets the status to 2 itself, so 2 is not accepted here.
 */
const RECURRENCE = {
  recurrence_status: z.number().int().min(0).max(1).describe("Recurrence: 0 = off, 1 = on (Kanboard creates the next task when the trigger fires)"),
  recurrence_trigger: z.number().int().min(0).max(2).describe("What creates the next task: 0 = moved out of the first column, 1 = moved to the last column, 2 = closed"),
  recurrence_factor: z.number().int().min(1).max(10_000).describe("The interval, in units of recurrence_timeframe: the next task is due this long after the base date (7 with timeframe 0 = weekly)"),
  recurrence_timeframe: z.number().int().min(0).max(2).describe("Unit of the interval: 0 = days, 1 = months, 2 = years"),
  recurrence_basedate: z.number().int().min(0).max(1).describe("Base date of the next due date: 0 = this task's due date, 1 = the date the trigger fires"),
};
const RECURRENCE_SCHEMA = z.object(RECURRENCE).partial();
const OTHER_KEYS = RECURRENCE_WRITABLE.filter((k) => k !== "recurrence_status");
type Recurrence = z.infer<typeof RECURRENCE_SCHEMA>;

/** The largest search result returned; Kanboard has no paging on `searchTasks`. */
const SEARCH_LIMIT = 200;

export function registerTools(server: McpServer, ctx: Context) {
  const { user, kb, log } = ctx;
  const auth: KanboardAuth = { username: user.kanboardUser, token: user.token };

  const kanboardFailure = (e: KanboardError, what: string): Refusal => {
    if (e.unauthorized) return new Refusal("kanboard", `Kanboard refused the credentials of user "${user.kanboardUser}" (401): the token on this user's line of the credentials file is not accepted. Nothing was done.`);
    if (e.forbidden) return new Refusal("kanboard", `Kanboard refused ${what} (403 Forbidden): user "${user.kanboardUser}" has no permission for it, or the task, project or object named does not exist. Nothing was done.`);
    return new Refusal("kanboard", `${what} failed: ${e.message}`);
  };

  /** One call; a Kanboard error becomes a refusal that names what was attempted. */
  const call = async <T = unknown>(what: string, method: string, params?: Raw): Promise<T> => {
    try {
      return await kb.call<T>(auth, method, params);
    } catch (e) {
      if (e instanceof KanboardError) throw kanboardFailure(e, what);
      throw e;
    }
  };

  /** A write that Kanboard answers with `true` or `false`: `false` is a refusal with the hint. */
  const apply = async (what: string, method: string, params: Raw, hint: string) => {
    const ok = await call<unknown>(what, method, params);
    if (ok !== true) throw new Refusal("kanboard", `Kanboard did not apply ${what} (it answered ${JSON.stringify(ok)}). ${hint}`);
  };

  /** A create that Kanboard answers with the new id, or `false`. */
  const created = async (what: string, method: string, params: Raw, hint: string): Promise<number> => {
    const r = await call<unknown>(what, method, params);
    const n = typeof r === "number" ? r : typeof r === "string" && /^\d+$/.test(r) ? Number(r) : null;
    if (n === null || n <= 0) throw new Refusal("kanboard", `Kanboard did not apply ${what} (it answered ${JSON.stringify(r)}). ${hint}`);
    return n;
  };

  const me = async (): Promise<Me> => {
    const cached = ctx.me.get(user.user);
    if (cached) return cached;
    const [who, zone] = await (async () => {
      try {
        return await kb.batch(auth, [{ method: "getMe" }, { method: "getTimezone" }]);
      } catch (e) {
        if (e instanceof KanboardError) throw kanboardFailure(e, "reading the user");
        throw e;
      }
    })();
    if (who instanceof KanboardError) throw kanboardFailure(who, "reading the user");
    const w = who as Raw;
    const value: Me = {
      id: Number(w.id),
      username: String(w.username ?? user.kanboardUser),
      name: typeof w.name === "string" ? w.name : "",
      role: String(w.role ?? ""),
      timezone: typeof zone === "string" && zone ? zone : "UTC",
    };
    ctx.me.set(user.user, value);
    return value;
  };

  const zone = async () => (await me()).timezone;

  const task = async (taskId: number): Promise<Raw> => {
    const t = await call<Raw | null>(`reading task ${taskId}`, "getTask", { task_id: taskId });
    if (!t) throw new Refusal("kanboard", `Kanboard has no task ${taskId} that user "${user.kanboardUser}" may see.`);
    return t;
  };

  const dateOrRefuse = (field: string, value: string): string => {
    if (value === "") return "";
    const d = dateInput(value);
    if (!d) throw new Refusal("input", `"${value}" is not a date for ${field}: use ${DATE_HELP} (for example 2026-11-20 or 2026-11-20 14:30).`);
    return d;
  };

  /**
   * The rules a repeating task must meet, for create_task (nothing stored yet) and for update_task and
   * set_task_due_date (the stored task as `now`). Without them Kanboard accepts the settings and then
   * repeats wrongly or not at all. `column_id` is where the task is (undefined: the first column, on create).
   */
  const checkRecurrence = async (a: Recurrence, now: { subject: string; project_id: number; column_id?: number; status: number; trigger: number; factor: number; child: number; due: boolean }) => {
    const status = a.recurrence_status ?? now.status;
    const others = OTHER_KEYS.filter((k) => a[k] !== undefined);
    // A child that was deleted since no longer blocks: Kanboard would create the next task again.
    // Kanboard answers 403 for a task that does not exist, to a user who is not an administrator.
    const exists = async (taskId: number) => {
      try {
        return !!(await kb.call<Raw | null>(auth, "getTask", { task_id: taskId }));
      } catch (e) {
        if (e instanceof KanboardError && e.forbidden) return false;
        if (e instanceof KanboardError) throw kanboardFailure(e, `reading task ${taskId}`);
        throw e;
      }
    };
    const child = now.child > 0 && (await exists(now.child)) ? now.child : 0;
    if (a.recurrence_status === 1 && child > 0) throw new Refusal("input", `${now.subject} already created its next task (recurrence_child ${child}); recurrence_status 1 would make Kanboard create a second one. Change the recurrence on task ${child} instead.`);
    if (others.length && status !== 1) throw new Refusal("input", `${others.join(", ")} given without recurrence_status 1 (it is ${status}): ${now.subject.toLowerCase()} would not repeat. ${child > 0 ? `It already created its next task (recurrence_child ${child}): change the recurrence on that task, or leave the recurrence fields out.` : "Add recurrence_status: 1, or leave the recurrence fields out."}`);
    if (status !== 1) return;
    if (!now.due) throw new Refusal("input", `A repeating task (recurrence_status 1) needs a due date: ${now.subject.toLowerCase()} has none, and Kanboard computes the next due date from it. Give date_due, or set recurrence_status 0 first.`);
    if ((a.recurrence_factor ?? now.factor) < 1) throw new Refusal("input", `recurrence_status 1 needs recurrence_factor of 1 or more (7 with recurrence_timeframe 0 = weekly): ${now.subject.toLowerCase()} has none, so every next task would have the same due date.`);
    const trigger = a.recurrence_trigger ?? now.trigger;
    if (trigger !== 0 && trigger !== 1) return;
    const columns = await call<Raw[]>(`reading the columns of project ${now.project_id}`, "getColumns", { project_id: now.project_id });
    const ordered = columns.map((c) => ({ id: Number(c.id), position: Number(c.position) })).sort((x, y) => x.position - y.position);
    if (ordered.length < 2) throw new Refusal("input", `recurrence_trigger ${trigger} needs a move between columns, and project ${now.project_id} has one column: it can never fire. Use recurrence_trigger 2 (closed).`);
    const column = now.column_id ?? ordered[0]!.id;
    if (trigger === 0 && column !== ordered[0]!.id) throw new Refusal("input", `recurrence_trigger 0 fires when the task moves out of the first column, and column ${column} is not the first. Use the first column (on create, leave column_id out), or another trigger.`);
    if (trigger === 1 && column === ordered.at(-1)!.id) throw new Refusal("input", `recurrence_trigger 1 fires when the task moves to the last column, and column ${column} is the last: it is already there. Use another column or trigger.`);
  };

  /** The recurrence facts of a stored task, for checkRecurrence. */
  const stored = (t: Raw, a: { date_due?: string }) => ({
    subject: `Task ${Number(t.id)}`,
    project_id: Number(t.project_id),
    column_id: Number(t.column_id),
    status: Number(t.recurrence_status),
    trigger: Number(t.recurrence_trigger),
    factor: Number(t.recurrence_factor),
    child: Number(t.recurrence_child) || 0,
    due: a.date_due === undefined ? Number(t.date_due) > 0 : a.date_due !== "",
  });

  /** The link labels: Kanboard's, or the built-in defaults when this user may not list them. */
  const linkLabels = async (): Promise<{ labels: typeof DEFAULT_LINK_LABELS; source: "kanboard" | "built-in defaults" }> => {
    try {
      const raw = await kb.call<Raw[]>(auth, "getAllLinks");
      return { labels: raw.map((l) => ({ id: Number(l.id), label: String(l.label), opposite_id: Number(l.opposite_id ?? 0) })), source: "kanboard" };
    } catch (e) {
      if (e instanceof KanboardError && e.forbidden) return { labels: DEFAULT_LINK_LABELS, source: "built-in defaults" };
      if (e instanceof KanboardError) throw kanboardFailure(e, "reading the link labels");
      throw e;
    }
  };

  /** Wraps a handler: refusals become tool errors, anything else a generic one; every call is logged. */
  const tool = <A extends Record<string, unknown>>(name: string, fn: (args: A) => Promise<Record<string, unknown>>) => {
    return async (args: A): Promise<CallToolResult> => {
      const t0 = performance.now();
      const done = (outcome: string, detail?: string) => log.request({ user: user.user, tool: name, outcome, ms: Math.round(performance.now() - t0), detail });
      try {
        const out = await fn(args);
        done("ok");
        return result(out);
      } catch (e) {
        if (e instanceof Refusal) {
          done(`refused:${e.control}`, e.message.slice(0, 200));
          return failure(e.message);
        }
        done("error", (e as Error).message.slice(0, 200));
        log.error("tool.failed", { user: user.user, tool: name, error: (e as Error).message });
        return failure(`${name} failed: ${(e as Error).message}`);
      }
    };
  };

  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  // ---- Reading -------------------------------------------------------------------------------

  server.registerTool(
    "get_me",
    { description: "The Kanboard user this connection acts as: id, username, name, role, and Kanboard's time zone (the zone of every date the tools return and accept).", inputSchema: {}, annotations: read },
    tool("get_me", async () => ({ ...(await me()) })),
  );

  server.registerTool(
    "get_projects",
    { description: "The projects the user is a member of, with their ids.", inputSchema: {}, annotations: read },
    tool("get_projects", async () => {
      const raw = await call<Raw[]>("reading the projects", "getMyProjects");
      const z = await zone();
      return {
        projects: raw.map((p) => ({
          id: Number(p.id),
          name: String(p.name),
          description: typeof p.description === "string" ? p.description : "",
          is_active: p.is_active === 1 || p.is_active === "1",
          last_modified: isoAt(p.last_modified, z),
          url: (p.url as Raw | undefined)?.board ?? null,
        })),
      };
    }),
  );

  const projectArg = { project_id: id("Project id (from get_projects)") };

  server.registerTool(
    "get_columns",
    { description: "The columns of a project, in board order, with their ids (needed by create_task and move_task).", inputSchema: projectArg, annotations: read },
    tool<{ project_id: number }>("get_columns", async ({ project_id }) => {
      const raw = await call<Raw[]>(`reading the columns of project ${project_id}`, "getColumns", { project_id });
      return { columns: raw.map((c) => ({ id: Number(c.id), title: String(c.title), position: Number(c.position), task_limit: Number(c.task_limit ?? 0), description: typeof c.description === "string" ? c.description : "" })) };
    }),
  );

  server.registerTool(
    "get_swimlanes",
    { description: "The active swimlanes of a project, with their ids.", inputSchema: projectArg, annotations: read },
    tool<{ project_id: number }>("get_swimlanes", async ({ project_id }) => {
      const raw = await call<Raw[] | null>(`reading the swimlanes of project ${project_id}`, "getActiveSwimlanes", { project_id });
      return { swimlanes: (raw ?? []).map((s) => ({ id: Number(s.id), name: String(s.name), position: Number(s.position ?? 0) })) };
    }),
  );

  server.registerTool(
    "get_categories",
    { description: "The categories of a project, with their ids.", inputSchema: projectArg, annotations: read },
    tool<{ project_id: number }>("get_categories", async ({ project_id }) => {
      const raw = await call<Raw[]>(`reading the categories of project ${project_id}`, "getAllCategories", { project_id });
      return { categories: raw.map((c) => ({ id: Number(c.id), name: String(c.name), color_id: typeof c.color_id === "string" ? c.color_id : null })) };
    }),
  );

  server.registerTool(
    "get_project_tags",
    { description: "The tags defined in a project. Tags are given to tasks by name; a name that does not exist yet is created when a task gets it.", inputSchema: projectArg, annotations: read },
    tool<{ project_id: number }>("get_project_tags", async ({ project_id }) => {
      const raw = await call<Raw[]>(`reading the tags of project ${project_id}`, "getTagsByProject", { project_id });
      return { tags: raw.map((t) => ({ id: Number(t.id), name: String(t.name), color_id: typeof t.color_id === "string" ? t.color_id : null })).sort((a, b) => a.name.localeCompare(b.name)) };
    }),
  );

  server.registerTool(
    "get_users",
    { description: "The members of a project, with their user ids (for assign_task and create_task's owner_id). Kanboard shows a member's display name, or the username when there is none.", inputSchema: projectArg, annotations: read },
    tool<{ project_id: number }>("get_users", async ({ project_id }) => {
      const raw = await call<Record<string, unknown> | unknown[]>(`reading the members of project ${project_id}`, "getProjectUsers", { project_id });
      const entries = Array.isArray(raw) ? [] : Object.entries(raw ?? {});
      return { users: entries.map(([uid, name]) => ({ id: Number(uid), name: String(name) })).sort((a, b) => a.id - b.id) };
    }),
  );

  server.registerTool(
    "get_colors",
    { description: "The task colours Kanboard knows, as color_id and name.", inputSchema: {}, annotations: read },
    tool("get_colors", async () => {
      const raw = await call<Record<string, string>>("reading the colours", "getColorList");
      return { colors: Object.entries(raw).map(([cid, name]) => ({ id: cid, name })) };
    }),
  );

  server.registerTool(
    "get_link_labels",
    { description: "The labels an internal link between two tasks can have (for create_task_link): id, label and the id of the opposite label. A plain user may not list Kanboard's labels; the built-in defaults are returned then, and `source` says so.", inputSchema: {}, annotations: read },
    tool("get_link_labels", async () => {
      const { labels, source } = await linkLabels();
      return { labels, source };
    }),
  );

  server.registerTool(
    "search_tasks",
    {
      description: `Search the tasks of a project with Kanboard's query syntax (filters are ANDed; bare words match the title). Keys: status:open|closed, assignee:me|nobody|<username>, column:"Work in progress", swimlane:, category:, tag:, color:, creator:, priority:<N, score:, id:, ref:, link:, due:/created:/updated:/moved:/completed:/started: with a date (due:<${new Date().toISOString().slice(0, 10)}, due:today, due:tomorrow, due:>2026-01-01). Returns at most ${SEARCH_LIMIT} tasks with their tags; an empty query returns every task of the project.`,
      inputSchema: {
        ...projectArg,
        query: z.string().max(2000).describe('Kanboard search query, for example "status:open assignee:me" or "column:Ready tag:urgent"'),
        include_tags: z.boolean().optional().describe("Add each task's tags (default true; one extra batch call to Kanboard)"),
      },
      annotations: read,
    },
    tool<{ project_id: number; query: string; include_tags?: boolean }>("search_tasks", async ({ project_id, query, include_tags = true }) => {
      const raw = await call<Raw[]>(`searching project ${project_id}`, "searchTasks", { project_id, query });
      const z = await zone();
      const all = Array.isArray(raw) ? raw : [];
      const shown = all.slice(0, SEARCH_LIMIT);
      const tasks = shown.map((t) => taskView(t, z));
      if (include_tags && shown.length) {
        const tags = await kb.batch(auth, shown.map((t) => ({ method: "getTaskTags", params: { task_id: Number(t.id) } }))).catch((e: unknown) => {
          if (e instanceof KanboardError) throw kanboardFailure(e, "reading the tags");
          throw e;
        });
        tasks.forEach((t, i) => (t.tags = tags[i] instanceof KanboardError ? [] : tagNames(tags[i])));
      }
      return { project_id, query, count: tasks.length, total: all.length, truncated: all.length > shown.length, tasks };
    }),
  );

  server.registerTool(
    "get_task_details",
    {
      description: "A task with its tags, internal links, subtasks and attachments (names only), and optionally its comments. Dates are ISO 8601 in Kanboard's time zone; `is_active` false means closed. The `recurrence_*` fields are those of create_task; status 2 means the next task exists, as `recurrence_child` (and that task names this one as `recurrence_parent`).",
      inputSchema: { task_id: id("Task id"), include_comments: z.boolean().optional().describe("Add the comments, oldest first (default false)") },
      annotations: read,
    },
    tool<{ task_id: number; include_comments?: boolean }>("get_task_details", async ({ task_id, include_comments = false }) => {
      const z = await zone();
      const calls = [
        { method: "getTask", params: { task_id } },
        { method: "getTaskTags", params: { task_id } },
        { method: "getAllTaskLinks", params: { task_id } },
        { method: "getAllSubtasks", params: { task_id } },
        { method: "getAllTaskFiles", params: { task_id } },
        ...(include_comments ? [{ method: "getAllComments", params: { task_id } }] : []),
      ];
      const [t, tags, links, subtasks, files, comments] = await kb.batch(auth, calls).catch((e: unknown) => {
        if (e instanceof KanboardError) throw kanboardFailure(e, `reading task ${task_id}`);
        throw e;
      });
      if (t instanceof KanboardError) throw kanboardFailure(t, `reading task ${task_id}`);
      if (!t) throw new Refusal("kanboard", `Kanboard has no task ${task_id} that user "${user.kanboardUser}" may see.`);
      const list = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);
      const out: Raw = {
        ...taskView(t as Raw, z),
        tags: tags instanceof KanboardError ? [] : tagNames(tags),
        links: list(links).map((l) => linkView(l, z)),
        subtasks: list(subtasks).map(subtaskView),
        attachments: list(files).map((f) => fileView(f, z)),
      };
      if (include_comments) out.comments = list(comments).map((c) => commentView(c, z));
      return out;
    }),
  );

  server.registerTool(
    "get_task_comments",
    { description: "The comments of a task, oldest first, with author and dates.", inputSchema: { task_id: id("Task id") }, annotations: read },
    tool<{ task_id: number }>("get_task_comments", async ({ task_id }) => {
      const raw = await call<Raw[] | false>(`reading the comments of task ${task_id}`, "getAllComments", { task_id });
      const z = await zone();
      return { task_id, comments: (Array.isArray(raw) ? raw : []).map((c) => commentView(c, z)) };
    }),
  );

  // ---- Writing -------------------------------------------------------------------------------

  server.registerTool(
    "create_task",
    {
      description: "Create a task. `priority` is required because Kanboard gives 0 to a task created without one. Tags are names; missing ones are created in the project. A task that repeats gets recurrence_status 1 with a trigger, an interval and a due date (weekly: recurrence_factor 7, recurrence_timeframe 0). Returns the new task's id and URL.",
      inputSchema: {
        ...projectArg,
        title: text("Title", 1000).min(1),
        priority: z.number().int().min(0).max(100).describe("Priority, within the project's range (Kanboard's default range is 0 to 3)"),
        description: text("Description, Markdown").optional(),
        column_id: id("Column id (default: the first column)").optional(),
        swimlane_id: id("Swimlane id (default: the default swimlane)").optional(),
        category_id: id("Category id").optional(),
        color_id: z.string().max(50).describe("Colour id, from get_colors").optional(),
        owner_id: z.number().int().min(0).describe("Assignee's user id; 0 for nobody").optional(),
        date_due: z.string().max(40).describe(`Due date, ${DATE_HELP}`).optional(),
        tags: z.array(z.string().min(1).max(200)).max(50).describe("Tag names").optional(),
        reference: z.string().max(200).describe("External reference").optional(),
        ...RECURRENCE_SCHEMA.shape,
      },
      annotations: write,
    },
    tool<{ project_id: number; title: string; priority: number; description?: string; column_id?: number; swimlane_id?: number; category_id?: number; color_id?: string; owner_id?: number; date_due?: string; tags?: string[]; reference?: string } & Recurrence>("create_task", async (a) => {
      const due = a.date_due === undefined ? undefined : dateOrRefuse("date_due", a.date_due);
      await checkRecurrence(a, { subject: "The new task", project_id: a.project_id, column_id: a.column_id, status: 0, trigger: 0, factor: 0, child: 0, due: !!due });
      const params: Raw = { project_id: a.project_id, title: a.title, priority: a.priority };
      for (const k of ["description", "column_id", "swimlane_id", "category_id", "color_id", "owner_id", "tags", "reference", ...RECURRENCE_WRITABLE] as const) if (a[k] !== undefined) params[k] = a[k];
      if (due !== undefined) params.date_due = due;
      const task_id = await created(`creating the task "${a.title}"`, "createTask", params, "Check the project id, the column and swimlane ids (get_columns, get_swimlanes), the category and the owner (get_users).");
      const t = await task(task_id);
      return { task_id, url: t.url ?? null, title: a.title, project_id: a.project_id };
    }),
  );

  server.registerTool(
    "update_task",
    {
      description: "Change a task's fields: title, description, category, colour, assignee, priority, reference, due or start date, recurrence. Only the fields given change. To move a task use move_task; to change tags use set_task_tags.",
      inputSchema: {
        task_id: id("Task id"),
        title: text("Title", 1000).min(1).optional(),
        description: text("Description, Markdown (replaces the whole description)").optional(),
        category_id: z.number().int().min(0).describe("Category id; 0 for none").optional(),
        color_id: z.string().max(50).describe("Colour id, from get_colors").optional(),
        owner_id: z.number().int().min(0).describe("Assignee's user id; 0 for nobody").optional(),
        priority: z.number().int().min(0).max(100).describe("Priority").optional(),
        reference: z.string().max(200).describe("External reference").optional(),
        date_due: z.string().max(40).describe(`Due date, ${DATE_HELP}; an empty string clears it`).optional(),
        date_started: z.string().max(40).describe(`Start date, ${DATE_HELP}; an empty string clears it`).optional(),
        ...RECURRENCE_SCHEMA.shape,
      },
      annotations: { ...write, idempotentHint: true },
    },
    tool<{ task_id: number; title?: string; description?: string; category_id?: number; color_id?: string; owner_id?: number; priority?: number; reference?: string; date_due?: string; date_started?: string } & Recurrence>("update_task", async (a) => {
      const params: Raw = { id: a.task_id };
      const changed: string[] = [];
      const dates: Raw = {};
      for (const k of ["date_due", "date_started"] as const) if (a[k] !== undefined) dates[k] = dateOrRefuse(k, a[k]);
      if (RECURRENCE_WRITABLE.some((k) => a[k] !== undefined) || a.date_due === "") {
        const t = await task(a.task_id);
        await checkRecurrence(a, stored(t, a));
      }
      for (const k of ["title", "description", "category_id", "color_id", "owner_id", "priority", "reference", ...RECURRENCE_WRITABLE] as const) {
        if (a[k] === undefined) continue;
        params[k] = a[k];
        changed.push(k);
      }
      for (const k of Object.keys(dates)) {
        params[k] = dates[k];
        changed.push(k);
      }
      if (!changed.length) throw new Refusal("input", "Nothing to change: give at least one field besides task_id.");
      await apply(`updating task ${a.task_id}`, "updateTask", params, "Check the ids (category, owner) and that the task exists in a project the user is a member of.");
      return { task_id: a.task_id, changed };
    }),
  );

  server.registerTool(
    "move_task",
    {
      description: "Move a task to a column (and optionally another swimlane) of its project. Position 1 is the top of the column (default).",
      inputSchema: { task_id: id("Task id"), column_id: id("Target column id, from get_columns"), position: z.number().int().min(1).describe("Position in the column, 1 = top (default 1)").optional(), swimlane_id: id("Target swimlane id (default: the task's current swimlane)").optional() },
      annotations: { ...write, idempotentHint: true },
    },
    tool<{ task_id: number; column_id: number; position?: number; swimlane_id?: number }>("move_task", async ({ task_id, column_id, position = 1, swimlane_id }) => {
      const t = await task(task_id);
      const project_id = Number(t.project_id);
      const lane = swimlane_id ?? Number(t.swimlane_id);
      await apply(`moving task ${task_id}`, "moveTaskPosition", { project_id, task_id, column_id, position, swimlane_id: lane }, `Check that column ${column_id} and swimlane ${lane} belong to project ${project_id} (get_columns, get_swimlanes).`);
      return { task_id, project_id, column_id, swimlane_id: lane, position, from_column_id: Number(t.column_id) };
    }),
  );

  server.registerTool(
    "assign_task",
    { description: "Assign a task to a user (user_id from get_users), or to nobody with 0.", inputSchema: { task_id: id("Task id"), user_id: z.number().int().min(0).describe("User id; 0 unassigns") }, annotations: { ...write, idempotentHint: true } },
    tool<{ task_id: number; user_id: number }>("assign_task", async ({ task_id, user_id }) => {
      await apply(`assigning task ${task_id}`, "updateTask", { id: task_id, owner_id: user_id }, "Check that the user is a member of the task's project (get_users).");
      return { task_id, owner_id: user_id };
    }),
  );

  server.registerTool(
    "set_task_due_date",
    { description: `Set a task's due date, with or without a time of day (${DATE_HELP}); an empty string clears it.`, inputSchema: { task_id: id("Task id"), due_date: z.string().max(40).describe(`${DATE_HELP}, or "" to clear`) }, annotations: { ...write, idempotentHint: true } },
    tool<{ task_id: number; due_date: string }>("set_task_due_date", async ({ task_id, due_date }) => {
      const d = dateOrRefuse("due_date", due_date);
      if (d === "") {
        const t = await task(task_id);
        await checkRecurrence({}, stored(t, { date_due: "" }));
      }
      await apply(`setting the due date of task ${task_id}`, "updateTask", { id: task_id, date_due: d }, "Check that the task exists in a project the user is a member of.");
      const t = await task(task_id);
      return { task_id, date_due: isoAt(t.date_due, await zone()) };
    }),
  );

  server.registerTool(
    "set_task_tags",
    {
      description: "Add tags to a task (default), or replace its tags with the given list. Tags are names; a name the project does not have yet is created. To remove a tag, pass the remaining tags with replace: true.",
      inputSchema: { task_id: id("Task id"), tags: z.array(z.string().min(1).max(200)).max(50).describe("Tag names"), replace: z.boolean().optional().describe("Replace the task's tags with this list instead of adding to them (default false)") },
      annotations: { ...write, idempotentHint: true },
    },
    tool<{ task_id: number; tags: string[]; replace?: boolean }>("set_task_tags", async ({ task_id, tags, replace = false }) => {
      const t = await task(task_id);
      const project_id = Number(t.project_id);
      let wanted = [...new Set(tags.map((x) => x.trim()).filter(Boolean))];
      if (!replace) {
        const current = tagNames(await call(`reading the tags of task ${task_id}`, "getTaskTags", { task_id }));
        wanted = [...new Set([...current, ...wanted])];
      }
      await apply(`setting the tags of task ${task_id}`, "setTaskTags", { project_id, task_id, tags: wanted }, "Check that the task exists in a project the user is a member of.");
      return { task_id, tags: tagNames(await call(`reading the tags of task ${task_id}`, "getTaskTags", { task_id })) };
    }),
  );

  server.registerTool(
    "add_task_comment",
    { description: "Add a comment to a task, as the connected user (Markdown).", inputSchema: { task_id: id("Task id"), comment: text("The comment, Markdown").min(1) }, annotations: write },
    tool<{ task_id: number; comment: string }>("add_task_comment", async ({ task_id, comment }) => {
      const who = await me();
      const comment_id = await created(`commenting on task ${task_id}`, "createComment", { task_id, user_id: who.id, content: comment }, "Check that the task exists in a project the user is a member of (a viewer cannot comment).");
      return { task_id, comment_id };
    }),
  );

  server.registerTool(
    "update_task_comment",
    { description: "Replace the text of a comment the connected user wrote (comment_id from get_task_comments).", inputSchema: { comment_id: id("Comment id"), comment: text("The new text, Markdown").min(1) }, annotations: { ...write, idempotentHint: true } },
    tool<{ comment_id: number; comment: string }>("update_task_comment", async ({ comment_id, comment }) => {
      await apply(`updating comment ${comment_id}`, "updateComment", { id: comment_id, content: comment }, "Kanboard lets a user change only the comments it wrote (a manager any); check the comment id.");
      return { comment_id };
    }),
  );

  server.registerTool(
    "create_task_link",
    {
      description: 'Link two tasks with a label, seen from task_id: "relates to", "blocks", "is blocked by", "duplicates", "is duplicated by", "is a child of", "is a parent of", "targets milestone", "is a milestone of", "fixes", "is fixed by" (get_link_labels). Kanboard adds the opposite link on the other task.',
      inputSchema: { task_id: id("Task id"), opposite_task_id: id("The other task's id"), label: z.string().max(100).describe("The label, as get_link_labels lists it").optional(), link_id: id("The label's id, instead of its text").optional() },
      annotations: write,
    },
    tool<{ task_id: number; opposite_task_id: number; label?: string; link_id?: number }>("create_task_link", async ({ task_id, opposite_task_id, label, link_id }) => {
      if (label === undefined && link_id === undefined) throw new Refusal("input", "Give the link's label or its link_id (get_link_labels).");
      let linkId = link_id;
      let resolved = label;
      if (linkId === undefined) {
        const { labels } = await linkLabels();
        const found = labels.find((l) => l.label.toLowerCase() === label!.trim().toLowerCase());
        if (!found) throw new Refusal("input", `No link label "${label}". Known labels: ${labels.map((l) => `"${l.label}"`).join(", ")}.`);
        linkId = found.id;
      } else {
        resolved = (await linkLabels()).labels.find((l) => l.id === linkId)?.label ?? label;
      }
      const task_link_id = await created(`linking task ${task_id} to ${opposite_task_id}`, "createTaskLink", { task_id, opposite_task_id, link_id: linkId }, "Check that both tasks exist and are visible to the user, and that the link does not exist already.");
      return { task_link_id, task_id, opposite_task_id, link_id: linkId, label: resolved ?? null };
    }),
  );

  server.registerTool(
    "remove_task_link",
    { description: "Remove an internal link between two tasks (task_link_id from get_task_details, field `links[].id`). The tasks stay.", inputSchema: { task_link_id: id("Task link id") }, annotations: { ...write, destructiveHint: true } },
    tool<{ task_link_id: number }>("remove_task_link", async ({ task_link_id }) => {
      await apply(`removing task link ${task_link_id}`, "removeTaskLink", { task_link_id }, "Check the link id in get_task_details.");
      return { task_link_id, removed: true };
    }),
  );

  const STATUS = z.number().int().min(0).max(2).describe("0 = to do, 1 = in progress, 2 = done");

  server.registerTool(
    "create_subtask",
    { description: "Add a subtask (a checklist step) to a task.", inputSchema: { task_id: id("Task id"), title: text("Title", 1000).min(1), user_id: z.number().int().min(0).describe("Assignee's user id").optional(), status: STATUS.optional() }, annotations: write },
    tool<{ task_id: number; title: string; user_id?: number; status?: number }>("create_subtask", async ({ task_id, title, user_id, status }) => {
      const params: Raw = { task_id, title };
      if (user_id !== undefined) params.user_id = user_id;
      if (status !== undefined) params.status = status;
      const subtask_id = await created(`adding a subtask to task ${task_id}`, "createSubtask", params, "Check that the task exists in a project the user is a member of.");
      return { task_id, subtask_id };
    }),
  );

  server.registerTool(
    "update_subtask",
    { description: "Change a subtask's title, status or assignee (subtask_id from get_task_details, field `subtasks[].id`).", inputSchema: { subtask_id: id("Subtask id"), task_id: id("The task the subtask belongs to"), title: text("Title", 1000).min(1).optional(), status: STATUS.optional(), user_id: z.number().int().min(0).describe("Assignee's user id; 0 for nobody").optional() }, annotations: { ...write, idempotentHint: true } },
    tool<{ subtask_id: number; task_id: number; title?: string; status?: number; user_id?: number }>("update_subtask", async ({ subtask_id, task_id, title, status, user_id }) => {
      const params: Raw = { id: subtask_id, task_id };
      const changed: string[] = [];
      for (const [k, v] of Object.entries({ title, status, user_id })) {
        if (v === undefined) continue;
        params[k] = v;
        changed.push(k);
      }
      if (!changed.length) throw new Refusal("input", "Nothing to change: give title, status or user_id.");
      await apply(`updating subtask ${subtask_id}`, "updateSubtask", params, "Check the subtask and task ids in get_task_details.");
      return { subtask_id, task_id, changed };
    }),
  );
}
