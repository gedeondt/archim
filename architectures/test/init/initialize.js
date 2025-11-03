"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");
const mysql = require("mysql2/promise");

function resolvePath(baseDir, filePath) {
  if (!filePath) {
    throw new Error("Expected a file path");
  }
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  const candidate = path.resolve(baseDir, filePath);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return path.resolve(process.cwd(), filePath);
}

async function executeSqlStatements(connection, sqlScript) {
  const statements = sqlScript
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) {
    // eslint-disable-next-line no-await-in-loop
    await connection.query(statement);
  }
}

async function setupMysql(manifestDir, mysqlOptions = {}) {
  if (!mysqlOptions.schema) {
    console.warn("[test:init] No se proporcionó ruta de esquema para MySQL, se omite la inicialización");
    return;
  }
  const schemaPath = resolvePath(manifestDir, mysqlOptions.schema);
  const schemaSql = await fs.promises.readFile(schemaPath, "utf8");
  const connection = await mysql.createConnection({
    host: mysqlOptions.host || "localhost",
    port: mysqlOptions.port || 3307,
    user: mysqlOptions.user || "root",
    password: mysqlOptions.password || "",
    multipleStatements: true,
  });
  try {
    await executeSqlStatements(connection, schemaSql);
    console.info(`[test:init] Esquema MySQL aplicado desde ${schemaPath}`);
  } finally {
    await connection.end();
  }
}

function httpRequest(method, targetUrl, body, headers = {}) {
  const urlObject = new URL(targetUrl);
  const payload = body !== undefined ? JSON.stringify(body) : null;
  const requestOptions = {
    method,
    hostname: urlObject.hostname,
    port: urlObject.port || (urlObject.protocol === "https:" ? 443 : 80),
    path: `${urlObject.pathname}${urlObject.search}`,
    headers: {
      ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
      ...headers,
    },
  };
  const requestFn = urlObject.protocol === "https:" ? https.request : http.request;

  return new Promise((resolve, reject) => {
    const request = requestFn(requestOptions, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const statusOk = response.statusCode >= 200 && response.statusCode < 300;
        if (!statusOk) {
          reject(new Error(`${method} ${targetUrl} responded with status ${response.statusCode}: ${raw}`));
          return;
        }
        if (raw.length === 0) {
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
    request.on("error", reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

async function ensureDynamoCollections(manifestDir, dynamodbOptions = {}) {
  const { endpoint, collections } = dynamodbOptions;
  if (!endpoint || !Array.isArray(collections) || collections.length === 0) {
    console.warn("[test:init] Configuración de DynamoDB incompleta, se omite");
    return;
  }
  for (const entry of collections) {
    const collectionName = typeof entry === "string" ? entry : entry && entry.name;
    if (!collectionName) {
      continue;
    }
    const payload = { name: collectionName };
    try {
      // eslint-disable-next-line no-await-in-loop
      await httpRequest("POST", `${endpoint.replace(/\/$/, "")}/collections`, payload);
      console.info(`[test:init] Colección DynamoDB '${collectionName}' preparada`);
    } catch (error) {
      console.error(`[test:init] Error creando colección '${collectionName}': ${error.message}`);
      throw error;
    }
  }
}

async function pingQueues(queueOptions = {}) {
  const { endpoint, names } = queueOptions;
  if (!endpoint || !Array.isArray(names) || names.length === 0) {
    console.warn("[test:init] Configuración de cola incompleta, se omite");
    return;
  }
  for (const name of names) {
    const normalized = String(name);
    const queueUrl = `${endpoint.replace(/\/$/, "")}/queues/${encodeURIComponent(normalized)}/messages`;
    try {
      // eslint-disable-next-line no-await-in-loop
      await httpRequest("GET", queueUrl);
      console.info(`[test:init] Cola '${normalized}' disponible en ${queueUrl}`);
    } catch (error) {
      console.error(`[test:init] No se pudo acceder a la cola '${normalized}': ${error.message}`);
      throw error;
    }
  }
}

async function start(options = {}) {
  const manifestDir = __dirname;
  await setupMysql(manifestDir, options.mysql || {});
  await ensureDynamoCollections(manifestDir, options.dynamodb || {});
  await pingQueues(options.queue || {});
  return {
    stop: async () => {},
  };
}

module.exports = {
  start,
};
