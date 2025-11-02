#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function parsePieceToken(token) {
  const atIndex = token.lastIndexOf("@");
  if (atIndex === -1) {
    return { modulePath: token };
  }

  const modulePath = token.slice(0, atIndex);
  const remainder = token.slice(atIndex + 1);
  const parsedPort = Number.parseInt(remainder, 10);

  if (!Number.isNaN(parsedPort)) {
    return { modulePath, port: parsedPort };
  }

  return { modulePath: token };
}

function parseArgs(argv) {
  const args = { pieces: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--piece" || token === "-p") {
      const value = argv[++i];
      if (!value) {
        throw new Error("--piece flag requires a value");
      }
      args.pieces.push(parsePieceToken(value));
    } else if (token === "--help" || token === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`MicroSim Tester\n\n` +
    `Usage: node tester.js --piece ./modules/queue@4200 [--piece ./otherModule@4300]\n\n` +
    `Each module must provide ./test.js exporting an async run({ baseUrl, port })\n` +
    `function that returns { passed, failed, details }. The service must be running\n` +
    `before executing the tester.\n\n` +
    `When called without --piece flags, the tester will load all modules declared\n` +
    `in modules/manifest.json and infer base URLs from their configured ports.`);
}

function logResult(title, result) {
  console.info(`\n[test] ${title}`);
  console.info(`[test] Passed: ${result.passed}`);
  console.info(`[test] Failed: ${result.failed}`);
  if (result.details && result.details.length > 0) {
    for (const detail of result.details) {
      console.info(`[test] - ${detail}`);
    }
  }
}

async function runTestForPiece({ modulePath, port, baseUrl }) {
  const absoluteModulePath = path.resolve(process.cwd(), modulePath);
  const testFile = path.join(absoluteModulePath, "test.js");

  if (!fs.existsSync(testFile)) {
    throw new Error(`Expected test file at ${testFile}`);
  }

  // eslint-disable-next-line global-require, import/no-dynamic-require
  const testModule = require(testFile);
  const runner = typeof testModule === "function" ? testModule : testModule && testModule.run;

  if (typeof runner !== "function") {
    throw new Error(`Test file ${testFile} must export an async run() function`);
  }

  const context = {};
  if (typeof baseUrl === "string") {
    context.baseUrl = baseUrl;
  }
  if (typeof port === "number" && Number.isFinite(port)) {
    context.port = port;
    if (!context.baseUrl) {
      context.baseUrl = `http://localhost:${port}`;
    }
  }

  const result = await runner(context);

  return {
    passed: Number(result && result.passed) || 0,
    failed: Number(result && result.failed) || 0,
    details: Array.isArray(result && result.details) ? result.details : [],
  };
}

function loadPiecesFromManifest() {
  const manifestPath = path.resolve(process.cwd(), "modules/manifest.json");
  let manifestRaw;
  try {
    manifestRaw = fs.readFileSync(manifestPath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read manifest at ${manifestPath}: ${error.message}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (error) {
    throw new Error(`Manifest at ${manifestPath} contains invalid JSON: ${error.message}`);
  }

  if (!manifest.pieces || !Array.isArray(manifest.pieces)) {
    throw new Error(`Manifest at ${manifestPath} must define an array property "pieces"`);
  }

  const modules = manifest.pieces
    .map((piece) => {
      if (!piece || typeof piece.module !== "string") {
        return null;
      }
      const piecePort = piece.port;
      if (typeof piecePort !== "number" || Number.isNaN(piecePort)) {
        throw new Error(`Piece ${piece.module} in manifest must declare a numeric port`);
      }
      const baseUrl = piece.baseUrl || null;
      return {
        modulePath: piece.module,
        port: piecePort,
        baseUrl: typeof baseUrl === "string" ? baseUrl : undefined,
      };
    })
    .filter(Boolean);

  if (modules.length === 0) {
    throw new Error(`Manifest at ${manifestPath} does not define any modules.`);
  }

  return modules;
}

async function main() {
  let parsedArgs;
  try {
    parsedArgs = parseArgs(process.argv);
  } catch (error) {
    console.error(`[tester] ${error.message}`);
    printHelp();
    process.exit(1);
  }

  if (parsedArgs.help) {
    printHelp();
    process.exit(0);
  }

  let pieces = parsedArgs.pieces;

  if (pieces.length === 0) {
    try {
      pieces = loadPiecesFromManifest();
    } catch (error) {
      console.error(`[tester] ${error.message}`);
      process.exit(1);
    }
  }

  if (pieces.length === 0) {
    console.error("[tester] No modules specified to test.");
    printHelp();
    process.exit(1);
  }

  let totalPassed = 0;
  let totalFailed = 0;

  for (const piece of pieces) {
    const titleParts = [piece.modulePath];
    if (typeof piece.port === "number") {
      titleParts.push(`@${piece.port}`);
    }
    const title = titleParts.join("");
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await runTestForPiece(piece);
      totalPassed += result.passed;
      totalFailed += result.failed;
      logResult(title, result);
    } catch (error) {
      totalFailed += 1;
      console.error(`[tester] Error testing ${title}: ${error.stack || error.message}`);
    }
  }

  console.info(`\n[test] Summary -> Passed: ${totalPassed}, Failed: ${totalFailed}`);
  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`[tester] Unexpected error: ${error.stack || error.message}`);
  process.exit(1);
});
