"use strict";

// Event Log Simulator
// --------------------
// HTTP API:
//   POST   /event-log/queues/:name/events
//          - Body: JSON libre representando el evento a almacenar.
//          - Respuestas:
//              201 { status, queue, id, recordedAt }
//              400 { error } cuando el payload no es JSON o no es un objeto.
//   GET    /event-log/queues/:name/events?since=ISO-8601
//          - Devuelve todos los eventos almacenados para la cola desde la fecha indicada (incluida).
//          - Los eventos nunca se eliminan.
//   GET    /metrics
//          - Resumen con el total de eventos y el total por cola.
//   GET    /microfrontends/event-log-monitor.js
//          - Entrega el Web Component que visualiza las métricas.
//
// Niveles de fallo simulados (start({ failureLevel })):
//   0 (por defecto): operación perfecta, sin fallos artificiales.
//   1-3: reservado para futuras simulaciones (actualmente no se inyectan fallos).

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const DEFAULT_PORT = 4400;
const DEFAULT_STORAGE_DIR = path.join(__dirname, "data");
const EVENTS_FILENAME = "events.log";
const MICROFRONTEND_FILENAME = "event-log-monitor.microfrontend";

let cachedMicrofrontendScript = null;

function readMicrofrontendScript() {
  if (cachedMicrofrontendScript === null) {
    const microfrontendPath = path.join(__dirname, MICROFRONTEND_FILENAME);
    cachedMicrofrontendScript = fs.readFileSync(microfrontendPath, "utf8");
  }
  return cachedMicrofrontendScript;
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function purgeStorage(storageDir, logPrefix = "[event-log]") {
  if (fs.existsSync(storageDir)) {
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
  ensureDirectory(storageDir);
  console.info(`${logPrefix} Estado en disco purgado en ${storageDir}`);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        request.socket.destroy();
        reject(new Error("Payload demasiado grande"));
      }
    });
    request.on("end", () => {
      if (!body) {
        reject(new Error("Payload vacío"));
        return;
      }
      try {
        const parsed = JSON.parse(body);
        resolve(parsed);
      } catch (error) {
        reject(new Error("Payload debe ser JSON válido"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(JSON.stringify(payload));
}

function sendMicrofrontend(response) {
  const script = readMicrofrontendScript();
  response.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(script);
}

function sendNotFound(response) {
  sendJson(response, 404, { error: "Recurso no encontrado" });
}

function parseSinceParam(urlInstance) {
  const sinceParam = urlInstance.searchParams.get("since");
  if (!sinceParam) {
    throw new Error("El parámetro 'since' es obligatorio y debe ser ISO-8601");
  }
  const sinceDate = new Date(sinceParam);
  if (Number.isNaN(sinceDate.getTime())) {
    throw new Error("El parámetro 'since' debe tener formato ISO-8601 válido");
  }
  return { sinceParam, sinceDate };
}

function createEventStore(storageFilePath) {
  const eventsByQueue = new Map();
  let totalEvents = 0;
  let sequence = 0;

  function ensureQueue(queueName) {
    if (!eventsByQueue.has(queueName)) {
      eventsByQueue.set(queueName, []);
    }
    return eventsByQueue.get(queueName);
  }

  function persistEvent(entry) {
    const serialized = `${JSON.stringify(entry)}\n`;
    fs.promises.appendFile(storageFilePath, serialized).catch((error) => {
      console.error(`[event-log] Error al persistir evento ${entry.id}: ${error.message}`);
    });
  }

  function recordEvent(queueName, payload) {
    const queueEvents = ensureQueue(queueName);
    sequence += 1;
    const recordedAt = new Date().toISOString();
    const entry = {
      id: `evt_${Date.now()}_${sequence}`,
      queue: queueName,
      recordedAt,
      event: payload,
    };
    queueEvents.push(entry);
    totalEvents += 1;
    persistEvent(entry);
    return entry;
  }

  function listEvents(queueName, sinceDate) {
    const queueEvents = ensureQueue(queueName);
    const sinceTime = sinceDate.getTime();
    return queueEvents.filter((event) => new Date(event.recordedAt).getTime() >= sinceTime);
  }

  function getMetrics() {
    const queues = Array.from(eventsByQueue.entries()).map(([name, events]) => ({
      name,
      totalEvents: events.length,
      lastEventAt: events.length > 0 ? events[events.length - 1].recordedAt : null,
    }));
    queues.sort((a, b) => a.name.localeCompare(b.name, "es"));
    return {
      totalEvents,
      queues,
    };
  }

  return {
    recordEvent,
    listEvents,
    getMetrics,
  };
}

function handleCors(request, response) {
  const method = request.method || "GET";
  if (method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    response.end();
    return true;
  }
  return false;
}

function start({ port = DEFAULT_PORT, storageDir = DEFAULT_STORAGE_DIR, failureLevel = 0 } = {}) {
  return new Promise((resolve, reject) => {
    try {
      purgeStorage(storageDir);
    } catch (error) {
      reject(error);
      return;
    }

    const storageFilePath = path.join(storageDir, EVENTS_FILENAME);
    const store = createEventStore(storageFilePath);

    const server = http.createServer(async (request, response) => {
      if (handleCors(request, response)) {
        return;
      }

      let urlInstance;
      try {
        const host = request.headers.host || `localhost:${port}`;
        urlInstance = new URL(request.url || "/", `http://${host}`);
      } catch (error) {
        sendJson(response, 400, { error: "URL inválida" });
        return;
      }

      const { pathname } = urlInstance;
      const method = request.method || "GET";

      if (pathname === "/metrics" && method === "GET") {
        const metrics = store.getMetrics();
        sendJson(response, 200, metrics);
        return;
      }

      if (pathname === "/microfrontends/event-log-monitor.js" && method === "GET") {
        sendMicrofrontend(response);
        return;
      }

      const queueMatch = pathname.match(/^\/event-log\/queues\/([^/]+)\/events$/);
      if (queueMatch) {
        const queueName = decodeURIComponent(queueMatch[1]);
        if (!queueName) {
          sendJson(response, 400, { error: "El nombre de la cola es obligatorio" });
          return;
        }

        if (method === "POST") {
          try {
            const payload = await readRequestBody(request);
            if (typeof payload !== "object" || payload === null) {
              sendJson(response, 400, { error: "El evento debe ser un objeto JSON" });
              return;
            }
            if (failureLevel > 0) {
              // Reservado para introducir fallos en futuras iteraciones.
            }
            const entry = store.recordEvent(queueName, payload);
            sendJson(response, 201, {
              status: "stored",
              queue: queueName,
              id: entry.id,
              recordedAt: entry.recordedAt,
            });
          } catch (error) {
            sendJson(response, 400, { error: error.message });
          }
          return;
        }

        if (method === "GET") {
          try {
            const { sinceParam, sinceDate } = parseSinceParam(urlInstance);
            const events = store.listEvents(queueName, sinceDate);
            sendJson(response, 200, {
              queue: queueName,
              since: sinceParam,
              events,
            });
          } catch (error) {
            sendJson(response, 400, { error: error.message });
          }
          return;
        }
      }

      sendNotFound(response);
    });

    server.on("error", (error) => {
      console.error(`[event-log] Error en el servidor: ${error.message}`);
    });

    server.listen(port, () => {
      console.info(`[event-log] Escuchando en el puerto ${port}`);
      resolve({
        server,
        stop: () =>
          new Promise((stopResolve, stopReject) => {
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
    name: "Event Log Simulator",
    description: "Registro de eventos en memoria con API de lectura y microfrontend de métricas.",
  },
  microfrontend: {
    tagName: "event-log-monitor",
    url: "/microfrontends/event-log-monitor.js",
    props: {
      "metrics-url": "/metrics",
    },
  },
};
