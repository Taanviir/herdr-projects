"use strict";

// From listening processes to servers. A dev server is often several
// processes (vite and the workers it starts, each with ports of its own), so
// they are grouped under the command that started them: the process just
// below whatever ran it, which is a pane's shell, an agent, an interactive
// shell, or init for one left behind.

const path = require("node:path");

const AGENTS = new Set(["claude", "codex", "pi", "gemini", "cursor-agent", "opencode", "amp", "copilot"]);
const SHELLS = new Set(["bash", "zsh", "fish", "sh", "dash"]);
const WRAPPERS = new Set(["sh", "bash", "zsh", "dash"]);
const INTERPRETERS = new Set(["node", "bun", "deno", "python", "python3"]);
// Node's debugger and the kernel's ephemeral range: ports nobody opens a
// browser on.
const SIDE_PORT = (port) => (port >= 9229 && port <= 9239) || port >= 32768;

// The agent a process is, if any: `claude`, or `node …/claude/cli.js`.
function agentOf(proc) {
  for (const arg of proc?.argv.slice(0, 2) ?? []) {
    const name = path.basename(arg);
    if (AGENTS.has(name)) return name;
  }
  return null;
}

const interactiveShell = (proc) => SHELLS.has(path.basename(proc.argv[0] ?? "").replace(/^-/, "")) && !proc.argv.includes("-c");

// What to call a server: the command an `sh -c` wrapper ran, or the package a
// node_modules path belongs to, so `node …/.pnpm/vite@8/…/vite.js dev` reads
// `vite dev`.
function describe(argv) {
  if (WRAPPERS.has(path.basename(argv[0] ?? "")) && argv[1] === "-c" && argv[2]) return argv[2];
  const words = argv.map((arg) => {
    const at = arg.lastIndexOf("node_modules/");
    if (at < 0) return arg;
    const rest = arg.slice(at + "node_modules/".length).split("/");
    return rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  });
  // `node path/to/pnpm dev` is `pnpm dev`.
  if (INTERPRETERS.has(path.basename(words[0] ?? "")) && words.length > 1 && !words[1].startsWith("-")) words.shift();
  return words.map((word, i) => (i === 0 && !word.startsWith("@") ? path.basename(word) : word)).join(" ");
}

function mainPort(ports) {
  return ports.find((port) => !SIDE_PORT(port)) ?? ports[0];
}

function tree(root, procs) {
  const pids = [];
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop();
    if (pids.includes(pid)) continue;
    pids.push(pid);
    stack.push(...(procs.get(pid)?.children ?? []));
  }
  return pids;
}

// `ports`: pid → ports it listens on. `procs`: pid → process, from
// lib/procs.table. `shells`: a pane's shell pid → that pane. `now`: seconds
// since boot.
function servers({ ports, procs, shells, now }) {
  const byRoot = new Map();
  for (const [pid, list] of ports) {
    const own = procs.get(pid);
    if (!own || agentOf(own) || own.comm === "herdr") continue;

    let root = pid;
    let via = null;
    let at = own.ppid;
    for (;;) {
      const parent = procs.get(at);
      if (!parent || at <= 1 || shells.has(at) || interactiveShell(parent)) break;
      const agent = agentOf(parent);
      if (agent) {
        via = agent;
        break;
      }
      root = at;
      at = parent.ppid;
    }
    // Keep walking for the pane: an agent or a wrapper sits between it and
    // the server.
    let pane = null;
    for (let up = at; up > 1 && procs.has(up); up = procs.get(up).ppid) {
      if (shells.has(up)) {
        pane = shells.get(up);
        break;
      }
    }

    const server = byRoot.get(root) ?? { root, ports: [], pane, via };
    server.ports.push(...list);
    byRoot.set(root, server);
  }

  return [...byRoot.values()].map((server) => {
    const top = procs.get(server.root);
    const pids = tree(server.root, procs);
    const ports = [...new Set(server.ports)].sort((a, b) => a - b);
    const cwd = top.cwd ?? null;
    return {
      ...server,
      pids,
      ports,
      port: mainPort(ports),
      command: describe(top.argv.length ? top.argv : [top.comm]),
      cwd,
      project: cwd ? path.basename(cwd) : top.comm,
      uptimeSecs: Math.max(0, now - top.startedSecs),
      rssKb: pids.reduce((sum, pid) => sum + (procs.get(pid)?.rssKb ?? 0), 0),
    };
  }).sort((a, b) => (a.pane ? 0 : 1) - (b.pane ? 0 : 1) || a.project.localeCompare(b.project) || a.port - b.port);
}

module.exports = { servers, describe, mainPort, agentOf, tree };
