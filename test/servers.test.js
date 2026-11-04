"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { parseListeners, parseStat } = require("../lib/procs");
const { servers, describe, mainPort } = require("../lib/servers");
const { opener } = require("../lib/open");

// A process table from [pid, ppid, argv, extra] rows, children filled in.
function procs(rows) {
  const table = new Map(rows.map(([pid, ppid, argv, extra = {}]) => [pid, { pid, ppid, argv, comm: argv[0], cwd: "/work/app", startedSecs: 100, rssKb: 1024, children: [], ...extra }]));
  for (const proc of table.values()) table.get(proc.ppid)?.children.push(proc.pid);
  return table;
}

test("ss output becomes the ports each process listens on", () => {
  const text = [
    "LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:((\"node\",pid=41,fd=28))",
    "LISTEN 0 511 [::1]:3000 [::]:* users:((\"node\",pid=41,fd=29))",
    "LISTEN 0 511 127.0.0.1:9229 0.0.0.0:* users:((\"node\",pid=41,fd=30))",
    "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*",
    "",
  ].join("\n");
  assert.deepStrictEqual([...parseListeners(text)], [[41, [3000, 9229]]], "a port on two addresses counts once; one without a pid is not ours");
});

test("a /proc stat line is read from after its command, which may hold spaces and parentheses", () => {
  const fields = "S 7 7 0 0 0 0 0 0 0 0 0 0 0 0 20 0 1 0 2880178 4080 140529".split(" ");
  const stat = parseStat(`42 (node (worker) x) ${fields.join(" ")}`);
  assert.deepStrictEqual(stat, { comm: "node (worker) x", ppid: 7, pgid: 7, start: 2880178, rssPages: 140529 });
});

test("a server's processes group under the command that started them, with the pane and agent behind it", () => {
  const table = procs([
    [10, 1, ["herdr"]],
    [20, 10, ["bash"]],
    [30, 20, ["claude", "--resume", "x"]],
    [40, 30, ["sh", "-c", "pnpm dev"]],
    [50, 40, ["node", "/home/t/.local/share/pnpm/pnpm", "dev"]],
    [60, 50, ["node", "node_modules/vite/bin/vite.js", "dev"]],
    [70, 60, ["workerd", "serve"]],
    [80, 1, ["python3", "-m", "http.server", "8000"], { cwd: "/tmp/site" }],
    [90, 30, ["claude-helper"]],
  ]);
  const list = servers({
    ports: new Map([[60, [3000, 9229]], [70, [45275]], [80, [8000]], [30, [41111]]]),
    procs: table,
    shells: new Map([[20, { pane: "w1:p1", label: "app" }]]),
    now: 160,
  });
  assert.strictEqual(list.length, 2, "an agent's own port is not a server");
  const [vite, stray] = list;
  assert.strictEqual(vite.root, 40);
  assert.strictEqual(vite.command, "pnpm dev");
  assert.deepStrictEqual(vite.ports, [3000, 9229, 45275]);
  assert.strictEqual(vite.port, 3000);
  assert.strictEqual(vite.via, "claude");
  assert.strictEqual(vite.pane.pane, "w1:p1");
  assert.deepStrictEqual(vite.pids.sort(), [40, 50, 60, 70], "stopping it takes its workers too");
  assert.strictEqual(vite.rssKb, 4 * 1024);
  assert.strictEqual(vite.uptimeSecs, 60);
  assert.strictEqual(stray.pane, null, "one left behind is listed outside Herdr");
  assert.strictEqual(stray.project, "site");
});

test("a server run straight from an interactive shell starts at its own command", () => {
  const table = procs([[20, 1, ["-bash"]], [30, 20, ["npm", "run", "dev"]], [40, 30, ["node", "server.js"]]]);
  const [server] = servers({ ports: new Map([[40, [5173]]]), procs: table, shells: new Map(), now: 100 });
  assert.strictEqual(server.root, 30);
  assert.strictEqual(server.command, "npm run dev");
  assert.strictEqual(server.via, null);
});

test("names read the way you would type them, and the main port is not the debugger's", () => {
  assert.strictEqual(describe(["node", "./node_modules/.bin/../.pnpm/vite@8/node_modules/vite/bin/vite.js", "dev"]), "vite dev");
  assert.strictEqual(describe(["node", "node_modules/@scope/tool/cli.js"]), "@scope/tool");
  assert.strictEqual(describe(["bash", "-c", "make serve"]), "make serve");
  assert.strictEqual(describe(["/usr/bin/python3", "-m", "http.server"]), "python3 -m http.server");
  assert.strictEqual(mainPort([3000, 9229]), 3000);
  assert.strictEqual(mainPort([9229, 45275]), 9229, "with nothing better, the lowest");
  assert.strictEqual(mainPort([4321, 45275]), 4321);
});

test("a URL opens in the Windows browser under WSL, and the usual opener elsewhere", () => {
  const url = "http://localhost:3000";
  assert.deepStrictEqual(opener(url, {}, "darwin"), ["open", url]);
  assert.deepStrictEqual(opener(url, {}, "linux"), ["xdg-open", url]);
  assert.ok(["wslview", "explorer.exe"].includes(opener(url, { WSL_DISTRO_NAME: "Ubuntu" }, "linux")[0]));
});
