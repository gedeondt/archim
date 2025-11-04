"use strict";

const { DASHBOARD_HTML, DASHBOARD_SCRIPT } = require("./constants");
const { loadFile } = require("./files");
const { loadModuleReadme, sanitizeModuleName } = require("./modules");
const { sendJson, sendPlainText, sendText } = require("./http");

function createRequestHandler(dashboardConfig) {
  return async function handleRequest(request, response) {
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
          sendPlainText(response, 400, "Invalid module name");
          return;
        }

        try {
          const readmeContents = await loadModuleReadme(requestedModule);
          sendText(response, 200, readmeContents, "text/markdown; charset=utf-8");
        } catch (error) {
          if (error && error.code === "ENOENT") {
            sendPlainText(response, 404, "README not found");
          } else {
            throw error;
          }
        }
        return;
      }

      sendPlainText(response, 404, "Not Found");
    } catch (error) {
      sendPlainText(response, 500, `Dashboard server error: ${error.message}`);
    }
  };
}

module.exports = {
  createRequestHandler,
};
