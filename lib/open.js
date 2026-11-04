"use strict";

// How to open a URL in your browser. Under WSL the browser is Windows', so
// wslview, or failing that explorer.exe, rather than a Linux xdg-open.

const { onPath, executablesOnPath } = require("./shared/executables");

function opener(url, env = process.env, platform = process.platform) {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd.exe", "/c", "start", "", url];
  if (onPath("wslview") === null) executablesOnPath();
  if (env.WSL_DISTRO_NAME) return onPath("wslview") ? ["wslview", url] : ["explorer.exe", url];
  return ["xdg-open", url];
}

module.exports = { opener };
