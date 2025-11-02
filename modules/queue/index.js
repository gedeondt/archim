"use strict";

const http = require("http");
const url = require("url");

const microfrontendScript = require("./microfrontend");

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
    queues.set(name, { pending: [], history: [] });
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
      const entry = {
        message: body.message,
        receivedAt: new Date().toISOString(),
      };
      queue.pending.push(entry);
      queue.history.push(entry);
      sendJson(response, 202, {
        status: "queued",
        queue: queueName,
        size: queue.pending.length,
        totalMessages: queue.history.length,
      });
    })
    .catch((error) => {
      sendJson(response, 400, { error: error.message });
    });
}

function handleGetMessages(response, queueName) {
  const queue = ensureQueue(queueName);
  const messages = queue.pending.splice(0, queue.pending.length);
  state.processedCount += messages.length;
  sendJson(response, 200, { queue: queueName, messages });
}

function handleListQueues(response) {
  const queuesPayload = Array.from(queues.entries()).map(([name, queue]) => ({
    name,
    pendingCount: queue.pending.length,
    totalMessages: queue.history.length,
    messages: queue.history.slice(),
  }));
  sendJson(response, 200, { queues: queuesPayload });
}

function handleMetrics(response) {
  sendJson(response, 200, { processedCount: state.processedCount });
}

function handleMicrofrontend(response) {
  const script = microfrontendScript;
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

  if (parsedUrl.pathname === "/queues" && method === "GET") {
    handleListQueues(response);
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
