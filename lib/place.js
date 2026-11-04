"use strict";

// What Herdr already has open, from one snapshot: the workspace working in a
// folder, and the pane a session is running in.

const { inside } = require("./folders");

// The workspace with the most panes in the folder; one named after the folder
// wins a tie.
function workspaceFor(snapshot, folder) {
  const counts = new Map();
  for (const pane of snapshot?.panes ?? []) {
    const cwd = pane.foreground_cwd ?? pane.cwd;
    if (cwd && pane.workspace_id && inside(cwd, folder)) counts.set(pane.workspace_id, (counts.get(pane.workspace_id) ?? 0) + 1);
  }
  if (!counts.size) return null;
  const name = folder.split("/").pop();
  const labels = new Map((snapshot.workspaces ?? []).map((w) => [w.workspace_id, w.label]));
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (labels.get(b[0]) === name) - (labels.get(a[0]) === name))[0][0];
}

function paneRunning(snapshot, sessionId) {
  return (snapshot?.agents ?? []).find((agent) => agent.agent_session?.value === sessionId)?.pane_id ?? null;
}

module.exports = { workspaceFor, paneRunning };
