"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { URL } = require("node:url");
const mysql = require("mysql2/promise");

const { createEventLogClient } = require("../../../lib/event-log-client");

const DEFAULT_MICROFRONT_PATH = path.join(
  __dirname,
  "../microfront/BillingDashboard.microfrontend"
);

let cachedMicrofront = null;
let cachedMicrofrontPath = null;

function resolveMicrofrontPath(providedPath) {
  if (!providedPath) {
    return DEFAULT_MICROFRONT_PATH;
  }
  if (path.isAbsolute(providedPath)) {
    return providedPath;
  }
  const fromCwd = path.resolve(process.cwd(), providedPath);
  if (fs.existsSync(fromCwd)) {
    return fromCwd;
  }
  return path.resolve(__dirname, providedPath);
}

function loadMicrofrontScript(customPath) {
  const scriptPath = resolveMicrofrontPath(customPath);
  if (!cachedMicrofront || cachedMicrofrontPath !== scriptPath) {
    cachedMicrofront = fs.readFileSync(scriptPath, "utf8");
    cachedMicrofrontPath = scriptPath;
  }
  return cachedMicrofront;
}

function enableCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function handleOptions(response) {
  enableCors(response);
  response.writeHead(204);
  response.end();
}

function sendJson(response, statusCode, payload) {
  enableCors(response);
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function parsePositiveInt(value, fallback) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number) || number <= 0) {
    return fallback;
  }
  return number;
}

function normalizePagination(searchParams, defaults = {}) {
  const page = Math.max(1, parsePositiveInt(searchParams.get("page"), defaults.page || 1));
  const pageSize = Math.min(
    defaults.maxPageSize || 20,
    Math.max(1, parsePositiveInt(searchParams.get("pageSize"), defaults.pageSize || 5))
  );
  return { page, pageSize };
}

function sanitizeText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function parseInteger(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value !== "") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

async function getFirstRow(pool, query, params = []) {
  const [rows] = await pool.execute(query, params);
  if (Array.isArray(rows) && rows.length > 0) {
    return rows[0];
  }
  return null;
}

async function fetchCustomers(pool, pagination) {
  const offset = (pagination.page - 1) * pagination.pageSize;
  const [[countRow]] = await pool.execute("SELECT COUNT(*) AS total FROM customers");
  const [rows] = await pool.execute(
    `SELECT crm_customer_id, first_name, last_name, dni, crm_created_at, last_event_at
     FROM customers
     ORDER BY last_event_at DESC
     LIMIT ? OFFSET ?`,
    [pagination.pageSize, offset]
  );
  return {
    items: rows.map((row) => ({
      crmCustomerId: parseInteger(row.crm_customer_id),
      firstName: row.first_name,
      lastName: row.last_name,
      dni: row.dni,
      crmCreatedAt: row.crm_created_at,
      lastEventAt: row.last_event_at,
      fullName: `${row.first_name} ${row.last_name}`.trim(),
    })),
    total: Number(countRow?.total) || 0,
  };
}

async function fetchContracts(pool, pagination) {
  const offset = (pagination.page - 1) * pagination.pageSize;
  const [[countRow]] = await pool.execute("SELECT COUNT(*) AS total FROM contracts");
  const [rows] = await pool.execute(
    `SELECT
       contracts.crm_contract_id,
       contracts.crm_customer_id,
       contracts.order_id,
       contracts.tariff_code,
       contracts.tariff_name,
       contracts.crm_status,
       contracts.crm_recorded_at,
       contracts.billing_status,
       contracts.cups,
       contracts.last_event_at,
       customers.first_name,
       customers.last_name,
       customers.dni
     FROM contracts
     LEFT JOIN customers ON customers.crm_customer_id = contracts.crm_customer_id
     ORDER BY contracts.crm_recorded_at DESC
     LIMIT ? OFFSET ?`,
    [pagination.pageSize, offset]
  );
  return {
    items: rows.map((row) => ({
      crmContractId: parseInteger(row.crm_contract_id),
      crmCustomerId: parseInteger(row.crm_customer_id),
      orderId: row.order_id,
      tariffCode: row.tariff_code,
      tariffName: row.tariff_name,
      crmStatus: row.crm_status,
      crmRecordedAt: row.crm_recorded_at,
      billingStatus: row.billing_status,
      cups: row.cups,
      lastEventAt: row.last_event_at,
      customerName: `${sanitizeText(row.first_name)} ${sanitizeText(row.last_name)}`.trim(),
      customerDni: row.dni || "",
    })),
    total: Number(countRow?.total) || 0,
  };
}

function buildPaginationMeta(pagination, total) {
  const totalPages = total === 0 ? 0 : Math.ceil(total / pagination.pageSize);
  return {
    page: pagination.page,
    pageSize: pagination.pageSize,
    total,
    totalPages,
  };
}

function extractEventPayload(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  if (entry.event && typeof entry.event === "object") {
    return entry.event;
  }
  return entry;
}

function ensureTimestamp(value, fallback) {
  if (!value) {
    return fallback || new Date().toISOString();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return fallback || new Date().toISOString();
  }
  return date.toISOString();
}

async function upsertBillingCustomer(pool, payload, recordedAt) {
  const customer = payload.customer || payload;
  const crmCustomerId = parseInteger(customer.id || customer.crmCustomerId);
  if (!crmCustomerId) {
    return;
  }

  const firstName = sanitizeText(customer.firstName || customer.name || "");
  const lastName = sanitizeText(customer.lastName || customer.surname || "");
  const dni = sanitizeText(customer.dni || "");
  const crmCreatedAt = ensureTimestamp(customer.createdAt, recordedAt);
  const lastEventAt = ensureTimestamp(recordedAt);

  const existing = await getFirstRow(
    pool,
    "SELECT id FROM customers WHERE crm_customer_id = ? LIMIT 1",
    [crmCustomerId]
  );

  if (existing) {
    await pool.execute(
      `UPDATE customers
       SET first_name = ?, last_name = ?, dni = ?, crm_created_at = ?, last_event_at = ?
       WHERE crm_customer_id = ?`,
      [firstName, lastName, dni, crmCreatedAt, lastEventAt, crmCustomerId]
    );
    return;
  }

  await pool.execute(
    `INSERT INTO customers (crm_customer_id, first_name, last_name, dni, crm_created_at, last_event_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [crmCustomerId, firstName, lastName, dni, crmCreatedAt, lastEventAt]
  );
}

async function upsertBillingContract(pool, payload, recordedAt) {
  const contract = payload.contract || payload;
  const crmContractId = parseInteger(contract.id || contract.crmContractId);
  if (!crmContractId) {
    return;
  }

  const crmCustomerId =
    parseInteger(contract.customerId) ||
    parseInteger(payload.customer && payload.customer.id) ||
    parseInteger(payload.supplyPoint && payload.supplyPoint.customerId);

  if (!crmCustomerId) {
    return;
  }

  const orderId = sanitizeText(contract.orderId || "");
  const tariffCode = sanitizeText(contract.tariffCode || "");
  const tariffName = sanitizeText(contract.tariffName || tariffCode || "");
  const crmStatus = sanitizeText(contract.status || contract.crmStatus || "pending");
  const crmRecordedAt = ensureTimestamp(contract.recordedAt, recordedAt);
  const lastEventAt = ensureTimestamp(recordedAt);
  const cups = sanitizeText(contract.cups || (payload.supplyPoint && payload.supplyPoint.cups) || "");

  const existing = await getFirstRow(
    pool,
    "SELECT id FROM contracts WHERE crm_contract_id = ? LIMIT 1",
    [crmContractId]
  );

  if (existing) {
    await pool.execute(
      `UPDATE contracts
       SET crm_customer_id = ?, order_id = ?, tariff_code = ?, tariff_name = ?, crm_status = ?,
           crm_recorded_at = ?, cups = ?, last_event_at = ?
       WHERE crm_contract_id = ?`,
      [
        crmCustomerId,
        orderId,
        tariffCode,
        tariffName,
        crmStatus,
        crmRecordedAt,
        cups,
        lastEventAt,
        crmContractId,
      ]
    );
    return;
  }

  await pool.execute(
    `INSERT INTO contracts
       (crm_contract_id, crm_customer_id, order_id, tariff_code, tariff_name, crm_status, crm_recorded_at, billing_status, cups, last_event_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      crmContractId,
      crmCustomerId,
      orderId,
      tariffCode,
      tariffName,
      crmStatus,
      crmRecordedAt,
      cups,
      lastEventAt,
    ]
  );
}

function createIngestionLoop(pool, eventLogClient, config = {}) {
  const pollIntervalMs = config.pollIntervalMs || 4000;
  const customerQueue = config.customerQueue || "crm-clients";
  const contractQueue = config.contractQueue || "crm-contracts";

  const state = {
    customers: {
      since: config.startSince || new Date(0).toISOString(),
      lastProcessedAt: config.startSince ? new Date(config.startSince) : null,
    },
    contracts: {
      since: config.startSince || new Date(0).toISOString(),
      lastProcessedAt: config.startSince ? new Date(config.startSince) : null,
    },
  };

  let stopped = false;
  let timer = null;

  const processQueue = async (queueName, queueState, handler, queueLabel) => {
    if (!queueName) {
      return;
    }
    const events = await eventLogClient.fetchQueueEvents(queueName, queueState.since);
    if (!Array.isArray(events) || events.length === 0) {
      return;
    }

    for (const entry of events) {
      const payload = extractEventPayload(entry);
      const recordedAt = entry.recordedAt || queueState.since;
      const recordedTime = new Date(recordedAt);
      if (queueState.lastProcessedAt && recordedTime <= queueState.lastProcessedAt) {
        continue;
      }

      if (!payload) {
        queueState.lastProcessedAt = recordedTime;
        continue;
      }

      try {
        // eslint-disable-next-line no-await-in-loop
        await handler(payload, recordedAt);
        queueState.lastProcessedAt = recordedTime;
      } catch (error) {
        console.error(`[utility:billing-bff] Error procesando evento ${queueLabel}: ${error.message}`);
        queueState.lastProcessedAt = recordedTime;
      }
    }

    if (queueState.lastProcessedAt) {
      const nextSince = new Date(queueState.lastProcessedAt.getTime() + 1);
      queueState.since = nextSince.toISOString();
    }
  };

  const scheduleNext = () => {
    if (stopped) {
      return;
    }
    timer = setTimeout(async () => {
      try {
        await processQueue(
          customerQueue,
          state.customers,
          (payload, recordedAt) => upsertBillingCustomer(pool, payload, recordedAt),
          "clientes"
        );
        await processQueue(
          contractQueue,
          state.contracts,
          (payload, recordedAt) => upsertBillingContract(pool, payload, recordedAt),
          "contratos"
        );
      } catch (error) {
        console.error(`[utility:billing-bff] Error en sondeo de facturación: ${error.message}`);
      } finally {
        scheduleNext();
      }
    }, pollIntervalMs);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
  };

  scheduleNext();

  return {
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}

function createServer(config) {
  const { pool, microfrontPath, defaults } = config;
  const paginationDefaults = {
    page: 1,
    pageSize: defaults.pageSize || 5,
    maxPageSize: defaults.maxPageSize || 25,
  };

  return http.createServer(async (request, response) => {
    const { method = "GET", url = "/" } = request;

    if (method === "OPTIONS") {
      handleOptions(response);
      return;
    }

    if (method !== "GET") {
      sendJson(response, 405, { error: "Method Not Allowed" });
      return;
    }

    let urlObj;
    try {
      urlObj = new URL(url, "http://localhost");
    } catch (error) {
      sendJson(response, 400, { error: "URL inválida" });
      return;
    }

    if (urlObj.pathname === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (urlObj.pathname === "/microfront/billing-dashboard.js") {
      try {
        const script = loadMicrofrontScript(microfrontPath);
        enableCors(response);
        response.writeHead(200, { "Content-Type": "application/javascript" });
        response.end(script);
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    if (urlObj.pathname === "/api/billing/customers") {
      try {
        const pagination = normalizePagination(urlObj.searchParams, paginationDefaults);
        const result = await fetchCustomers(pool, pagination);
        sendJson(response, 200, {
          data: result.items,
          pagination: buildPaginationMeta(pagination, result.total),
        });
      } catch (error) {
        console.error(`[utility:billing-bff] Error obteniendo clientes: ${error.message}`);
        sendJson(response, 500, { error: "No se pudieron obtener los clientes de facturación" });
      }
      return;
    }

    if (urlObj.pathname === "/api/billing/contracts") {
      try {
        const pagination = normalizePagination(urlObj.searchParams, paginationDefaults);
        const result = await fetchContracts(pool, pagination);
        sendJson(response, 200, {
          data: result.items,
          pagination: buildPaginationMeta(pagination, result.total),
        });
      } catch (error) {
        console.error(`[utility:billing-bff] Error obteniendo contratos: ${error.message}`);
        sendJson(response, 500, { error: "No se pudieron obtener los contratos de facturación" });
      }
      return;
    }

    sendJson(response, 404, { error: "Not Found" });
  });
}

async function start(options = {}) {
  const port = options.port || 6000;
  const mysqlConfig = options.mysql || {};
  const pool = mysql.createPool({
    host: mysqlConfig.host || "localhost",
    port: mysqlConfig.port || 3307,
    user: mysqlConfig.user || "root",
    password: mysqlConfig.password || "",
    database: mysqlConfig.database || "billing",
    waitForConnections: true,
    connectionLimit: mysqlConfig.connectionLimit || 4,
  });

  const server = createServer({
    pool,
    microfrontPath: options.microfrontPath,
    defaults: {
      pageSize: options.pageSize,
      maxPageSize: options.maxPageSize,
    },
  });

  const eventLogClient = createEventLogClient({
    endpoint: options.eventLog?.endpoint || options.eventLogUrl,
  });

  const ingestionLoop = createIngestionLoop(pool, eventLogClient, {
    pollIntervalMs: options.eventLog?.pollIntervalMs || options.pollIntervalMs || 4000,
    customerQueue: options.eventLog?.customerQueue || options.customerQueue,
    contractQueue: options.eventLog?.contractQueue || options.contractQueue,
    startSince: options.eventLog?.startSince || options.startSince,
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, () => {
      console.info(`[utility:billing-bff] Escuchando en el puerto ${port}`);
      resolve({
        server,
        stop: async () => {
          await ingestionLoop.stop();
          await new Promise((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error) {
                rejectClose(error);
              } else {
                resolveClose();
              }
            });
          });
          try {
            await pool.end();
          } catch (error) {
            console.error(`[utility:billing-bff] Error cerrando pool MySQL: ${error.message}`);
          }
        },
      });
    });
  });
}

module.exports = {
  start,
  metadata: {
    name: "utility-billing-bff",
    description: "BFF de facturación que replica eventos del CRM y expone el microfrontend",
  },
};
