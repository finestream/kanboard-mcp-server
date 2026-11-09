// The acceptance test of a running server, from any machine that reaches it, as
// one agent: prints PASS or FAIL per check and exits 0 when all passed, 1
// otherwise, 2 when it could not run.
//
//   MCP_URL=https://kanboard-mcp.example.org/mcp MCP_BEARER=… MCP_PROJECT_ID=2 [MCP_TASK_ID=927] [MCP_COMMENT=yes] node scripts/acceptance.ts
//
// With MCP_TASK_ID the task is read; with MCP_COMMENT=yes a comment is added to
// it and then changed, so the write path is seen too. Through Cloudflare Access
// a static bearer is not accepted; run it against the direct route.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = process.env.MCP_URL;
const BEARER = process.env.MCP_BEARER;
const PROJECT = Number(process.env.MCP_PROJECT_ID);
const TASK = process.env.MCP_TASK_ID ? Number(process.env.MCP_TASK_ID) : null;
const COMMENT = process.env.MCP_COMMENT === "yes";
if (!URL_ || !BEARER || !Number.isInteger(PROJECT)) {
  console.error("usage: MCP_URL=https://host/mcp MCP_BEARER=… MCP_PROJECT_ID=<id> [MCP_TASK_ID=<id>] [MCP_COMMENT=yes] node scripts/acceptance.ts");
  process.exit(2);
}

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

type Result = { text: string; data: Record<string, any> | undefined; isError: boolean };
async function connect(bearer: string) {
  const client = new Client({ name: "acceptance", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_!), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  return {
    async call(tool: string, args: Record<string, unknown> = {}): Promise<Result> {
      const r = (await client.callTool({ name: tool, arguments: args })) as { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, any>; isError?: boolean };
      return { text: r.content.map((c) => c.text ?? "").join("\n"), data: r.structuredContent, isError: r.isError === true };
    },
    close: () => client.close(),
  };
}

const origin = new URL(URL_).origin;
try {
  const health = await fetch(`${origin}/healthz`).catch(() => null);
  check("/healthz answers 200 with ok and version", health?.status === 200, health ? JSON.stringify(await health.json()) : "no answer (behind a tunnel it is not published; that is fine)");
} catch {}

const wrong = await connect("not-the-bearer").then(() => "connected", (e: Error) => e.message);
check("a wrong bearer is refused with 401", /401|Unauthorized|-32001/.test(wrong), wrong.slice(0, 80));

const me = await connect(BEARER!).catch((e: Error) => {
  console.error(`cannot connect: ${e.message}`);
  process.exit(2);
});
try {
  const who = await me.call("get_me");
  check("get_me names the Kanboard user", !who.isError && typeof who.data?.username === "string", who.isError ? who.text : `${who.data!.username}, time zone ${who.data!.timezone}`);
  const projects = await me.call("get_projects");
  const project = projects.data?.projects?.find((p: any) => p.id === PROJECT);
  check(`get_projects lists project ${PROJECT}`, !!project, project ? project.name : projects.text.slice(0, 120));
  const columns = await me.call("get_columns", { project_id: PROJECT });
  check("get_columns lists the columns", !columns.isError && columns.data!.columns.length > 0, columns.isError ? columns.text : columns.data!.columns.map((c: any) => c.title).join(", "));
  const search = await me.call("search_tasks", { project_id: PROJECT, query: "status:open" });
  check("search_tasks finds open tasks with tags", !search.isError && Array.isArray(search.data!.tasks), search.isError ? search.text : `${search.data!.count} task(s)`);
  if (TASK) {
    const task = await me.call("get_task_details", { task_id: TASK, include_comments: true });
    check(`get_task_details reads task ${TASK} with tags, links and comments`, !task.isError && Array.isArray(task.data!.comments), task.isError ? task.text : `"${task.data!.title}", ${task.data!.tags.length} tag(s), ${task.data!.comments.length} comment(s)`);
    if (COMMENT && !task.isError) {
      const added = await me.call("add_task_comment", { task_id: TASK, comment: `Acceptance test of kanboard-mcp-server, ${new Date().toISOString()}` });
      check("add_task_comment writes as the user", !added.isError && typeof added.data?.comment_id === "number", added.isError ? added.text : `comment ${added.data!.comment_id}`);
      if (!added.isError) {
        const changed = await me.call("update_task_comment", { comment_id: added.data!.comment_id, comment: `Acceptance test of kanboard-mcp-server, ${new Date().toISOString()} (updated)` });
        check("update_task_comment changes the own comment", !changed.isError, changed.text.slice(0, 120));
      }
    }
  }
  const refused = await me.call("get_columns", { project_id: 999999 });
  check("a project the user may not see is refused with Kanboard's 403, not an error", refused.isError && /403/.test(refused.text), refused.text.slice(0, 100));
} finally {
  await me.close();
}
process.exit(failed ? 1 : 0);
