"use strict";

// The machine's side: which processes listen on a port, and for any process
// its parent, command line, folder, start time and memory. Linux only: it
// reads /proc and asks `ss`.

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const CLOCK_TICKS = 100;
const PAGE_KB = 4;

// `ss -ltnpH` lines, e.g.
//   LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=418753,fd=28))
// Processes another user owns show no pid and are of no use here.
function parseListeners(text) {
  const ports = new Map();
  for (const line of text.split("\n")) {
    const local = line.trim().split(/\s+/)[3];
    const port = Number(local?.slice(local.lastIndexOf(":") + 1));
    if (!Number.isInteger(port)) continue;
    for (const [, pid] of line.matchAll(/pid=(\d+)/g)) {
      const list = ports.get(Number(pid)) ?? [];
      if (!list.includes(port)) list.push(port);
      ports.set(Number(pid), list);
    }
  }
  return ports;
}

function listeners() {
  const res = spawnSync("ss", ["-ltnpH"], { encoding: "utf8", timeout: 3000 });
  return res.status === 0 ? parseListeners(res.stdout) : new Map();
}

// /proc/<pid>/stat puts the command in parentheses, and a command may contain
// both spaces and parentheses, so fields are counted from the last ")".
function parseStat(text) {
  const close = text.lastIndexOf(")");
  const fields = text.slice(close + 2).split(" ");
  return { comm: text.slice(text.indexOf("(") + 1, close), ppid: Number(fields[1]), pgid: Number(fields[2]), start: Number(fields[19]), rssPages: Number(fields[21]) };
}

const read = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

function proc(pid) {
  const stat = read(`/proc/${pid}/stat`);
  if (!stat) return null;
  const parsed = parseStat(stat);
  let cwd = null;
  try {
    cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch { /* gone, or not ours */ }
  return {
    pid,
    ppid: parsed.ppid,
    pgid: parsed.pgid,
    comm: parsed.comm,
    argv: (read(`/proc/${pid}/cmdline`) ?? "").split("\0").filter(Boolean),
    cwd,
    startedSecs: parsed.start / CLOCK_TICKS,
    rssKb: parsed.rssPages * PAGE_KB,
  };
}

// Every process, by pid, with its children: enough to walk a server up to
// its pane and down to everything it started.
function table() {
  const byPid = new Map();
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const info = proc(Number(name));
    if (info) byPid.set(info.pid, { ...info, children: [] });
  }
  for (const info of byPid.values()) byPid.get(info.ppid)?.children.push(info.pid);
  return byPid;
}

const uptimeSecs = () => Number((read("/proc/uptime") ?? "0").split(" ")[0]);

module.exports = { parseListeners, parseStat, listeners, table, uptimeSecs };
