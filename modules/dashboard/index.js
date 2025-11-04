"use strict";

const http = require("http");

const { ensurePublicFiles } = require("./lib/files");
const { createDashboardConfig } = require("./lib/config");
const { createRequestHandler } = require("./lib/routes");

async function start({ port = 4300, widgets, architectureDesign } = {}) {
  await ensurePublicFiles();

  const dashboardConfig = createDashboardConfig(widgets, architectureDesign);
  const requestHandler = createRequestHandler(dashboardConfig);

  return new Promise((resolve) => {
    const server = http.createServer(requestHandler);

    server.listen(port, () => {
      console.info(`[dashboard] Listening on port ${port}`);
      resolve({
        server,
        stop: () =>
          new Promise((stopResolve, stopReject) => {
            server.close((error) => {
              if (error) {
                stopReject(error);
              } else {
                stopResolve();
              }
            });
          }),
      });
    });
  });
}

module.exports = {
  start,
  metadata: {
    name: "Dashboard",
    description: "Web dashboard that aggregates the available microfrontends.",
  },
};
