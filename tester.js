#!/usr/bin/env node
"use strict";

const path = require("path");

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
    `Usage: node tester.js --piece ./queueSimulator.js [--piece ./otherPiece.js]\n\n` +
    `Each piece module can optionally export an async runTests() function\n` +
    `that returns an object: { passed: number, failed: number, details: [] }.\n` +
    `If runTests is not present, a smoke-test will instantiate the micro frontend\n` +
    `definition if available.`);
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

async function smokeTestMicrofrontend(module) {
  if (!module || !module.microfrontend) {
    return {
      passed: 0,
      failed: 1,
      details: ["No microfrontend metadata exported"],
    };
  }
  const { tagName, url } = module.microfrontend;
  if (!tagName || !url) {
    return {
      passed: 0,
      failed: 1,
      details: ["Microfrontend metadata must include tagName and url"],
    };
  }
  return {
    passed: 1,
    failed: 0,
    details: [`Microfrontend ${tagName} exposed at ${url}`],
  };
}

async function runTestForPiece(modulePath) {
  const absolutePath = path.resolve(process.cwd(), modulePath);
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const pieceModule = require(absolutePath);
  if (pieceModule && typeof pieceModule.runTests === "function") {
    const result = await pieceModule.runTests();
    return {
      passed: result.passed || 0,
      failed: result.failed || 0,
      details: result.details || [],
    };
  }
  return smokeTestMicrofrontend(pieceModule);
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

  if (parsedArgs.help || parsedArgs.pieces.length === 0) {
    printHelp();
    if (parsedArgs.help) {
      process.exit(0);
    }
    process.exit(1);
  }

  let totalPassed = 0;
  let totalFailed = 0;

  for (const modulePath of parsedArgs.pieces) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await runTestForPiece(modulePath);
      totalPassed += result.passed;
      totalFailed += result.failed;
      logResult(modulePath, result);
    } catch (error) {
      totalFailed += 1;
      console.error(`[tester] Error testing ${modulePath}: ${error.stack || error.message}`);
    }
  }

  console.info(`\n[test] Summary -> Passed: ${totalPassed}, Failed: ${totalFailed}`);
  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`[tester] Unexpected error: ${error.stack || error.message}`);
  process.exit(1);
});
