"use strict";

function printHelp() {
  console.log(
    `MicroSim Launcher\n\n` +
      `Usage: node launcher.js [--config path] [--piece modulePath...] [--architecture name]\n\n` +
      `Options:\n` +
      `  --config, -c       Path to a JSON file that lists the pieces to boot.\n` +
      `                     { \"pieces\": [{ \"module\": \"./modules/queue\", \"port\": 4200 }] }\n` +
      `  --piece, -p        Direct path to a piece module. Can be passed multiple times.\n` +
      `  --architecture, -a Name of the architecture folder under ./architectures.\n` +
      `  --help, -h         Display this message.\n\n` +
      `If no pieces are provided the launcher will load ./modules/manifest.json\n` +
      `and start every infrastructure component listed there.\n` +
      `Passing --architecture example loads ./architectures/example/manifest.json\n` +
      `and executes its phases sequentially.\n\n` +
      `Each piece module must export a async start(options) function that returns\n` +
      `an object with at least a stop() method.`
  );
}

module.exports = {
  printHelp,
};
