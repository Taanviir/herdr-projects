"use strict";

// Every Claude Code and Codex session you started, read from the files they
// keep: where it ran, what it was about, and when it last changed. A session
// file can run to tens of megabytes, so only its start and end are read, and
// what was found is cached until the file changes.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EDGE_BYTES = 256 * 1024;
const CACHE_VERSION = 1;

const claudeDir = () => process.env.PROJECTS_CLAUDE_DIR ?? path.join(os.homedir(), ".claude", "projects");
const codexDir = () => process.env.PROJECTS_CODEX_DIR ?? path.join(os.homedir(), ".codex");

// Whole JSON lines from the start or the end of a file. The line cut in two at
// the edge is dropped, and so is anything that does not parse.
function edge(file, size, fromEnd) {
  const length = Math.min(EDGE_BYTES, size);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, length, fromEnd ? size - length : 0);
  } finally {
    fs.closeSync(fd);
  }
  let lines = buffer.toString("utf8").split("\n");
  if (length < size) lines = fromEnd ? lines.slice(1) : lines.slice(0, -1);
  return lines.flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => ["text", "input_text", "output_text"].includes(part?.type)).map((part) => part.text).join("\n");
}

// What you typed, as opposed to what the tool put in your name: slash-command
// echoes, caveats, environment blocks and injected AGENTS.md all start with a
// tag or a heading of their own.
const typedByYou = (text) => Boolean(text?.trim()) && !text.trimStart().startsWith("<") && !text.startsWith("# AGENTS.md");

// Sessions started by a script (the Agent SDK, `codex exec`) or by another
// agent (subagents, reviews) are left out: you would never resume them.
function readClaude(file, size) {
  const head = edge(file, size, false);
  const first = head.find((line) => line.type === "user" && line.cwd);
  if (!first || first.isSidechain || (first.entrypoint && first.entrypoint !== "cli")) return null;
  const prompts = head.filter((line) => line.type === "user" && !line.isMeta).map((line) => textOf(line.message?.content));
  const lines = size > EDGE_BYTES ? [...head, ...edge(file, size, true)] : head;
  const named = (type, field) => lines.filter((line) => line.type === type && line[field]).at(-1)?.[field] ?? null;
  return {
    kind: "claude",
    id: path.basename(file, ".jsonl"),
    cwd: first.cwd,
    branch: first.gitBranch || null,
    title: named("custom-title", "customTitle") ?? named("ai-title", "aiTitle"),
    prompt: (prompts.find(typedByYou) ?? "").slice(0, 600),
  };
}

function readCodex(file, size) {
  const head = edge(file, size, false);
  const meta = head.find((line) => line.type === "session_meta")?.payload;
  if (!meta?.cwd || !meta.id) return null;
  if ((meta.thread_source && meta.thread_source !== "user") || meta.originator === "codex_exec") return null;
  const typed = head.filter((line) => line.type === "event_msg" && line.payload?.type === "user_message").map((line) => line.payload.message);
  const sent = head
    .filter((line) => line.type === "response_item" && line.payload?.type === "message" && line.payload.role === "user")
    .map((line) => textOf(line.payload.content));
  return {
    kind: "codex",
    id: meta.id,
    cwd: meta.cwd,
    branch: meta.git?.branch ?? null,
    title: null,
    prompt: (typed.find(typedByYou) ?? sent.find(typedByYou) ?? "").slice(0, 600),
  };
}

// Codex names its threads in one index file, and renames append to it: the
// last name for an id wins. It changes without the session file changing, so
// it is read every time rather than cached.
function codexTitles() {
  const titles = new Map();
  let text = "";
  try {
    text = fs.readFileSync(path.join(codexDir(), "session_index.jsonl"), "utf8");
  } catch {
    return titles;
  }
  for (const line of text.split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (entry.id && entry.thread_name) titles.set(entry.id, entry.thread_name);
    } catch { /* a torn last line */ }
  }
  return titles;
}

function list(dir, test) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(test).map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

// Claude keeps one folder per project, with subagents in folders below it;
// Codex files sessions by year, month and day.
function sessionFiles() {
  const jsonl = (entry) => entry.isFile() && entry.name.endsWith(".jsonl");
  const dirs = (entry) => entry.isDirectory();
  const claude = list(claudeDir(), dirs).flatMap((dir) => list(dir, jsonl)).map((file) => ({ file, kind: "claude" }));
  let days = [path.join(codexDir(), "sessions")];
  for (let depth = 0; depth < 3; depth += 1) days = days.flatMap((dir) => list(dir, dirs));
  const codex = days.flatMap((dir) => list(dir, jsonl)).map((file) => ({ file, kind: "codex" }));
  return [...claude, ...codex];
}

// Returns the sessions, newest first, and the cache to keep for next time.
// A file whose size and modified time are unchanged is not read again.
function index(cache = null) {
  const known = cache?.version === CACHE_VERSION ? cache.files : {};
  const files = {};
  for (const { file, kind } of sessionFiles()) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const cached = known[file];
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      files[file] = cached;
      continue;
    }
    let session = null;
    try {
      session = kind === "claude" ? readClaude(file, stat.size) : readCodex(file, stat.size);
    } catch { /* unreadable now; tried again when it changes */ }
    files[file] = { mtimeMs: stat.mtimeMs, size: stat.size, session };
  }
  const fresh = { version: CACHE_VERSION, files };
  return { sessions: fromCache(fresh), cache: fresh };
}

// The sessions as last indexed, without touching a session file: what the
// popup shows while the index catches up.
function fromCache(cache) {
  if (cache?.version !== CACHE_VERSION) return [];
  const titles = codexTitles();
  return Object.entries(cache.files)
    .filter(([, entry]) => entry.session)
    .map(([file, entry]) => {
      const session = { ...entry.session, file, updated: entry.mtimeMs };
      if (session.kind === "codex") session.title = titles.get(session.id) ?? null;
      return session;
    })
    .sort((a, b) => b.updated - a.updated);
}

module.exports = { index, fromCache, readClaude, readCodex, codexTitles, typedByYou, EDGE_BYTES };
