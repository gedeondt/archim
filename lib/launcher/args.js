"use strict";

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
      continue;
    }

    if (token === "--config" || token === "-c") {
      const value = argv[++i];
      if (!value) {
        throw new Error("--config flag requires a value");
      }
      args.config = value;
      continue;
    }

    if (token === "--architecture" || token === "-a") {
      const value = argv[++i];
      if (!value) {
        throw new Error("--architecture flag requires a value");
      }
      args.architecture = value;
      continue;
    }

    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

module.exports = {
  parseArgs,
};
