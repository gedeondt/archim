#!/usr/bin/env node
"use strict";

const {
  DEFAULT_MANIFEST_PATH,
} = require("./lib/launcher/constants");
const { parseArgs } = require("./lib/launcher/args");
const { printHelp } = require("./lib/launcher/help");
const {
  loadPiecesFromConfig,
  normalizePiecesFromArgs,
  launchPiece,
} = require("./lib/launcher/pieces");
const {
  loadArchitectureDefinition,
  launchArchitecture,
} = require("./lib/launcher/architecture");
const { registerShutdown, stopPieces } = require("./lib/launcher/lifecycle");

async function resolveArchitectureDefinition(architectureName) {
  if (!architectureName) {
    return null;
  }

  try {
    return await loadArchitectureDefinition(architectureName);
  } catch (error) {
    console.error(`[launcher] ${error.message}`);
    process.exit(1);
  }
}

async function resolvePieces(parsedArgs, architectureDefinition) {
  let pieces = [];

  if (parsedArgs.config) {
    pieces = pieces.concat(await loadPiecesFromConfig(parsedArgs.config));
  }

  if (parsedArgs.pieces.length > 0) {
    pieces = pieces.concat(normalizePiecesFromArgs(parsedArgs.pieces));
  }

  if (!architectureDefinition && pieces.length === 0) {
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

  if (!architectureDefinition && pieces.length === 0) {
    console.error(
      "[launcher] No pieces specified. Use --config, --piece or keep ./modules/manifest.json available."
    );
    process.exit(1);
  }

  return pieces;
}

async function launchPieces(pieces, launchedPieces) {
  for (const piece of pieces) {
    // eslint-disable-next-line no-await-in-loop
    const instanceMetadata = await launchPiece(piece);
    launchedPieces.push(instanceMetadata);
  }
}

function logLaunchSummary(launchedPieces) {
  if (launchedPieces.length === 0) {
    console.info("[launcher] No pieces were launched");
    return;
  }

  const summary = launchedPieces
    .map((piece) => (piece.port ? `${piece.modulePath}@${piece.port}` : piece.modulePath))
    .join(", ");
  console.info(`[launcher] All pieces launched: ${summary}`);
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

  const architectureDefinition = await resolveArchitectureDefinition(parsedArgs.architecture);
  const pieces = await resolvePieces(parsedArgs, architectureDefinition);

  const launchedPieces = [];

  try {
    if (architectureDefinition) {
      await launchArchitecture(architectureDefinition, launchedPieces);
    }

    await launchPieces(pieces, launchedPieces);
    logLaunchSummary(launchedPieces);
  } catch (error) {
    console.error(`[launcher] Failed to launch piece: ${error.message}`);
    await stopPieces(launchedPieces);
    process.exit(1);
  }

  registerShutdown(launchedPieces);
}

main().catch((error) => {
  console.error(`[launcher] Unexpected error: ${error.stack || error.message}`);
  process.exit(1);
});
