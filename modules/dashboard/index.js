"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");

const PUBLIC_DIR = path.join(__dirname, "public");
const DASHBOARD_HTML = path.join(PUBLIC_DIR, "index.html");
const DASHBOARD_SCRIPT = path.join(PUBLIC_DIR, "dashboard.js");
const MODULES_DIR = path.join(__dirname, "..");

const DEFAULT_MODULE_WIDGETS = [
  {
    id: "queue-monitor",
    title: "Queue Monitor",
    url: "http://localhost:4200/microfrontends/queue-monitor.js",
    tagName: "queue-monitor",
    props: {
      "metrics-url": "http://localhost:4200/metrics",
      "queues-url": "http://localhost:4200/queues",
    },
    readmeModule: "queue",
  },
  {
    id: "event-log-monitor",
    title: "Event Log",
    url: "http://localhost:4400/microfrontends/event-log-monitor.js",
    tagName: "event-log-monitor",
    props: {
      "metrics-url": "http://localhost:4400/metrics",
    },
    readmeModule: "event-log",
  },
  {
    id: "mysql-simulator",
    title: "MySQL Simulator",
    url: "http://localhost:4500/microfrontends/mysql-simulator.js",
    tagName: "mysql-simulator-dashboard",
    props: {
      "metrics-url": "http://localhost:4500/metrics",
    },
    readmeModule: "mysql-simulator",
  },
  {
    id: "dynamodb-simulator",
    title: "DynamoDB Simulator",
    url: "http://localhost:4600/microfrontends/dynamodb-simulator.js",
    tagName: "dynamodb-simulator-dashboard",
    props: {
      "metrics-url": "http://localhost:4600/metrics",
    },
    readmeModule: "dynamodb-simulator",
  },
  {
    id: "redis-simulator",
    title: "Redis Simulator",
    url: "http://localhost:4700/microfrontends/redis-simulator.js",
    tagName: "redis-simulator-dashboard",
    props: {
      "metrics-url": "http://localhost:4700/metrics",
    },
    readmeModule: "redis-simulator",
  },
  {
    id: "s3-simulator",
    title: "S3 Simulator",
    url: "http://localhost:4800/widget",
    tagName: "s3-simulator-widget",
    props: {
      "metrics-url": "http://localhost:4800/metrics",
    },
    readmeModule: "s3-simulator",
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

function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function createDashboardConfig(widgetsOption) {
  let moduleWidgets = DEFAULT_MODULE_WIDGETS;
  let architectureWidgets = [];

  if (Array.isArray(widgetsOption)) {
    architectureWidgets = widgetsOption;
  } else if (widgetsOption && typeof widgetsOption === "object") {
    if (isNonEmptyArray(widgetsOption.modules)) {
      moduleWidgets = widgetsOption.modules;
    }
    if (Array.isArray(widgetsOption.architecture)) {
      architectureWidgets = widgetsOption.architecture;
    } else if (isNonEmptyArray(widgetsOption.widgets)) {
      // Support legacy "widgets" option by treating it as architecture widgets.
      architectureWidgets = widgetsOption.widgets;
    }
  }

  return {
    widgets: moduleWidgets,
    moduleWidgets,
    architectureWidgets,
  };
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

function sanitizeModuleName(moduleName = "") {
  if (typeof moduleName !== "string") {
    return null;
  }
  const trimmed = moduleName.trim();
  if (!trimmed) {
    return null;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
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
      const parsedUrl = new URL(requestUrl, "http://localhost");
      const { pathname } = parsedUrl;
      try {
        if (pathname === "/" || pathname === "/index.html") {
          const html = await loadFile(DASHBOARD_HTML);
          sendText(response, 200, html, "text/html; charset=utf-8");
          return;
        }

        if (pathname === "/dashboard.js") {
          const script = await loadFile(DASHBOARD_SCRIPT);
          sendText(response, 200, script, "application/javascript; charset=utf-8");
          return;
        }

        if (pathname === "/dashboard-config.json") {
          sendJson(response, 200, dashboardConfig);
          return;
        }

        if (pathname.startsWith("/readme/")) {
          const requestedModule = sanitizeModuleName(
            decodeURIComponent(pathname.replace("/readme/", ""))
          );
          if (!requestedModule) {
            sendText(
              response,
              400,
              "Invalid module name",
              "text/plain; charset=utf-8"
            );
            return;
          }

          const readmePath = path.join(MODULES_DIR, requestedModule, "README.md");
          try {
            const readmeContents = await loadFile(readmePath);
            sendText(
              response,
              200,
              readmeContents,
              "text/markdown; charset=utf-8"
            );
          } catch (error) {
            if (error && error.code === "ENOENT") {
              sendText(
                response,
                404,
                "README not found",
                "text/plain; charset=utf-8"
              );
            } else {
              throw error;
            }
          }
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
