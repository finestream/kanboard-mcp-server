import test from "node:test";
import assert from "node:assert/strict";
import { kanboardEndpoint, loadConfig, parseDuration } from "./config.ts";

test("config: KANBOARD_URL may be the base URL or the endpoint; the endpoint results", () => {
  assert.equal(kanboardEndpoint("http://kanboard"), "http://kanboard/jsonrpc.php");
  assert.equal(kanboardEndpoint("http://kanboard:8080/"), "http://kanboard:8080/jsonrpc.php");
  assert.equal(kanboardEndpoint("https://kanban.example.org/kanboard/"), "https://kanban.example.org/kanboard/jsonrpc.php");
  assert.equal(kanboardEndpoint("https://kanban.example.org/jsonrpc.php"), "https://kanban.example.org/jsonrpc.php");
  assert.throws(() => kanboardEndpoint("kanboard"), /not a URL/);
  assert.throws(() => kanboardEndpoint("ftp://kanboard"), /http or https/);
  assert.throws(() => kanboardEndpoint("http://user:pw@kanboard"), /no query, fragment or credentials/);
  assert.throws(() => kanboardEndpoint("http://kanboard/jsonrpc.php?x=1"), /no query/);
});

test("config: defaults and durations", () => {
  const c = loadConfig({});
  assert.equal(c.kanboardUrl, "http://kanboard/jsonrpc.php");
  assert.equal(c.port, 4000);
  assert.equal(c.kanboardTimeout, 30_000);
  assert.equal(c.rateLimit, 120);
  assert.equal(c.oauth, null);
  assert.equal(c.cfAccess, null);
  assert.equal(parseDuration("15m"), 900_000);
  assert.equal(parseDuration("250ms"), 250);
  assert.throws(() => parseDuration("soon"), /not a duration/);
});
