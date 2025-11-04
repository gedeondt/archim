"use strict";

async function stopPieces(launchedPieces, { logSuccess = false } = {}) {
  for (const launched of [...launchedPieces].reverse()) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await launched.stop();
      if (logSuccess) {
        console.info(`[launcher] Piece ${launched.modulePath} stopped`);
      }
    } catch (error) {
      console.error(
        `[launcher] Error stopping piece ${launched.modulePath}: ${error.message}`
      );
    }
  }
}

function registerShutdown(launchedPieces) {
  const shutdown = async () => {
    console.info("[launcher] Shutting down...");
    await stopPieces(launchedPieces, { logSuccess: true });
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return shutdown;
}

module.exports = {
  registerShutdown,
  stopPieces,
};
