"use strict";

// The popup: your projects on the left, most recent first, and the selected
// one's past Claude and Codex sessions on the right. ⏎ on a project goes to
// its workspace; tab steps into its sessions, where ⏎ reopens one. A project
// with a dev server running shows its port, and can open or stop it.
//
// It opens on what was indexed last time and catches up in a background
// thread, so a cold start never holds up keys.

const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { roots, checkouts, folders: gather, inside } = require("../lib/folders");
const { fromCache } = require("../lib/sessions");
const { score } = require("../lib/fuzzy");
const { workspaceFor, paneRunning } = require("../lib/place");
const { listeners, table, uptimeSecs } = require("../lib/procs");
const { servers: findServers } = require("../lib/servers");
const { opener } = require("../lib/open");
const { results: ciResults, shown: ciShown } = require("../lib/ci");
const { Editor } = require("../lib/shared/editor");
const { style, truncate, shortenPath, displayWidth } = require("../lib/shared/ui");
const { runAsync, spawnDetached } = require("../lib/shared/herdr");
const { STATE_DIR, start, editKey } = require("../lib/shared/term");
const { strip, switchFor, switchTo } = require("../lib/shared/tabs");

const ACT = path.join(__dirname, "act.js");
const INDEXER = path.join(__dirname, "..", "lib", "indexer.js");
const CACHE = path.join(STATE_DIR, "sessions.json");
const SERVERS_MS = 2000;
const NAME_BONUS = 20;
const LEFT = 34;
const ICON = { claude: style.warn("✻"), codex: style.accent("◎") };

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(cache) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(`${CACHE}.tmp`, JSON.stringify(cache));
    fs.renameSync(`${CACHE}.tmp`, CACHE);
  } catch { /* the next popup indexes again */ }
}

const cached = readCache();
const repos = roots().flatMap((root) => checkouts(root));

// Where the popup was opened from, by its key or from another tab.
const origin = { cwd: process.env.PROJECTS_CWD, workspace: process.env.PROJECTS_WORKSPACE, pane: process.env.PROJECTS_PANE };

const state = {
  query: new Editor(),
  sessions: [],
  projects: [],
  ci: {}, // the last CI watch per checkout, from ci.json
  servers: [], // running dev servers, each with the project it belongs to
  focus: "projects", // or "sessions"
  project: null, // the selected project's path
  session: null, // the selected session's id
  snapshot: null,
  indexing: true,
  confirmStop: null, // the server root pid ctrl+x was pressed on once
  notice: null,
};

function apply(sessions) {
  state.sessions = sessions;
  state.projects = gather(sessions, repos);
  memo = null;
}

// A server belongs to the deepest project holding its folder; one in a folder
// no project covers gets a project of its own.
function lookForServers() {
  const found = findServers({ ports: listeners(), procs: table(), shells: new Map(), now: uptimeSecs() });
  for (const server of found) {
    let home = null;
    for (const project of state.projects) {
      if (server.cwd && inside(server.cwd, project.path) && (!home || project.path.length > home.path.length)) home = project;
    }
    if (!home && server.cwd) {
      home = { path: server.cwd, name: path.basename(server.cwd), sessions: [], updated: 0 };
      state.projects.push(home);
      memo = null;
    }
    server.project = home?.path ?? null;
  }
  state.servers = found;
  state.ci = ciResults(path.join(STATE_DIR, "ci.json"));
  if (state.confirmStop && !found.some((server) => server.root === state.confirmStop)) state.confirmStop = null;
}

const serverOf = (project) => state.servers.find((server) => server.project === project?.path) ?? null;

// The last CI watch on the project's checkout, from `prefix+i` or a push.
const ciOf = (project) => ciShown(state.ci?.[project?.path]);
const CI_MARK = { running: style.warn("◌"), pass: style.ok("✓"), fail: style.danger("✗") };

/* ---------- what is listed ---------- */

const firstLine = (text) => (text ?? "").split("\n").find((line) => line.trim())?.trim() ?? "";
const titleOf = (session) => session.title || firstLine(session.prompt) || "(no prompt)";

function age(ms, now = Date.now()) {
  if (!ms) return "";
  const minutes = Math.floor((now - ms) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  const days = Math.floor(minutes / 1440);
  if (days < 30) return `${days}d`;
  return days < 365 ? `${Math.floor(days / 30)}mo` : `${Math.floor(days / 365)}y`;
}

function duration(secs) {
  const minutes = Math.floor(secs / 60);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

const containsAll = (words, text) => {
  const haystack = text.toLowerCase();
  return words.every((word) => haystack.includes(word));
};

// The projects the search matches, each with its sessions that match. A
// project matches by its name or folder, or by any of its sessions; with no
// search, every project and every session.
let memo = null;
function listed() {
  const query = state.query.text.trim();
  if (memo?.query === query && memo.count === state.projects.length) return memo.projects;
  let projects;
  if (!query) {
    projects = state.projects.map((project) => ({ project, sessions: project.sessions }));
  } else {
    const words = query.toLowerCase().split(/\s+/);
    projects = state.projects.flatMap((project) => {
      const named = score(query, project.name);
      const own = named ?? score(query, project.path);
      // Letters in order are fine for a short name, but would match almost any
      // long prompt, so a session needs every word as it was typed.
      const sessions = project.sessions.filter((session) => containsAll(words, `${titleOf(session)} ${session.prompt} ${session.branch ?? ""}`));
      if (own === null && !sessions.length) return [];
      return [{ project, sessions: own === null ? sessions : project.sessions, points: (own ?? 0) + (named === null ? 0 : NAME_BONUS) + sessions.length }];
    });
    projects.sort((a, b) => b.points - a.points || b.project.updated - a.project.updated);
  }
  memo = { query, count: state.projects.length, projects };
  return projects;
}

// The selection, falling back to the project you came from, then the first.
function current() {
  const projects = listed();
  let at = projects.findIndex((entry) => entry.project.path === state.project);
  if (at < 0 && origin.cwd && state.query.isEmpty) {
    projects.forEach((entry, i) => {
      if (inside(origin.cwd, entry.project.path) && (at < 0 || entry.project.path.length > projects[at].project.path.length)) at = i;
    });
  }
  at = Math.max(0, at);
  const entry = projects[at] ?? null;
  const sessionAt = entry ? Math.max(0, entry.sessions.findIndex((session) => session.id === state.session)) : 0;
  return { projects, at, entry, sessionAt, session: entry?.sessions[sessionAt] ?? null };
}

function move(delta) {
  const { projects, at, entry, sessionAt } = current();
  if (state.focus === "sessions" && entry?.sessions.length) {
    state.session = entry.sessions[Math.max(0, Math.min(entry.sessions.length - 1, sessionAt + delta))].id;
    return;
  }
  if (!projects.length) return;
  state.project = projects[Math.max(0, Math.min(projects.length - 1, at + delta))].project.path;
  state.session = null;
  state.confirmStop = null;
}

/* ---------- painting ---------- */

function spread(left, right, width) {
  const gap = width - displayWidth(left) - displayWidth(right);
  return gap >= 1 ? `${left}${" ".repeat(gap)}${right}` : truncate(left, width);
}

function projectRow({ project }, width, chosen) {
  const bar = chosen ? (state.focus === "projects" ? style.accent("┃") : style.dim("┃")) : " ";
  const open = workspaceFor(state.snapshot, project.path);
  const server = serverOf(project);
  const ci = ciOf(project);
  const right = `${ci ? CI_MARK[ci.state] + " " : ""}${server ? style.ok(`:${server.port}`) + " " : ""}${style.dim(age(project.updated))}`;
  const name = chosen ? style.bright(style.bold(project.name)) : style.bold(project.name);
  const left = `${open ? style.ok("●") : " "} ${name}`;
  return bar + spread(truncate(left, width - 2 - displayWidth(right)), right, width - 1);
}

function sessionRow(session, width, chosen) {
  const bar = chosen ? style.accent("┃") : " ";
  const running = paneRunning(state.snapshot, session.id);
  const right = style.dim(age(session.updated));
  const title = chosen ? style.bright(titleOf(session)) : titleOf(session);
  const left = `${running ? style.ok("●") : ICON[session.kind]} ${title}`;
  return bar + spread(truncate(left, width - 2 - displayWidth(right)), right, width - 1);
}

function window(count, at, rows) {
  return Math.max(0, Math.min(at - Math.floor(rows / 2), count - rows));
}

function leftColumn({ projects, at }, rows) {
  if (!projects.length) {
    return [style.dim(state.indexing && !state.sessions.length ? " reading your history…" : " nothing matches")];
  }
  const first = window(projects.length, at, rows);
  return projects.slice(first, first + rows).map((entry, i) => projectRow(entry, LEFT, first + i === at));
}

function rightColumn({ entry, sessionAt }, width, rows) {
  if (!entry) return [];
  const { project, sessions } = entry;
  const open = workspaceFor(state.snapshot, project.path);
  const label = (state.snapshot?.workspaces ?? []).find((w) => w.workspace_id === open)?.label;
  const out = [spread(style.dim(truncate(shortenPath(project.path, width), width - 14)), open ? style.ok(`● ${truncate(label ?? "open", 12)}`) : "", width)];
  const server = serverOf(project);
  if (server) {
    const stats = style.dim(`${duration(server.uptimeSecs)} · ${Math.round(server.rssKb / 1024)} MB`);
    out.push(spread(`${style.ok("▶")} ${truncate(server.command, width - 26)} ${style.ok(`:${server.port}`)}`, stats, width));
  }
  const ci = ciOf(project);
  if (ci) {
    const what = { running: "CI running", pass: "CI passed", fail: `CI failed${ci.failed?.length ? `: ${ci.failed.join(", ")}` : ""}` }[ci.state];
    out.push(spread(`${CI_MARK[ci.state]} ${truncate(what, width - 22)}`, style.dim(`${ci.sha.slice(0, 7)} · ${age(ci.at)}`), width));
  }
  out.push("");
  if (!sessions.length) {
    out.push(style.dim("No sessions here yet. ctrl+n starts one."));
    return out;
  }
  const room = rows - out.length;
  const chosen = state.focus === "sessions" ? sessionAt : -1;
  const first = chosen < 0 ? 0 : window(sessions.length, chosen, room);
  out.push(...sessions.slice(first, first + room).map((session, i) => sessionRow(session, width, first + i === chosen)));
  return out;
}

// What ⏎ will do, or what the selected session was about.
function detail({ entry, session }, width) {
  if (state.confirmStop) {
    const server = state.servers.find((s) => s.root === state.confirmStop);
    return style.danger(truncate(`ctrl+x again stops ${server?.command ?? "it"} on :${server?.port} · any other key keeps it`, width));
  }
  if (state.notice) return style.warn(truncate(state.notice, width));
  if (state.focus === "sessions" && session) {
    const where = paneRunning(state.snapshot, session.id) ? "⏎ goes to it, open in Herdr" : "⏎ reopens it";
    return style.dim(truncate(`${where} · ${firstLine(session.prompt) || "no prompt"}`, width));
  }
  if (!entry) return "";
  const go = workspaceFor(state.snapshot, entry.project.path) ? "⏎ goes to its workspace" : "⏎ opens a workspace here";
  const server = serverOf(entry.project);
  return style.dim(truncate(`${go}${server ? ` · ctrl+o opens :${server.port} · ctrl+x stops it` : ""}`, width));
}

function footer() {
  const step = state.focus === "projects" ? ["tab", "its sessions"] : ["tab", "back to projects"];
  const pairs = [["↑↓", "choose"], ["⏎", state.focus === "projects" ? "go" : "reopen"], step, ["ctrl+n", "new agent"], ["esc", "close"]];
  return pairs.map(([key, what]) => `${style.bright(key)} ${style.dim(what)}`).join("   ");
}

function body(width, height) {
  const view = current();
  const running = state.servers.length ? ` · ${state.servers.length} running` : "";
  const summary = style.dim(`${state.projects.length} projects${running}${state.indexing ? " · updating…" : ""}`);
  const query = state.query.isEmpty ? style.dim("search projects and sessions…") : state.query.text;
  const right = width - LEFT - 3;
  const lines = [
    strip("projects", width, summary),
    `${style.accent("›")} ${truncate(query, width - 2)}`,
    style.dim(`${"─".repeat(LEFT)}─┬─${"─".repeat(right)}`),
  ];
  const rows = Math.max(3, height - lines.length - 2);
  const left = leftColumn(view, rows);
  const shown = rightColumn(view, right, rows);
  for (let i = 0; i < rows; i += 1) lines.push(`${spread(left[i] ?? "", "", LEFT)} ${style.dim("│")} ${shown[i] ?? ""}`);
  lines.push(detail(view, width), footer());
  const { caret } = state.query.layout(width - 2);
  return { lines, caret: { row: 1, col: 2 + Math.min(caret.col, width - 3) } };
}

/* ---------- keys ---------- */

function act(job) {
  spawnDetached(process.execPath, [ACT, JSON.stringify(job)]);
  ui.quit(0);
}

function go() {
  const { entry, session } = current();
  if (!entry) return;
  if (state.focus === "projects" || !session) return act({ type: "folder", folder: entry.project.path });
  // Claude finds a session by the folder it ran in, so it reopens there when
  // that folder still exists.
  const cwd = fs.existsSync(session.cwd) ? session.cwd : session.folder;
  act({ type: "session", kind: session.kind, id: session.id, folder: session.folder, cwd });
}

// Everything the server started goes too, or its workers would hold the ports.
function stop(server) {
  for (const pid of server.pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch { /* already gone */ }
  }
  state.notice = `stopped ${server.command}`;
  state.confirmStop = null;
  setTimeout(() => {
    lookForServers();
    ui.scheduleRender();
  }, 300);
}

function onKey(chunk, key) {
  const { entry } = current();
  const server = serverOf(entry?.project);
  if (key.ctrl && key.name === "x" && server) {
    if (state.confirmStop === server.root) return stop(server);
    state.confirmStop = server.root;
    return;
  }
  state.confirmStop = null;
  state.notice = null;

  const tab = switchFor(key, "projects");
  if (tab && tab.id !== "projects") {
    const folder = entry?.project.path ?? origin.cwd;
    return switchTo(tab, { cwd: folder, workspace: workspaceFor(state.snapshot, folder) ?? origin.workspace, pane: origin.pane }, () => clearInterval(serverTimer));
  }
  const name = key.name;
  if (name === "up" || name === "down") return move(name === "up" ? -1 : 1);
  if (name === "pageup" || name === "pagedown") return move(name === "pageup" ? -10 : 10);
  if (name === "tab") {
    state.focus = state.focus === "projects" && entry?.sessions.length ? "sessions" : "projects";
    return;
  }
  if (name === "return" || name === "enter") return go();
  if (key.ctrl && name === "n" && entry) return act({ type: "launch", folder: entry.project.path });
  if (key.ctrl && name === "o" && server) {
    const [command, ...args] = opener(`http://localhost:${server.port}`);
    spawnDetached(command, args);
    state.notice = `opening http://localhost:${server.port}`;
    return;
  }
  const before = state.query.text;
  editKey(state.query, chunk, key);
  if (state.query.text !== before) {
    state.project = null;
    state.session = null;
    state.focus = "projects";
  }
}

// One step back at a time: out of the sessions, the search, then the popup.
function onEscape() {
  state.confirmStop = null;
  if (state.focus === "sessions") {
    state.focus = "projects";
    return;
  }
  if (!state.query.isEmpty) {
    state.query.clear();
    state.project = null;
    return;
  }
  ui.quit(0);
}

/* ---------- boot ---------- */

apply(fromCache(cached));
lookForServers();

const ui = start({
  title: "Projects",
  name: "picker",
  body,
  onKey,
  onPaste: (text) => {
    state.query.insert(text.replace(/\s+/g, " "));
    state.project = null;
  },
  onEscape,
});

runAsync(["api", "snapshot"], { timeout: 1500 }).then((res) => {
  if (res.ok) state.snapshot = res.result.snapshot ?? null;
  ui.scheduleRender();
});

const serverTimer = setInterval(() => {
  lookForServers();
  ui.scheduleRender();
}, SERVERS_MS);

const worker = new Worker(INDEXER, { workerData: cached });
worker.once("message", ({ sessions, cache }) => {
  apply(sessions);
  lookForServers();
  state.indexing = false;
  writeCache(cache);
  ui.scheduleRender();
});
worker.once("error", (error) => {
  state.indexing = false;
  state.notice = `could not read the session history: ${error.message}`;
  ui.scheduleRender();
});
