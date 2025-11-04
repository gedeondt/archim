"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { URL } = require("node:url");
const mysql = require("mysql2/promise");

const DEFAULT_MICROFRONT_PATH = path.join(
  __dirname,
  "../microfront/CrmDashboard.microfrontend"
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

async function fetchCustomers(pool, pagination) {
  const offset = (pagination.page - 1) * pagination.pageSize;
  const [[countRow]] = await pool.execute("SELECT COUNT(*) AS total FROM customers");
  const [rows] = await pool.execute(
    "SELECT id, first_name, last_name, dni, created_at FROM customers ORDER BY created_at DESC LIMIT ? OFFSET ?",
    [pagination.pageSize, offset]
  );
  return {
    items: rows.map((row) => ({
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      dni: row.dni,
      createdAt: row.created_at,
    })),
    total: Number(countRow?.total) || 0,
  };
}

async function fetchContracts(pool, pagination) {
  const offset = (pagination.page - 1) * pagination.pageSize;
  const [[countRow]] = await pool.execute("SELECT COUNT(*) AS total FROM contracts");
  const [rows] = await pool.execute(
    `SELECT
       contracts.id,
       contracts.order_id,
       contracts.tariff_code,
       contracts.tariff_name,
       contracts.status,
       contracts.recorded_at,
       customers.first_name,
       customers.last_name,
       customers.dni,
       supply_points.cups
     FROM contracts
     INNER JOIN supply_points ON supply_points.id = contracts.supply_point_id
     INNER JOIN customers ON customers.id = supply_points.customer_id
     ORDER BY contracts.recorded_at DESC
     LIMIT ? OFFSET ?`,
    [pagination.pageSize, offset]
  );
  return {
    items: rows.map((row) => ({
      id: row.id,
      orderId: row.order_id,
      tariffCode: row.tariff_code,
      tariffName: row.tariff_name,
      status: row.status,
      recordedAt: row.recorded_at,
      customerName: `${row.first_name} ${row.last_name}`.trim(),
      customerDni: row.dni,
      cups: row.cups,
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

    if (urlObj.pathname === "/microfront/crm-dashboard.js") {
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

    if (urlObj.pathname === "/api/crm/customers") {
      try {
        const pagination = normalizePagination(urlObj.searchParams, paginationDefaults);
        const result = await fetchCustomers(pool, pagination);
        sendJson(response, 200, {
          data: result.items,
          pagination: buildPaginationMeta(pagination, result.total),
        });
      } catch (error) {
        console.error(`[utility:crm-bff] Error obteniendo clientes: ${error.message}`);
        sendJson(response, 500, { error: "No se pudieron obtener los clientes" });
      }
      return;
    }

    if (urlObj.pathname === "/api/crm/contracts") {
      try {
        const pagination = normalizePagination(urlObj.searchParams, paginationDefaults);
        const result = await fetchContracts(pool, pagination);
        sendJson(response, 200, {
          data: result.items,
          pagination: buildPaginationMeta(pagination, result.total),
        });
      } catch (error) {
        console.error(`[utility:crm-bff] Error obteniendo contratos: ${error.message}`);
        sendJson(response, 500, { error: "No se pudieron obtener los contratos" });
      }
      return;
    }

    sendJson(response, 404, { error: "Not Found" });
  });
}

async function start(options = {}) {
  const mysqlConfig = options.mysql || {};
  const pool = mysql.createPool({
    host: mysqlConfig.host || "localhost",
    port: mysqlConfig.port || 3307,
    user: mysqlConfig.user || "root",
    password: mysqlConfig.password || "",
    database: mysqlConfig.database || "crm",
    waitForConnections: true,
    connectionLimit: mysqlConfig.connectionLimit || 4,
    queueLimit: 0,
  });

  const server = createServer({
    pool,
    microfrontPath: options.microfrontPath,
    defaults: {
      pageSize: options.pageSize || 5,
      maxPageSize: options.maxPageSize || 25,
    },
  });

  const port = options.port || 5900;

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, () => {
      console.info(`[utility:crm-bff] Escuchando en el puerto ${port}`);
      resolve({
        server,
        stop: () =>
          new Promise((stopResolve, stopReject) => {
            server.close(async (serverError) => {
              try {
                await pool.end();
              } catch (poolError) {
                console.error(`[utility:crm-bff] Error cerrando pool: ${poolError.message}`);
              }
              if (serverError) {
                stopReject(serverError);
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
    name: "utility-crm-dashboard-bff",
    description: "BFF que expone el microfront de CRM y lecturas paginadas de clientes y contratos",
  },
};
