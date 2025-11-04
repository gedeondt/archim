"use strict";

const { loadModuleReadme } = require("./files");

function sanitizeModuleName(moduleName = "") {
  if (typeof moduleName !== "string") {
    return null;
  }
  const trimmed = moduleName.trim();
  if (!trimmed) {
    return null;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

module.exports = {
  loadModuleReadme,
  sanitizeModuleName,
};
