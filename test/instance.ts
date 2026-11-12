// node test/instance.ts up|down|env
//
// The Kanboard test instance of this working copy. The compose project name and
// the port come from the working copy, so two working copies (several agents,
// or a person and an agent) never share an instance:
//
//   branch claude/task-<id>-…   project kbmcp-test-<id>, port 10000+<id>
//   another linked worktree     project kbmcp-test-<hash of the path>, port 20000-39999
//   a plain clone, and CI       project kbmcp-test, port 8580
//
// COMPOSE_PROJECT_NAME and KB_PORT in the environment win over all of these.
//
//   up    starts the instance, bootstraps it and writes test/.state/env
//   down  removes the instance with its volume (down -v) and test/.state/env
//   env   prints the project, port, URL and container name as KEY=value lines

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const COMPOSE_FILE = fileURLToPath(new URL("./compose.yaml", import.meta.url));
const STATE_DIR = new URL("./.state/", import.meta.url);
const STATE_FILE = new URL("./.state/env", import.meta.url);

export const DEFAULT_PROJECT = "kbmcp-test";
export const DEFAULT_PORT = 8580;

export type Instance = { project: string; port: number; url: string; container: string };

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** The instance of this working copy. */
export function derive(): Instance {
  let project = DEFAULT_PROJECT;
  let port = DEFAULT_PORT;
  if (process.env.GITHUB_ACTIONS !== "true") {
    const task = git("branch", "--show-current").match(/^claude\/task-(\d+)(?:-|$)/)?.[1];
    const linked = git("rev-parse", "--git-dir") !== git("rev-parse", "--git-common-dir");
    if (task) {
      project = `${DEFAULT_PROJECT}-${task}`;
      port = 10000 + Number(task);
    } else if (linked) {
      const n = createHash("sha256").update(ROOT).digest().readUInt32BE(0);
      project = `${DEFAULT_PROJECT}-${n.toString(16).slice(0, 6)}`;
      port = 20000 + (n % 20000);
    }
  }
  project = process.env.COMPOSE_PROJECT_NAME || project;
  port = Number(process.env.KB_PORT) || port;
  return { project, port, url: `http://127.0.0.1:${port}`, container: `${project}-kanboard-1` };
}

function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status ?? r.signal})`);
}

function compose(inst: Instance, ...args: string[]) {
  run("docker", ["compose", "-p", inst.project, "-f", COMPOSE_FILE, ...args], { KB_PORT: String(inst.port) });
}

/** Starts the instance (a no-op if it runs), writes this working copy's test/.state/env and bootstraps the fixtures. */
export function up(inst: Instance = derive()): Instance {
  compose(inst, "up", "-d", "--wait");
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, `COMPOSE_PROJECT_NAME=${inst.project}\nKB_PORT=${inst.port}\nKB_URL=${inst.url}/jsonrpc.php\nKB_CONTAINER=${inst.container}\n`);
  run(process.execPath, [fileURLToPath(new URL("./bootstrap.ts", import.meta.url))], { KB_URL: `${inst.url}/jsonrpc.php` });
  return inst;
}

/** Removes the instance with its volume, and the state that belonged to it. */
export function down(inst: Instance = derive()) {
  compose(inst, "down", "-v");
  rmSync(STATE_FILE, { force: true });
}

if (import.meta.main) {
  const cmd = process.argv[2];
  const inst = derive();
  if (cmd === "up") {
    up(inst);
    console.log(`instance ${inst.project} at ${inst.url}`);
  } else if (cmd === "down") {
    down(inst);
  } else if (cmd === "env") {
    console.log([`COMPOSE_PROJECT_NAME=${inst.project}`, `KB_PORT=${inst.port}`, `KB_URL=${inst.url}/jsonrpc.php`, `KB_CONTAINER=${inst.container}`].join("\n"));
  } else {
    console.error("usage: node test/instance.ts up|down|env");
    process.exit(2);
  }
}
