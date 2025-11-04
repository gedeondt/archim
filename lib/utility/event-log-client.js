"use strict";

const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

function normalizeBaseUrl(url) {
  if (!url) {
    return "http://localhost:4400";
  }
  return url.replace(/\/$/, "");
}

function requestJson(method, targetUrl, body) {
  const urlObject = new URL(targetUrl);
  const isHttps = urlObject.protocol === "https:";
  const payload = body !== undefined ? JSON.stringify(body) : null;
  const options = {
    method,
    hostname: urlObject.hostname,
    port: urlObject.port || (isHttps ? 443 : 80),
    path: `${urlObject.pathname}${urlObject.search}`,
    headers: {
      ...(payload
        ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
        : {}),
    },
  };
  const requestFn = isHttps ? https.request : http.request;

  return new Promise((resolve, reject) => {
    const req = requestFn(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        if (!ok) {
          reject(new Error(`${method} ${targetUrl} respondió ${res.statusCode}: ${raw}`));
          return;
        }
        if (!raw) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          resolve(raw);
        }
      });
    });
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function buildQueueEventsUrl(baseUrl, queueName, since) {
  if (!queueName) {
    throw new Error("Se requiere el nombre de la cola de event log");
  }
  const safeQueue = encodeURIComponent(queueName);
  const url = new URL(`/event-log/queues/${safeQueue}/events`, baseUrl);
  if (since) {
    url.searchParams.set("since", since);
  }
  return url.toString();
}

async function fetchQueueEvents(baseUrl, queueName, since) {
  const target = buildQueueEventsUrl(baseUrl, queueName, since);
  const response = await requestJson("GET", target);
  if (!response || !Array.isArray(response.events)) {
    return [];
  }
  return response.events;
}

async function publishQueueEvent(baseUrl, queueName, payload) {
  if (!queueName) {
    throw new Error("Se requiere el nombre de la cola de event log");
  }
  const safeQueue = encodeURIComponent(queueName);
  const url = new URL(`/event-log/queues/${safeQueue}/events`, baseUrl);
  await requestJson("POST", url.toString(), payload);
}

function createEventLogClient(config = {}) {
  const baseUrl = normalizeBaseUrl(config.endpoint || "http://localhost:4400");
  const defaultQueue = config.queueName || null;

  return {
    baseUrl,
    defaultQueue,
    async fetchEvents(since) {
      if (!defaultQueue) {
        throw new Error("No se configuró cola por defecto para fetchEvents");
      }
      return fetchQueueEvents(baseUrl, defaultQueue, since);
    },
    async fetchQueueEvents(queueName, since) {
      return fetchQueueEvents(baseUrl, queueName, since);
    },
    async publishEvent(queueName, payload) {
      return publishQueueEvent(baseUrl, queueName, payload);
    },
  };
}

module.exports = {
  normalizeBaseUrl,
  requestJson,
  fetchQueueEvents,
  publishQueueEvent,
  createEventLogClient,
};
