// node test/instance.ts up|down|env
//
// The Kanboard test instance of this working copy. The compose project name and
// the port come from the working copy, so two working copies (several agents,
// or a person and an agent) never share an instance:
//
//   branch claude/task-<id>-…   project kbmcp-test-<id>, port 10000+<id> (ids up to 9999)
//   another linked worktree     project kbmcp-test-<hash of the path>, port 20000-39999
//   a plain clone, and CI       project kbmcp-test, port 8580
//
// A task id that does not fit its range gets the hashed project and port, as a worktree does.
// COMPOSE_PROJECT_NAME and KB_PORT in the environment win over all of these. Two checkouts of
// the same task branch on one machine derive the same instance and share it.
//
//   up    starts the instance, bootstraps it and writes test/.state/env; with KB_URL set it
//         starts nothing and bootstraps the instance KB_URL names
//   down  removes the instance with its volume (down -v) and test/.state/env
//   env   prints the project, port, URL and container name as KEY=value lines
//
// `down` and `env` use the instance `up` recorded in test/.state/env, and derive one only when
// there is none, so a branch switch in between does not lose the instance.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const COMPOSE_FILE = fileURLToPath(new URL("./compose.yaml", import.meta.url));
const STATE_DIR = new URL("./.state/", import.meta.url);
const STATE_FILE = new URL("./.state/env", import.meta.url);

export const DEFAULT_PROJECT = "kbmcp-test";
export const DEFAULT_PORT = 8580;
const TASK_PORT_BASE = 10000;
const TASK_PORT_MAX = 19999;

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
    if (task && Number(task) <= TASK_PORT_MAX - TASK_PORT_BASE) {
      project = `${DEFAULT_PROJECT}-${task}`;
      port = TASK_PORT_BASE + Number(task);
    } else if (linked || task) {
      const n = createHash("sha256").update(ROOT).digest().readUInt32BE(0);
      project = `${DEFAULT_PROJECT}-${n.toString(16).slice(0, 6)}`;
      port = 20000 + (n % 20000);
    }
  }
  project = process.env.COMPOSE_PROJECT_NAME || project;
  if (process.env.KB_PORT) {
    port = Number(process.env.KB_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`KB_PORT="${process.env.KB_PORT}" is not a port`);
  }
  return instance(project, port);
}

function instance(project: string, port: number): Instance {
  return { project, port, url: `http://127.0.0.1:${port}`, container: `${project}-kanboard-1` };
}

/** The KEY=value lines of an instance, as `env` prints them and `up` writes them. */
function lines(inst: Instance): string {
  return [`COMPOSE_PROJECT_NAME=${inst.project}`, `KB_PORT=${inst.port}`, `KB_URL=${inst.url}/jsonrpc.php`, `KB_CONTAINER=${inst.container}`].join("\n") + "\n";
}

/** The instance `up` recorded in test/.state/env; one derived from the working copy when there is none. */
export function current(): Instance {
  let state: string;
  try {
    state = readFileSync(STATE_FILE, "utf8");
  } catch {
    return derive();
  }
  const project = state.match(/^COMPOSE_PROJECT_NAME=(.+)$/m)?.[1];
  const port = Number(state.match(/^KB_PORT=(.+)$/m)?.[1]);
  return project && port ? instance(project, port) : derive();
}

function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.error?.message ?? r.status ?? r.signal})`);
}

function compose(inst: Instance, ...args: string[]) {
  run("docker", ["compose", "-p", inst.project, "-f", COMPOSE_FILE, ...args], { KB_PORT: String(inst.port) });
}

function bootstrap(url: string) {
  run(process.execPath, [fileURLToPath(new URL("./bootstrap.ts", import.meta.url))], { KB_URL: url });
}

/** Starts the instance (a no-op if it runs), writes this working copy's test/.state/env and bootstraps the fixtures. */
export function up(inst: Instance = derive()): Instance {
  compose(inst, "up", "-d", "--wait");
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, lines(inst));
  bootstrap(`${inst.url}/jsonrpc.php`);
  return inst;
}

/** Removes the instance with its volume, and the state that belonged to it. */
export function down(inst: Instance = current()) {
  compose(inst, "down", "-v");
  rmSync(STATE_FILE, { force: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === "up" && process.env.KB_URL) {
    bootstrap(process.env.KB_URL);
    console.log(`bootstrapped ${process.env.KB_URL}`);
  } else if (cmd === "up") {
    const inst = up();
    console.log(`instance ${inst.project} at ${inst.url}`);
  } else if (cmd === "down") {
    down();
  } else if (cmd === "env") {
    process.stdout.write(lines(current()));
  } else {
    console.error("usage: node test/instance.ts up|down|env");
    process.exit(2);
  }
}
