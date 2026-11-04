"use strict";

// Runs the index off the popup's thread, so a cold start never holds up keys.

const { parentPort, workerData } = require("node:worker_threads");
const { index } = require("./sessions");

parentPort.postMessage(index(workerData));
