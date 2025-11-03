"use strict";

const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");
const mysql = require("mysql2/promise");

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

async function fetchAllDocuments(endpoint, collection, pageSize) {
  const baseUrl = normalizeBaseUrl(endpoint);
  const documents = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    // eslint-disable-next-line no-await-in-loop
    const response = await requestJson(
      "GET",
      `${baseUrl}/collections/${encodeURIComponent(collection)}/documents?page=${page}&pageSize=${pageSize}`
    );
    if (!response || !Array.isArray(response.documents)) {
      break;
    }
    documents.push(...response.documents);
    totalPages = response.totalPages || 0;
    if (totalPages === 0) {
      break;
    }
    page += 1;
  }
  return documents;
}

function aggregateMetrics(documents) {
  const metrics = new Map();
  for (const document of documents) {
    const source = document.source || "unknown";
    const entry = metrics.get(source) || { totalCount: 0, lastReceivedAt: null };
    entry.totalCount += 1;
    if (document.receivedAt) {
      const timestamp = new Date(document.receivedAt).getTime();
      const current = entry.lastReceivedAt ? new Date(entry.lastReceivedAt).getTime() : 0;
      if (Number.isFinite(timestamp) && timestamp >= current) {
        entry.lastReceivedAt = new Date(timestamp).toISOString();
      }
    }
    metrics.set(source, entry);
  }
  return metrics;
}

async function persistMetrics(pool, metrics) {
  const connection = await pool.getConnection();
  try {
    await connection.query("USE test_metrics;");
    for (const [source, entry] of metrics.entries()) {
      const lastReceivedAt = entry.lastReceivedAt || new Date().toISOString();
      // eslint-disable-next-line no-await-in-loop
      await connection.query(
        "INSERT INTO message_metrics (source, total_count, last_received_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)\n         ON CONFLICT(source) DO UPDATE SET total_count = excluded.total_count, last_received_at = excluded.last_received_at, updated_at = CURRENT_TIMESTAMP",
        [source, entry.totalCount, lastReceivedAt]
      );
    }
  } finally {
    connection.release();
  }
}

function start(options = {}) {
  const dynamodbEndpoint = (options.dynamodb && options.dynamodb.endpoint) || "http://localhost:4600";
  const collection = (options.dynamodb && options.dynamodb.collection) || "test-messages";
  const pageSize = options.dynamodb && options.dynamodb.pageSize ? options.dynamodb.pageSize : 50;
  const pollIntervalMs = options.pollIntervalMs || 5000;

  const poolPromise = mysql.createPool({
    host: (options.mysql && options.mysql.host) || "localhost",
    port: (options.mysql && options.mysql.port) || 3307,
    user: (options.mysql && options.mysql.user) || "root",
    password: (options.mysql && options.mysql.password) || "",
    waitForConnections: true,
    connectionLimit: 2,
    namedPlaceholders: false,
  });

  let stopped = false;
  let running = false;
  let timer = null;

  const runCycle = async () => {
    if (running || stopped) {
      return;
    }
    running = true;
    try {
      const documents = await fetchAllDocuments(dynamodbEndpoint, collection, pageSize);
      const metrics = aggregateMetrics(documents);
      if (metrics.size > 0) {
        await persistMetrics(poolPromise, metrics);
        console.info(`[dynamodb-to-mysql] Métricas actualizadas (${metrics.size} sources)`);
      }
    } catch (error) {
      console.error(`[dynamodb-to-mysql] Error actualizando métricas: ${error.message}`);
    } finally {
      running = false;
      if (!stopped) {
        scheduleNext();
      }
    }
  };

  function scheduleNext() {
    if (stopped) {
      return;
    }
    timer = setTimeout(runCycle, pollIntervalMs);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
  }

  scheduleNext();

  return Promise.resolve({
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
      await poolPromise.end();
    },
  });
}

module.exports = {
  start,
  metadata: {
    name: "dynamodb-to-mysql",
    description: "Agrega documentos de DynamoDB y los refleja en message_metrics",
  },
};
