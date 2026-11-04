"use strict";

// Detached worker, run after the popup has closed: go to a folder, reopen a
// session, or hand a folder to Quick Prompt. It takes its own snapshot, so
// what it acts on is what Herdr has now, not what the popup saw.

const path = require("node:path");
const { run, notify, HerdrError } = require("../lib/shared/herdr");
const { workspaceFor, paneRunning } = require("../lib/place");

// Herdr opens one popup at a time, and says ui_busy until ours is gone.
const POPUP_ATTEMPTS = 20;
const POPUP_RETRY_MS = 50;
const START_ATTEMPTS = 12;
// A new shell is usually up within a few hundred milliseconds, so the first
// retries come quickly and only later ones wait the full 400ms.
const startRetryMs = (attempt) => Math.min(400, 50 * 2 ** attempt);
const START_TIMEOUT_MS = 15000;

const RESUME = {
  claude: (id) => ["--resume", id],
  codex: (id) => ["resume", id],
};

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function snapshot() {
  const res = run(["api", "snapshot"], { check: false });
  return res.ok ? res.result.snapshot : null;
}

// Names must match [a-z][a-z0-9_-]{0,31} and be unique among live agents. The
// pane is unique already, so no lookup is needed.
const agentName = (kind, pane) => `pj-${kind}-${pane}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 32);

// A shell for the folder: a new tab in the workspace already working there,
// or a new workspace named after it. Returns the pane and how to undo it.
function shellIn(folder, current) {
  const workspace = workspaceFor(current, folder);
  if (workspace) {
    const { result } = run(["tab", "create", "--workspace", workspace, "--cwd", folder, "--focus"]);
    run(["workspace", "focus", workspace], { check: false });
    return { pane: result.root_pane?.pane_id, undo: ["tab", "close", result.tab?.tab_id] };
  }
  const { result } = run(["workspace", "create", "--cwd", folder, "--label", path.basename(folder), "--focus"]);
  return { pane: result.root_pane?.pane_id, undo: ["workspace", "close", result.workspace?.workspace_id] };
}

function startAgent(pane, kind, args) {
  const start = ["agent", "start", agentName(kind, pane), "--kind", kind, "--pane", pane, "--timeout", String(START_TIMEOUT_MS), "--", ...args];
  let last = `${kind} did not start`;
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
    const res = run(start, { check: false });
    // Up but not idle, or not ready in time, still means it is running.
    if (res.ok || res.code === "timeout" || /agent_not_ready/i.test(`${res.code ?? ""} ${res.message}`)) return;
    last = res.message;
    // A busy pane is a shell still starting; anything else will not get better.
    if (!/pane|shell|prompt|busy|not_available/i.test(`${res.code ?? ""} ${last}`)) break;
    sleep(startRetryMs(attempt));
  }
  throw new HerdrError(last);
}

const JOBS = {
  folder({ folder }) {
    const workspace = workspaceFor(snapshot(), folder);
    if (workspace) return void run(["workspace", "focus", workspace]);
    run(["workspace", "create", "--cwd", folder, "--label", path.basename(folder), "--focus"]);
  },

  // A session already open is gone to, never started twice.
  session({ kind, id, folder, cwd }) {
    const current = snapshot();
    const running = paneRunning(current, id);
    if (running) return void run(["agent", "focus", running]);
    const { pane, undo } = shellIn(cwd ?? folder, current);
    if (!pane) throw new HerdrError("herdr did not return a pane for the session");
    try {
      startAgent(pane, kind, RESUME[kind](id));
    } catch (error) {
      if (undo.every(Boolean)) run(undo, { check: false });
      throw error;
    }
  },

  launch({ folder }) {
    const args = ["plugin", "pane", "open", "--plugin", "taanviir.quick-prompt", "--entrypoint", "picker", "--env", `QUICK_PROMPT_CWD=${folder}`];
    const workspace = workspaceFor(snapshot(), folder);
    if (workspace) args.push("--env", `QUICK_PROMPT_WORKSPACE=${workspace}`);
    for (let attempt = 1; ; attempt += 1) {
      const res = run(args, { check: false });
      if (res.ok) return;
      if (res.code !== "ui_busy" || attempt === POPUP_ATTEMPTS) throw new HerdrError(res.message);
      sleep(POPUP_RETRY_MS);
    }
  },
};

function main(argument) {
  try {
    const job = JSON.parse(argument);
    JOBS[job.type](job);
  } catch (error) {
    notify("Projects failed", error.message ?? String(error));
    process.exitCode = 1;
  }
}

if (require.main === module) main(process.argv[2]);

module.exports = JOBS;
