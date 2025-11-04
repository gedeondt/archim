"use strict";

const path = require("path");

const ROOT_DIR = path.join(__dirname, "..", "..");

const DEFAULT_PORT_BASE = 4100;
const DEFAULT_MANIFEST_PATH = path.join(ROOT_DIR, "modules", "manifest.json");
const DEFAULT_ARCHITECTURES_DIR = path.join(ROOT_DIR, "architectures");

module.exports = {
  DEFAULT_PORT_BASE,
  DEFAULT_MANIFEST_PATH,
  DEFAULT_ARCHITECTURES_DIR,
  ROOT_DIR,
};
