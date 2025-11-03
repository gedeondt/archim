"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");

const PUBLIC_DIR = path.join(__dirname, "public");
const DASHBOARD_HTML = path.join(PUBLIC_DIR, "index.html");
const DASHBOARD_SCRIPT = path.join(PUBLIC_DIR, "dashboard.js");

const DEFAULT_WIDGETS = [
  {
    id: "queue-monitor",
    title: "Queue Monitor",
    url: "http://localhost:4200/microfrontends/queue-monitor.js",
    tagName: "queue-monitor",
    props: {
      "metrics-url": "http://localhost:4200/metrics",
      "queues-url": "http://localhost:4200/queues",
    },
  },
  {
    id: "event-log-monitor",
    title: "Event Log",
    url: "http://localhost:4400/microfrontends/event-log-monitor.js",
    tagName: "event-log-monitor",
    props: {
      "metrics-url": "http://localhost:4400/metrics",
    },
  },
];

function loadFile(filePath) {
  return fs.promises.readFile(filePath, "utf8");
}

async function ensurePublicFiles() {
  try {
    await fs.promises.access(DASHBOARD_HTML);
    await fs.promises.access(DASHBOARD_SCRIPT);
  } catch (error) {
    throw new Error("Dashboard public assets are missing. Expected index.html and dashboard.js to be present.");
  }
}

function createDashboardConfig(widgetsOption) {
  if (Array.isArray(widgetsOption) && widgetsOption.length > 0) {
    return { widgets: widgetsOption };
  }
  return { widgets: DEFAULT_WIDGETS };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
  });
  response.end(body);
}

function start({ port = 4300, widgets } = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      await ensurePublicFiles();
    } catch (error) {
      reject(error);
      return;
    }

    const dashboardConfig = createDashboardConfig(widgets);
    const server = http.createServer(async (request, response) => {
      const { url: requestUrl = "/" } = request;
      try {
        if (requestUrl === "/" || requestUrl === "/index.html") {
          const html = await loadFile(DASHBOARD_HTML);
          sendText(response, 200, html, "text/html; charset=utf-8");
          return;
        }

        if (requestUrl === "/dashboard.js") {
          const script = await loadFile(DASHBOARD_SCRIPT);
          sendText(response, 200, script, "application/javascript; charset=utf-8");
          return;
        }

        if (requestUrl === "/dashboard-config.json") {
          sendJson(response, 200, dashboardConfig);
          return;
        }

        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not Found");
      } catch (error) {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(`Dashboard server error: ${error.message}`);
      }
    });

    server.listen(port, () => {
      console.info(`[dashboard] Listening on port ${port}`);
      resolve({
        server,
        stop: () => new Promise((stopResolve, stopReject) => {
          server.close((closeError) => {
            if (closeError) {
              stopReject(closeError);
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
