"use strict";

const fs = require("node:fs");
const path = require("node:path");
const mysql = require("mysql2/promise");

function resolvePath(manifestDir, filePath) {
  if (!filePath) {
    throw new Error("Se esperaba una ruta de archivo para inicializar MySQL");
  }
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  const candidate = path.resolve(manifestDir, filePath);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return path.resolve(process.cwd(), filePath);
}

async function applySchema(connection, sqlScript) {
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
    console.warn("[utility:init] No se proporcionó esquema de MySQL, se omite la inicialización");
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
    await applySchema(connection, schemaSql);
    console.info(`[utility:init] Esquema CRM aplicado desde ${schemaPath}`);
  } finally {
    await connection.end();
  }
}

async function start(options = {}) {
  const manifestDir = __dirname;
  await setupMysql(manifestDir, options.mysql || {});
  return {
    stop: async () => {},
  };
}

module.exports = {
  start,
};
