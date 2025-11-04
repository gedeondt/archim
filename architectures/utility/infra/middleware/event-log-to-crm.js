"use strict";

const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");
const mysql = require("mysql2/promise");

function normalizeBaseUrl(url) {
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

async function fetchEvents(eventLogConfig, since) {
  const baseUrl = normalizeBaseUrl(eventLogConfig.endpoint || "http://localhost:4400");
  const queueName = encodeURIComponent(eventLogConfig.queueName || "ecommerce");
  const url = `${baseUrl}/event-log/queues/${queueName}/events?since=${encodeURIComponent(since)}`;
  const response = await requestJson("GET", url);
  if (!response || !Array.isArray(response.events)) {
    return [];
  }
  return response.events;
}

function ensureOrderPayload(eventEntry) {
  if (!eventEntry || typeof eventEntry !== "object") {
    return null;
  }
  const payload = eventEntry.event || eventEntry.order || null;
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (payload.order && typeof payload.order === "object") {
    return payload.order;
  }
  return payload;
}

function sanitizeText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

async function getFirstRow(connection, query, params) {
  const [rows] = await connection.execute(query, params);
  if (Array.isArray(rows) && rows.length > 0) {
    return rows[0];
  }
  return null;
}

async function ensureCustomer(connection, customer, createdAt) {
  const firstName = sanitizeText(customer.firstName);
  const lastName = sanitizeText(customer.lastName);
  const dni = sanitizeText(customer.dni);

  if (dni) {
    const existing = await getFirstRow(connection, "SELECT id FROM customers WHERE dni = ? LIMIT 1", [dni]);
    if (existing && typeof existing.id === "number") {
      return existing.id;
    }
  }

  const [result] = await connection.execute(
    "INSERT INTO customers (first_name, last_name, dni, created_at) VALUES (?, ?, ?, ?)",
    [firstName, lastName, dni, createdAt]
  );

  if (result && typeof result.insertId === "number" && result.insertId > 0) {
    return result.insertId;
  }

  const fallbackQuery = dni
    ? "SELECT id FROM customers WHERE dni = ? ORDER BY id DESC LIMIT 1"
    : "SELECT id FROM customers WHERE first_name = ? AND last_name = ? AND created_at = ? ORDER BY id DESC LIMIT 1";
  const fallbackParams = dni ? [dni] : [firstName, lastName, createdAt];
  const fallback = await getFirstRow(connection, fallbackQuery, fallbackParams);
  if (fallback && typeof fallback.id === "number") {
    return fallback.id;
  }

  throw new Error("No se pudo determinar el cliente persistido");
}

async function ensureSupplyPoint(connection, customerId, supplyPoint, createdAt) {
  const address = sanitizeText(supplyPoint.address);
  const cups = sanitizeText(supplyPoint.cups);

  if (cups) {
    const existing = await getFirstRow(
      connection,
      "SELECT id, customer_id, address FROM supply_points WHERE cups = ? LIMIT 1",
      [cups]
    );
    if (existing && typeof existing.id === "number") {
      if (existing.customer_id !== customerId || sanitizeText(existing.address) !== address) {
        await connection.execute(
          "UPDATE supply_points SET customer_id = ?, address = ?, created_at = ? WHERE id = ?",
          [customerId, address, createdAt, existing.id]
        );
      }
      return existing.id;
    }
  }

  const [result] = await connection.execute(
    "INSERT INTO supply_points (customer_id, address, cups, created_at) VALUES (?, ?, ?, ?)",
    [customerId, address, cups, createdAt]
  );

  if (result && typeof result.insertId === "number" && result.insertId > 0) {
    return result.insertId;
  }

  const fallback = await getFirstRow(
    connection,
    "SELECT id FROM supply_points WHERE cups = ? ORDER BY id DESC LIMIT 1",
    [cups]
  );
  if (fallback && typeof fallback.id === "number") {
    return fallback.id;
  }

  throw new Error("No se pudo determinar el punto de suministro persistido");
}

async function upsertContract(connection, supplyPointId, order, recordedAt) {
  const contract = order.contract || {};
  const orderId = order.orderId || `order-${Date.now()}`;
  const rawTariffCode = sanitizeText(contract.tariffCode);
  const tariffCode = rawTariffCode || "unknown";
  const tariffName = sanitizeText(contract.tariffName) || rawTariffCode || "Sin nombre";
  const status = sanitizeText(contract.status) || "pending";
  const rawPayload = JSON.stringify(order);

  const existing = await getFirstRow(
    connection,
    "SELECT id FROM contracts WHERE order_id = ? LIMIT 1",
    [orderId]
  );

  if (existing && typeof existing.id === "number") {
    await connection.execute(
      "UPDATE contracts SET supply_point_id = ?, tariff_code = ?, tariff_name = ?, status = ?, recorded_at = ?, raw_payload = ? WHERE id = ?",
      [supplyPointId, tariffCode, tariffName, status, recordedAt, rawPayload, existing.id]
    );
    return;
  }

  await connection.execute(
    "INSERT INTO contracts (supply_point_id, order_id, tariff_code, tariff_name, status, recorded_at, raw_payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [supplyPointId, orderId, tariffCode, tariffName, status, recordedAt, rawPayload]
  );
}

async function persistOrder(connection, order, recordedAt) {
  const customer = order.customer || {};
  const supplyPoint = order.supplyPoint || {};

  const createdAt = order.createdAt || recordedAt;
  const customerId = await ensureCustomer(connection, customer, createdAt);
  const supplyPointId = await ensureSupplyPoint(connection, customerId, supplyPoint, createdAt);
  await upsertContract(connection, supplyPointId, order, recordedAt);
}

async function processEvents(connection, events, state) {
  for (const entry of events) {
    const recordedAt = entry.recordedAt || state.since;
    const order = ensureOrderPayload(entry);
    if (!order) {
      console.warn("[event-log-to-crm] Evento ignorado por no contener un pedido válido", entry);
      state.lastProcessedAt = new Date(recordedAt);
      continue;
    }

    const recordedTime = new Date(recordedAt);
    if (state.lastProcessedAt && recordedTime.getTime() <= state.lastProcessedAt.getTime()) {
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      await persistOrder(connection, order, recordedAt);
      state.lastProcessedAt = recordedTime;
      console.info(`[event-log-to-crm] Pedido ${order.orderId || "(sin id)"} almacenado en CRM`);
    } catch (error) {
      console.error(`[event-log-to-crm] Error guardando pedido: ${error.message}`);
      if (!state.lastProcessedAt || recordedTime.getTime() > state.lastProcessedAt.getTime()) {
        state.lastProcessedAt = recordedTime;
      }
    }
  }
}

function start(options = {}) {
  const eventLogConfig = options.eventLog || {};
  const mysqlConfig = options.mysql || {};
  const pollIntervalMs = options.pollIntervalMs || 4000;

  let stopped = false;
  let timer = null;
  const state = {
    since: options.startSince || new Date(0).toISOString(),
    lastProcessedAt: options.startSince ? new Date(options.startSince) : null,
  };

  let connectionPromise = mysql
    .createConnection({
      host: mysqlConfig.host || "localhost",
      port: mysqlConfig.port || 3307,
      user: mysqlConfig.user || "root",
      password: mysqlConfig.password || "",
      database: mysqlConfig.database || "crm",
    })
    .then((connection) => {
      console.info("[event-log-to-crm] Conectado a MySQL CRM");
      return connection;
    });

  const scheduleNext = () => {
    if (stopped) {
      return;
    }
    timer = setTimeout(async () => {
      try {
        const connection = await connectionPromise;
        const events = await fetchEvents(eventLogConfig, state.since);
        if (events.length > 0) {
          await processEvents(connection, events, state);
          if (state.lastProcessedAt) {
            const nextSince = new Date(state.lastProcessedAt.getTime() + 1);
            state.since = nextSince.toISOString();
          }
        }
      } catch (error) {
        console.error(`[event-log-to-crm] Error en ciclo de sondeo: ${error.message}`);
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
      try {
        const connection = await connectionPromise;
        await connection.end();
      } catch (error) {
        console.error(`[event-log-to-crm] Error cerrando conexión MySQL: ${error.message}`);
      }
    },
  });
}

module.exports = {
  start,
  metadata: {
    name: "event-log-to-crm",
    description: "Replica eventos del log 'ecommerce' en el esquema CRM de MySQL",
  },
};
