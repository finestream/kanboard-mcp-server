// What Kanboard returns, made readable for an agent: Unix timestamps become
// ISO 8601 in Kanboard's time zone, `0` and `null` dates become null, and a
// task, comment, link, subtask or file keeps the fields an agent acts on.
// Dates an agent sends are checked here before Kanboard sees them.

/** `YYYY-MM-DD`, or `YYYY-MM-DD HH:MM` (a `T` between the parts is accepted); Kanboard's own input format, in Kanboard's time zone. */
const DATE_INPUT = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/;

/** The text Kanboard takes for a date field, or null when the input is not a date. Kanboard answers `false` to a date it cannot read, so this check gives the reason instead. */
export function dateInput(text: string): string | null {
  const m = text.trim().match(DATE_INPUT);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) return null;
  if (h !== undefined && (Number(h) > 23 || Number(mi) > 59)) return null;
  return h === undefined ? `${y}-${mo}-${d}` : `${y}-${mo}-${d} ${h}:${mi}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset" });
    } catch {
      f = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset" });
    }
    formatters.set(zone, f);
  }
  return f;
}

/** A Kanboard timestamp (seconds, as a number or a numeric string) as `YYYY-MM-DDTHH:mm:ss±HH:MM` in `zone`; `0`, `null` and anything else become null. */
export function isoAt(ts: unknown, zone: string): string | null {
  const n = typeof ts === "number" ? ts : typeof ts === "string" && /^\d+$/.test(ts) ? Number(ts) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const parts = formatter(zone).formatToParts(new Date(n * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const offset = get("timeZoneName").replace(/^GMT$/, "+00:00").replace(/^GMT/, "");
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${offset}`;
}

type Raw = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : null);
const bool = (v: unknown): boolean => v === true || v === 1 || v === "1";
const str = (v: unknown): string | null => (typeof v === "string" ? v : v === null || v === undefined ? null : String(v));

/** The recurrence fields a task can be given (the tools' input) and the two Kanboard fills in. */
export const RECURRENCE_WRITABLE = ["recurrence_status", "recurrence_trigger", "recurrence_factor", "recurrence_timeframe", "recurrence_basedate"] as const;
const RECURRENCE_FIELDS = [...RECURRENCE_WRITABLE, "recurrence_parent", "recurrence_child"] as const;

const TASK_DATES = ["date_creation", "date_modification", "date_moved", "date_started", "date_due", "date_completed"] as const;

/** The task as the tools return it: ids and counts as numbers, dates as ISO text, `is_active` as a boolean, Kanboard's names kept. */
export function taskView(raw: Raw, zone: string): Raw {
  const out: Raw = {
    id: num(raw.id),
    title: str(raw.title),
    description: str(raw.description) ?? "",
    project_id: num(raw.project_id),
    column_id: num(raw.column_id),
    swimlane_id: num(raw.swimlane_id),
    category_id: num(raw.category_id),
    owner_id: num(raw.owner_id),
    creator_id: num(raw.creator_id),
    priority: num(raw.priority),
    score: num(raw.score),
    position: num(raw.position),
    color_id: str(raw.color_id),
    reference: str(raw.reference) ?? "",
    is_active: bool(raw.is_active),
    url: str(raw.url),
  };
  for (const d of TASK_DATES) out[d] = isoAt(raw[d], zone);
  // What `searchTasks` adds beyond `getTask`: names, and counts of what hangs on the task.
  for (const k of ["project_name", "column_name", "swimlane_name", "category_name", "assignee_username", "assignee_name"]) {
    if (k in raw) out[k] = str(raw[k]);
  }
  for (const k of ["nb_comments", "nb_files", "nb_subtasks", "nb_completed_subtasks", "nb_links"]) {
    if (k in raw) out[k] = num(raw[k]);
  }
  // Recurrence, as Kanboard stores it (README, "Recurring tasks"); parent and child are task ids, or null.
  for (const k of RECURRENCE_FIELDS) {
    if (k in raw) out[k] = num(raw[k]);
  }
  return out;
}

export function commentView(raw: Raw, zone: string): Raw {
  return {
    id: num(raw.id),
    task_id: num(raw.task_id),
    user_id: num(raw.user_id),
    username: str(raw.username),
    name: str(raw.name),
    date_creation: isoAt(raw.date_creation, zone),
    date_modification: isoAt(raw.date_modification, zone),
    comment: str(raw.comment) ?? "",
  };
}

/** One internal link, seen from the task it was asked for: `task_id` is the *other* task. */
export function linkView(raw: Raw, zone: string): Raw {
  return {
    id: num(raw.id),
    label: str(raw.label),
    task_id: num(raw.task_id),
    title: str(raw.title),
    project_id: num(raw.project_id),
    column_title: str(raw.column_title),
    is_active: bool(raw.is_active),
    date_due: isoAt(raw.date_due, zone),
    assignee_username: str(raw.task_assignee_username),
  };
}

export function subtaskView(raw: Raw): Raw {
  return {
    id: num(raw.id),
    task_id: num(raw.task_id),
    title: str(raw.title),
    status: num(raw.status),
    status_name: str(raw.status_name),
    user_id: num(raw.user_id),
    username: str(raw.username),
    position: num(raw.position),
  };
}

export function fileView(raw: Raw, zone: string): Raw {
  return { id: num(raw.id), name: str(raw.name), size: num(raw.size), is_image: bool(raw.is_image), date: isoAt(raw.date, zone), username: str(raw.username) };
}

/** `getTaskTags` answers `{ "<tag id>": "<name>" }`; the names, sorted. */
export function tagNames(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  return Object.values(raw as Record<string, unknown>).filter((v): v is string => typeof v === "string").sort();
}
