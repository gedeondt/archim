"use strict";

const fs = require("fs");
const path = require("path");

const { DASHBOARD_HTML, DASHBOARD_SCRIPT, MODULES_DIR } = require("./constants");

function loadFile(filePath) {
  return fs.promises.readFile(filePath, "utf8");
}

async function ensurePublicFiles() {
  try {
    await fs.promises.access(DASHBOARD_HTML);
    await fs.promises.access(DASHBOARD_SCRIPT);
  } catch (error) {
    throw new Error(
      "Dashboard public assets are missing. Expected index.html and dashboard.js to be present."
    );
  }
}

function resolveModuleReadme(moduleName) {
  return path.join(MODULES_DIR, moduleName, "README.md");
}

async function loadModuleReadme(moduleName) {
  const readmePath = resolveModuleReadme(moduleName);
  return loadFile(readmePath);
}

module.exports = {
  ensurePublicFiles,
  loadFile,
  loadModuleReadme,
};
