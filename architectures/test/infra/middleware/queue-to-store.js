"use strict";

const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

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
      ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
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
          reject(new Error(`${method} ${targetUrl} failed with status ${res.statusCode}: ${raw}`));
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

function normalizeBaseUrl(url) {
  return url.replace(/\/$/, "");
}

async function fetchPendingMessages(queueUrl) {
  const result = await requestJson("GET", `${queueUrl}/messages`);
  if (!result || !Array.isArray(result.messages)) {
    return [];
  }
  return result.messages;
}

async function sendEventLog(eventLogConfig, payload) {
  const baseUrl = normalizeBaseUrl(eventLogConfig.endpoint);
  const queueName = encodeURIComponent(eventLogConfig.queueName || "test-events");
  await requestJson("POST", `${baseUrl}/event-log/queues/${queueName}/events`, payload);
}

async function storeInDynamo(dynamoConfig, document) {
  const baseUrl = normalizeBaseUrl(dynamoConfig.endpoint);
  const collection = encodeURIComponent(dynamoConfig.collection || "test-messages");
  await requestJson("POST", `${baseUrl}/collections/${collection}/documents`, document);
}

function resolveSource(message) {
  if (message && typeof message === "object" && message.source) {
    return String(message.source);
  }
  return "unknown";
}

async function processMessages(messages, config) {
  for (const entry of messages) {
    const { message, receivedAt } = entry;
    const processedAt = new Date().toISOString();
    const source = resolveSource(message);
    const logPayload = {
      type: "queue-message",
      source,
      processedAt,
      receivedAt,
      message,
    };
    try {
      // eslint-disable-next-line no-await-in-loop
      await sendEventLog(config.eventLog, logPayload);
      // eslint-disable-next-line no-await-in-loop
      await storeInDynamo(config.dynamodb, {
        source,
        receivedAt,
        processedAt,
        emittedAt: message && message.emittedAt ? message.emittedAt : null,
        payload: message,
      });
      console.info(`[queue-to-store] Mensaje procesado para source='${source}'`);
    } catch (error) {
      console.error(`[queue-to-store] Error procesando mensaje: ${error.message}`);
    }
  }
}

function start(options = {}) {
  const queueBaseUrl = normalizeBaseUrl(options.queueUrl || "http://localhost:4200/queues/test");
  const pollIntervalMs = options.pollIntervalMs || 1000;
  const config = {
    eventLog: {
      endpoint: options.eventLog && options.eventLog.endpoint ? options.eventLog.endpoint : "http://localhost:4400",
      queueName: options.eventLog && options.eventLog.queueName ? options.eventLog.queueName : "test",
    },
    dynamodb: {
      endpoint: options.dynamodb && options.dynamodb.endpoint ? options.dynamodb.endpoint : "http://localhost:4600",
      collection: options.dynamodb && options.dynamodb.collection ? options.dynamodb.collection : "test-messages",
    },
  };

  let stopped = false;
  let timer = null;

  const scheduleNext = () => {
    if (stopped) {
      return;
    }
    timer = setTimeout(async () => {
      try {
        const messages = await fetchPendingMessages(queueBaseUrl);
        if (messages.length > 0) {
          await processMessages(messages, config);
        }
      } catch (error) {
        console.error(`[queue-to-store] Ciclo de sondeo falló: ${error.message}`);
      } finally {
        scheduleNext();
      }
    }, pollIntervalMs);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
  };

  scheduleNext();

  return Promise.resolve({
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
  });
}

module.exports = {
  start,
  metadata: {
    name: "queue-to-store",
    description: "Extrae mensajes de la cola 'test', los registra y almacena en DynamoDB",
  },
};
