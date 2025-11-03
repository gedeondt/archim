"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const DEFAULT_MICROFRONT_PATH = path.join(__dirname, "../microfront/EmitButton.microfrontend");

let cachedMicrofront = null;

function loadMicrofrontScript(customPath) {
  const scriptPath = customPath || DEFAULT_MICROFRONT_PATH;
  if (!cachedMicrofront || loadMicrofrontScript.lastPath !== scriptPath) {
    cachedMicrofront = fs.readFileSync(scriptPath, "utf8");
    loadMicrofrontScript.lastPath = scriptPath;
  }
  return cachedMicrofront;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {
        reject(new Error("Payload too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON payload"));
      }
    });
    request.on("error", reject);
  });
}

function postToQueue(queueUrl, message) {
  const urlObject = new URL(queueUrl);
  const payload = JSON.stringify({ message });
  const options = {
    method: "POST",
    hostname: urlObject.hostname,
    port: urlObject.port || (urlObject.protocol === "https:" ? 443 : 80),
    path: `${urlObject.pathname}${urlObject.search}`,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
  };
  const requestFn = urlObject.protocol === "https:" ? https.request : http.request;

  return new Promise((resolve, reject) => {
    const req = requestFn(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(raw ? JSON.parse(raw) : null);
        } else {
          reject(new Error(`Queue responded with status ${res.statusCode}: ${raw}`));
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function enableCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function handleOptions(response) {
  enableCors(response);
  response.writeHead(204);
  response.end();
}

async function handleEmit(request, response, config) {
  try {
    const body = await readJsonBody(request);
    const now = new Date().toISOString();
    const message = {
      id: `test-${crypto.randomUUID()}`,
      source: typeof body.source === "string" && body.source.trim() ? body.source.trim() : "microfront",
      emittedAt: now,
      payload: body.payload !== undefined ? body.payload : { note: body.note || "Manual emit" },
    };
    const queueResult = await postToQueue(config.queueUrl, message);
    const responsePayload = {
      status: "queued",
      queueResult,
      message,
    };
    enableCors(response);
    response.writeHead(202, { "Content-Type": "application/json" });
    response.end(JSON.stringify(responsePayload));
  } catch (error) {
    enableCors(response);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: error.message }));
  }
}

function createServer(config) {
  return http.createServer((request, response) => {
    const { method = "GET", url = "/" } = request;

    if (method === "OPTIONS") {
      handleOptions(response);
      return;
    }

    if (url === "/health") {
      enableCors(response);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (url === "/microfront/emit-button.js") {
      try {
        const script = loadMicrofrontScript(config.microfrontPath);
        enableCors(response);
        response.writeHead(200, { "Content-Type": "application/javascript" });
        response.end(script);
      } catch (error) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    if (url === "/api/emit" && method === "POST") {
      handleEmit(request, response, config);
      return;
    }

    enableCors(response);
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Not Found" }));
  });
}

async function start(options = {}) {
  if (!options.queueUrl) {
    throw new Error("queueUrl option is required for the emitter BFF");
  }
  const port = options.port || 5700;
  const server = createServer({
    queueUrl: options.queueUrl,
    microfrontPath: options.microfrontPath,
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, () => {
      console.info(`[test:bff] Listening on port ${port}`);
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
    name: "test-emitter-bff",
    description: "BFF que expone /api/emit y sirve el microfront del emisor",
  },
};
