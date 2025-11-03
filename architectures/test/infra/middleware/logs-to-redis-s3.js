"use strict";

const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");
const crypto = require("node:crypto");

function requestJson(method, targetUrl, body, extraHeaders = {}) {
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
      ...extraHeaders,
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

async function fetchEvents(eventLogConfig, sinceIso) {
  const baseUrl = normalizeBaseUrl(eventLogConfig.endpoint);
  const queueName = encodeURIComponent(eventLogConfig.queueName || "test");
  const target = `${baseUrl}/event-log/queues/${queueName}/events?since=${encodeURIComponent(sinceIso)}`;
  const response = await requestJson("GET", target);
  if (!response || !Array.isArray(response.events)) {
    return [];
  }
  return response.events;
}

async function updateRedis(redisConfig, payload) {
  const baseUrl = normalizeBaseUrl(redisConfig.endpoint);
  const key = encodeURIComponent(redisConfig.key || "test:lastProcessed");
  await requestJson("PUT", `${baseUrl}/kv/${key}`, { value: payload });
}

function buildMultipartBody(filename, content, boundary) {
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  return Buffer.concat([
    Buffer.from(header, "utf8"),
    Buffer.from(content, "utf8"),
    Buffer.from(footer, "utf8"),
  ]);
}

async function uploadToS3(s3Config, filename, content) {
  const baseUrl = normalizeBaseUrl(s3Config.endpoint);
  const prefix = s3Config.prefix ? `${s3Config.prefix.replace(/^\/+|\/+$/g, "")}` : "logs";
  const boundary = `----archim-${crypto.randomUUID()}`;
  const body = buildMultipartBody(filename, content, boundary);
  const targetPath = prefix ? `${baseUrl}/upload/${prefix}` : `${baseUrl}/upload`;

  await new Promise((resolve, reject) => {
    const urlObject = new URL(targetPath);
    const isHttps = urlObject.protocol === "https:";
    const options = {
      method: "POST",
      hostname: urlObject.hostname,
      port: urlObject.port || (isHttps ? 443 : 80),
      path: `${urlObject.pathname}${urlObject.search}`,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    };
    const requestFn = isHttps ? https.request : http.request;
    const req = requestFn(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(raw);
        } else {
          reject(new Error(`POST ${targetPath} failed with status ${res.statusCode}: ${raw}`));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function start(options = {}) {
  const eventLogConfig = {
    endpoint: (options.eventLog && options.eventLog.endpoint) || "http://localhost:4400",
    queueName: (options.eventLog && options.eventLog.queueName) || "test",
  };
  const redisConfig = {
    endpoint: (options.redis && options.redis.endpoint) || "http://localhost:4700",
    key: (options.redis && options.redis.key) || "test:lastProcessed",
  };
  const s3Config = {
    endpoint: (options.s3 && options.s3.endpoint) || "http://localhost:4800",
    prefix: (options.s3 && options.s3.prefix) || "logs",
  };
  const pollIntervalMs = options.pollIntervalMs || 7000;
  let since = options.startFrom || "1970-01-01T00:00:00.000Z";
  let totalProcessed = 0;
  let stopped = false;
  let timer = null;
  let running = false;

  const runCycle = async () => {
    if (running || stopped) {
      return;
    }
    running = true;
    try {
      const events = await fetchEvents(eventLogConfig, since);
      if (events.length > 0) {
        totalProcessed += events.length;
        const lastEvent = events[events.length - 1];
        since = lastEvent.recordedAt || since;
        const payload = {
          lastRecordedAt: since,
          totalProcessed,
          updatedAt: new Date().toISOString(),
        };
        await updateRedis(redisConfig, payload);
        const randomSnippet = crypto.randomBytes(6).toString("hex");
        const filename = `batch-${Date.now()}.txt`;
        const content = `Processed ${events.length} events\nLastRecordedAt=${since}\nToken=${randomSnippet}\n`;
        await uploadToS3(s3Config, filename, content);
        console.info(`[logs-to-redis-s3] Procesados ${events.length} eventos, total ${totalProcessed}`);
      }
    } catch (error) {
      console.error(`[logs-to-redis-s3] Error en ciclo: ${error.message}`);
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
    },
  });
}

module.exports = {
  start,
  metadata: {
    name: "logs-to-redis-s3",
    description: "Consume eventos del log, actualiza Redis y genera archivos en S3",
  },
};
