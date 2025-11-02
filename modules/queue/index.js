"use strict";

const http = require("http");
const url = require("url");

const queues = new Map();
const state = {
  processedCount: 0,
};

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        request.connection.destroy();
        reject(new Error("Payload too large"));
      }
    });
    request.on("end", () => {
      try {
        const parsed = body.length > 0 ? JSON.parse(body) : {};
        resolve(parsed);
      } catch (error) {
        reject(new Error("Invalid JSON payload"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(JSON.stringify(payload));
}

function ensureQueue(name) {
  if (!queues.has(name)) {
    queues.set(name, []);
  }
  return queues.get(name);
}

function handlePostMessage(request, response, queueName) {
  readRequestBody(request)
    .then((body) => {
      if (!body || typeof body !== "object" || body.message === undefined) {
        sendJson(response, 400, { error: "Payload must contain a 'message' field" });
        return;
      }
      const queue = ensureQueue(queueName);
      queue.push({
        message: body.message,
        receivedAt: new Date().toISOString(),
      });
      sendJson(response, 202, { status: "queued", queue: queueName, size: queue.length });
    })
    .catch((error) => {
      sendJson(response, 400, { error: error.message });
    });
}

function handleGetMessages(response, queueName) {
  const queue = ensureQueue(queueName);
  const messages = queue.splice(0, queue.length);
  state.processedCount += messages.length;
  sendJson(response, 200, { queue: queueName, messages });
}

function handleMetrics(response) {
  sendJson(response, 200, { processedCount: state.processedCount });
}

function handleMicrofrontend(response) {
  const script = `class QueueMonitor extends HTMLElement {\n  constructor() {\n    super();\n    this.attachShadow({ mode: 'open' });\n    this.shadowRoot.innerHTML = ` +
    "`<style>\n  :host {\n    display: block;\n    font-family: system-ui, sans-serif;\n    border: 1px solid #ccc;\n    border-radius: 8px;\n    padding: 1rem;\n    background: #fff;\n  }\n  h2 {\n    margin-top: 0;\n    font-size: 1.1rem;\n  }\n  .count {\n    font-size: 2.5rem;\n    font-weight: bold;\n  }\n  button {\n    margin-top: 1rem;\n    padding: 0.5rem 1rem;\n    border: none;\n    border-radius: 4px;\n    background: #0059b2;\n    color: white;\n    cursor: pointer;\n  }\n</style>\n<h2>Queue Monitor</h2>\n<div class=\"count\" id=\"count\">0</div>\n<button id=\"refresh\">Actualizar</button>`" +
    `;\n    this._onRefresh = this._onRefresh.bind(this);\n  }\n\n  connectedCallback() {\n    this.shadowRoot.getElementById('refresh').addEventListener('click', this._onRefresh);\n    this._fetchMetrics();\n    this._interval = setInterval(() => this._fetchMetrics(), 5000);\n  }\n\n  disconnectedCallback() {\n    this.shadowRoot.getElementById('refresh').removeEventListener('click', this._onRefresh);\n    if (this._interval) {\n      clearInterval(this._interval);\n    }\n  }\n\n  _onRefresh() {\n    this._fetchMetrics();\n  }\n\n  async _fetchMetrics() {\n    const endpoint = this.getAttribute('metrics-url') || '/metrics';\n    try {\n      const response = await fetch(endpoint);\n      if (!response.ok) {\n        throw new Error('Metrics request failed');\n      }\n      const data = await response.json();\n      this.shadowRoot.getElementById('count').textContent = data.processedCount ?? '0';\n    } catch (error) {\n      this.shadowRoot.getElementById('count').textContent = 'Error';\n      console.error('[queue-monitor]', error);\n    }\n  }\n}\n\ncustomElements.define('queue-monitor', QueueMonitor);`;

  response.writeHead(200, {
    "Content-Type": "application/javascript",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(script);
}

function requestListener(request, response) {
  const parsedUrl = url.parse(request.url, true);
  const method = request.method || "GET";

  if (method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    response.end();
    return;
  }

  if (parsedUrl.pathname === "/metrics") {
    handleMetrics(response);
    return;
  }

  if (parsedUrl.pathname === "/microfrontends/queue-monitor.js") {
    handleMicrofrontend(response);
    return;
  }

  const queueMatch = parsedUrl.pathname && parsedUrl.pathname.match(/^\/queues\/([^/]+)\/messages$/);
  if (queueMatch) {
    const queueName = decodeURIComponent(queueMatch[1]);
    if (method === "POST") {
      handlePostMessage(request, response, queueName);
      return;
    }
    if (method === "GET") {
      handleGetMessages(response, queueName);
      return;
    }
  }

  sendJson(response, 404, { error: "Not Found" });
}

function start({ port = 4200 } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer(requestListener);
    server.listen(port, () => {
      console.info(`[queueSimulator] Listening on port ${port}`);
      resolve({
        server,
        stop: () => new Promise((stopResolve, stopReject) => {
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

const microfrontend = {
  tagName: "queue-monitor",
  url: "http://localhost:4200/microfrontends/queue-monitor.js",
};

module.exports = {
  start,
  microfrontend,
  metadata: {
    name: "Queue Simulator",
    description: "In-memory queue with read/write endpoints and a monitoring microfrontend.",
  },
};
