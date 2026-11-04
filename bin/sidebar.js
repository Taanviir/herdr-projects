#!/usr/bin/env node
"use strict";

// Puts each checkout's last CI result on the workspaces with a pane in it.
// Herdr runs it at startup and as workspaces and panes come and go; a CI
// watch runs it on every change.

const path = require("node:path");
const { STATE_DIR } = require("../lib/shared/term");

require("../lib/ci").report(path.join(STATE_DIR, "ci.json"));
