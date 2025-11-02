#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_PORT_BASE = 4100;
const DEFAULT_MANIFEST_PATH = path.join(__dirname, "modules", "manifest.json");

function parseArgs(argv) {
  const args = { pieces: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--piece" || token === "-p") {
      const value = argv[++i];
      if (!value) {
        throw new Error("--piece flag requires a value");
      }
      args.pieces.push(value);
    } else if (token === "--config" || token === "-c") {
      const value = argv[++i];
      if (!value) {
        throw new Error("--config flag requires a value");
      }
      args.config = value;
    } else if (token === "--help" || token === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`MicroSim Launcher\n\n` +
    `Usage: node launcher.js [--config path] [--piece modulePath...]\n\n` +
    `Options:\n` +
    `  --config, -c  Path to a JSON file that lists the pieces to boot.\n` +
    `                { \\"pieces\\": [{ \\"module\\": \\"./modules/queue\\", \\"port\\": 4200 }] }\n` +
    `  --piece, -p   Direct path to a piece module. Can be passed multiple times.\n` +
    `  --help, -h    Display this message.\n\n` +
    `If no pieces are provided the launcher will load ./modules/manifest.json\n` +
    `and start every infrastructure component listed there.\n\n` +
    `Each piece module must export a async start(options) function that returns\n` +
    `an object with at least a stop() method.`);
}

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
  const absolutePath = path.resolve(process.cwd(), modulePath);
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const pieceModule = require(absolutePath);
  if (typeof pieceModule.start !== "function") {
    throw new Error(`Piece at ${modulePath} must export a start(options) function`);
  }
  const launchOptions = { port, ...options };
  console.info(`[launcher] Booting piece ${modulePath} on port ${launchOptions.port}`);
  const instance = await pieceModule.start(launchOptions);
  const metadata = {
    modulePath,
    port: launchOptions.port,
    stop: instance && typeof instance.stop === "function" ? instance.stop : () => {
      if (instance && instance.server && typeof instance.server.close === "function") {
        instance.server.close();
      }
    },
    metadata: pieceModule.metadata || null,
  };
  return metadata;
}

async function main() {
  let parsedArgs;
  try {
    parsedArgs = parseArgs(process.argv);
  } catch (error) {
    console.error(`[launcher] ${error.message}`);
    printHelp();
    process.exit(1);
  }

  if (parsedArgs.help) {
    printHelp();
    process.exit(0);
  }

  let pieces = [];
  if (parsedArgs.config) {
    pieces = pieces.concat(await loadPiecesFromConfig(parsedArgs.config));
  }
  if (parsedArgs.pieces.length > 0) {
    pieces = pieces.concat(normalizePiecesFromArgs(parsedArgs.pieces));
  }

  if (pieces.length === 0) {
    try {
      const defaultPieces = await loadPiecesFromConfig(DEFAULT_MANIFEST_PATH);
      if (defaultPieces.length > 0) {
        pieces = defaultPieces;
        console.info(`[launcher] Loaded default manifest from ${DEFAULT_MANIFEST_PATH}`);
      }
    } catch (error) {
      console.error(`[launcher] Failed to load default manifest: ${error.message}`);
    }
  }

  if (pieces.length === 0) {
    console.error("[launcher] No pieces specified. Use --config, --piece or keep ./modules/manifest.json available.");
    process.exit(1);
  }

  const launchedPieces = [];
  try {
    for (const piece of pieces) {
      // eslint-disable-next-line no-await-in-loop
      const instanceMetadata = await launchPiece(piece);
      launchedPieces.push(instanceMetadata);
    }
    console.info(`[launcher] All pieces launched: ${launchedPieces.map((p) => `${p.modulePath}@${p.port}`).join(", ")}`);
  } catch (error) {
    console.error(`[launcher] Failed to launch piece: ${error.message}`);
    for (const launched of launchedPieces.reverse()) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await launched.stop();
      } catch (stopError) {
        console.error(`[launcher] Error stopping piece ${launched.modulePath}: ${stopError.message}`);
      }
    }
    process.exit(1);
  }

  const shutdown = async () => {
    console.info("[launcher] Shutting down...");
    for (const launched of launchedPieces.reverse()) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await launched.stop();
        console.info(`[launcher] Piece ${launched.modulePath} stopped`);
      } catch (error) {
        console.error(`[launcher] Error stopping piece ${launched.modulePath}: ${error.message}`);
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(`[launcher] Unexpected error: ${error.stack || error.message}`);
  process.exit(1);
});
