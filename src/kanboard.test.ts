// The JSON-RPC client against a local stand-in for Kanboard's `/jsonrpc.php`:
// Basic authentication, single calls, batches with errors inside, and how
// Kanboard's 401/403 (HTTP status and JSON-RPC error alike) come out.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Kanboard, KanboardError } from "./kanboard.ts";

let server: Server;
let kb: Kanboard;
const seen: Array<{ auth: string | undefined; body: unknown }> = [];

const ALICE = { username: "alice", token: "alice-token" };

before(async () => {
  server = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      const body = JSON.parse(text);
      seen.push({ auth: req.headers.authorization, body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== "Basic " + Buffer.from("alice:alice-token").toString("base64")) return send(401, { jsonrpc: "2.0", error: { code: 401, message: "Unauthorized" }, id: null });
      const answer = (r: { method: string; id: unknown; params?: unknown }) => {
        if (r.method === "getVersion") return { jsonrpc: "2.0", result: "v1.2.57", id: r.id };
        if (r.method === "getTask") return { jsonrpc: "2.0", result: { id: (r.params as { task_id: number }).task_id, title: "T" }, id: r.id };
        if (r.method === "getAllLinks") return { jsonrpc: "2.0", error: { code: 403, message: "Forbidden" }, id: r.id };
        if (r.method === "updateTask") return { jsonrpc: "2.0", result: false, id: r.id };
        return { jsonrpc: "2.0", error: { code: -32601, message: "Method not found" }, id: r.id };
      };
      if (Array.isArray(body)) return send(200, body.map(answer));
      const one = answer(body);
      // Kanboard: a 403 is the HTTP status too, and the id is null on a single call.
      if ("error" in one && one.error?.code === 403) return send(403, { ...one, id: null });
      send(200, one);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  kb = new Kanboard(`http://127.0.0.1:${(server.address() as AddressInfo).port}/jsonrpc.php`, 2000);
});

after(() => new Promise((r) => server.close(r)));

test("kanboard: a call sends Basic auth with the user's name and token and returns the result", async () => {
  assert.equal(await kb.call(ALICE, "getVersion"), "v1.2.57");
  const last = seen.at(-1)!;
  assert.equal(last.auth, "Basic " + Buffer.from("alice:alice-token").toString("base64"));
  assert.deepEqual(last.body, { jsonrpc: "2.0", id: (last.body as { id: number }).id, method: "getVersion" });
  assert.deepEqual(await kb.call(ALICE, "getTask", { task_id: 7 }), { id: 7, title: "T" });
  assert.equal(await kb.call(ALICE, "updateTask", { id: 7 }), false, "a false result is returned as such; the tools decide what it means");
});

test("kanboard: wrong credentials are a KanboardError with unauthorized set", async () => {
  const e = await kb.call({ username: "alice", token: "wrong" }, "getVersion").catch((x) => x);
  assert.ok(e instanceof KanboardError);
  assert.equal(e.unauthorized, true);
  assert.equal(e.forbidden, false);
  assert.equal(e.kind, "rpc");
});

test("kanboard: a 403 and an unknown method are KanboardErrors with the code", async () => {
  const forbidden = await kb.call(ALICE, "getAllLinks").catch((x) => x);
  assert.ok(forbidden instanceof KanboardError);
  assert.equal(forbidden.forbidden, true);
  assert.equal(forbidden.status, 403);
  assert.match(forbidden.message, /Kanboard refused getAllLinks: Forbidden/);
  const unknown = await kb.call(ALICE, "nope").catch((x) => x);
  assert.equal((unknown as KanboardError).code, -32601);
});

test("kanboard: a batch returns results and errors in call order", async () => {
  const [v, t, links, missing] = await kb.batch(ALICE, [{ method: "getVersion" }, { method: "getTask", params: { task_id: 3 } }, { method: "getAllLinks" }, { method: "nope" }]);
  assert.equal(v, "v1.2.57");
  assert.deepEqual(t, { id: 3, title: "T" });
  assert.ok(links instanceof KanboardError && links.forbidden);
  assert.ok(missing instanceof KanboardError && missing.code === -32601);
  assert.deepEqual(await kb.batch(ALICE, []), []);
});

test("kanboard: no answer is a network error, not an exception of another kind", async () => {
  const lonely = new Kanboard("http://127.0.0.1:1/jsonrpc.php", 1000);
  const e = await lonely.call(ALICE, "getVersion").catch((x) => x);
  assert.ok(e instanceof KanboardError);
  assert.equal(e.kind, "network");
  assert.match(e.message, /did not answer getVersion/);
});
