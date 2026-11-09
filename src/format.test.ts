import test from "node:test";
import assert from "node:assert/strict";
import { dateInput, isoAt, tagNames, taskView } from "./format.ts";

test("format: a date an agent sends is checked and normalised; anything else is refused", () => {
  assert.equal(dateInput("2026-11-20"), "2026-11-20");
  assert.equal(dateInput(" 2026-11-20 14:30 "), "2026-11-20 14:30");
  assert.equal(dateInput("2026-11-20T14:30"), "2026-11-20 14:30");
  assert.equal(dateInput("2026-02-30"), null, "no such day");
  assert.equal(dateInput("2026-11-20 24:00"), null);
  assert.equal(dateInput("20.11.2026"), null);
  assert.equal(dateInput("next week"), null);
  assert.equal(dateInput("2026-11-20 14:30:00"), null, "seconds are not part of Kanboard's format");
  assert.equal(dateInput(""), null);
});

test("format: Kanboard's timestamps become ISO text in Kanboard's time zone; 0 and null become null", () => {
  assert.equal(isoAt(1795185000, "UTC"), "2026-11-20T14:30:00+00:00");
  assert.equal(isoAt("1795185000", "Europe/Zurich"), "2026-11-20T15:30:00+01:00");
  assert.equal(isoAt(1785000000, "Europe/Zurich"), "2026-07-25T19:20:00+02:00", "summer time");
  assert.equal(isoAt(1795185000, "America/New_York"), "2026-11-20T09:30:00-05:00");
  assert.equal(isoAt(0, "UTC"), null);
  assert.equal(isoAt(null, "UTC"), null);
  assert.equal(isoAt("", "UTC"), null);
  assert.equal(isoAt(1795185000, "Not/AZone"), "2026-11-20T14:30:00+00:00", "an unknown zone falls back to UTC");
});

test("format: a task keeps Kanboard's field names, with numbers, booleans and ISO dates", () => {
  const t = taskView({ id: "7", title: "First", project_id: 1, column_id: "2", owner_id: 0, is_active: "1", date_due: 1795185000, date_completed: null, date_started: 0, priority: 2, nb_comments: "3", column_name: "Ready", url: "http://x/task/7" }, "UTC");
  assert.equal(t.id, 7);
  assert.equal(t.column_id, 2);
  assert.equal(t.is_active, true);
  assert.equal(t.date_due, "2026-11-20T14:30:00+00:00");
  assert.equal(t.date_completed, null);
  assert.equal(t.date_started, null);
  assert.equal(t.nb_comments, 3);
  assert.equal(t.column_name, "Ready");
  assert.equal("nb_files" in t, false, "fields searchTasks did not send are absent");
  assert.deepEqual(tagNames({ "3": "repo:x", "1": "model:opus" }), ["model:opus", "repo:x"]);
  assert.deepEqual(tagNames(false), []);
});
