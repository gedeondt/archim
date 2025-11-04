"use strict";

const fs = require("fs");
const path = require("path");

const { DEFAULT_PORT_BASE } = require("./constants");

async function loadPiecesFromConfig(configPath) {
  const absolutePath = path.resolve(process.cwd(), configPath);
  const configRaw = await fs.promises.readFile(absolutePath, "utf8");
  const config = JSON.parse(configRaw);

  if (!Array.isArray(config.pieces)) {
    throw new Error("Configuration file must contain a 'pieces' array");
  }

  return config.pieces.map((piece, index) => ({
    modulePath: piece.module,
    port: piece.port || DEFAULT_PORT_BASE + index,
    options: piece.options || {},
  }));
}

function normalizePiecesFromArgs(pieces) {
  return pieces.map((modulePath, index) => ({
    modulePath,
    port: DEFAULT_PORT_BASE + index,
    options: {},
  }));
}

async function launchPiece({ modulePath, port, options }) {
  const absolutePath = path.isAbsolute(modulePath)
    ? modulePath
    : path.resolve(process.cwd(), modulePath);
  const displayPath = path.relative(process.cwd(), absolutePath) || modulePath;

  // eslint-disable-next-line global-require, import/no-dynamic-require
  const pieceModule = require(absolutePath);
  if (typeof pieceModule.start !== "function") {
    throw new Error(`Piece at ${modulePath} must export a start(options) function`);
  }

  const launchOptions = { ...options };
  if (port !== undefined) {
    launchOptions.port = port;
  }

  const portInfo = port !== undefined ? ` on port ${launchOptions.port}` : "";
  console.info(`[launcher] Booting piece ${displayPath}${portInfo}`);
  const instance = await pieceModule.start(launchOptions);

  const metadata = {
    modulePath: displayPath,
    absolutePath,
    port: launchOptions.port !== undefined ? launchOptions.port : null,
    stop:
      instance && typeof instance.stop === "function"
        ? instance.stop
        : () => {
            if (instance && instance.server && typeof instance.server.close === "function") {
              instance.server.close();
            }
          },
    metadata: pieceModule.metadata || null,
  };

  return metadata;
}

module.exports = {
  launchPiece,
  loadPiecesFromConfig,
  normalizePiecesFromArgs,
};
