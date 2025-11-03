"use strict";

const assert = require("node:assert/strict");
const mysql = require("mysql2/promise");

const MYSQL_DEFAULT_PORT = 3307;

function resolveMysqlPort({ mysqlPort } = {}) {
  if (typeof mysqlPort === "number" && Number.isFinite(mysqlPort)) {
    return mysqlPort;
  }
  const fromEnv = process.env.MYSQL_SIMULATOR_MYSQL_PORT || process.env.MYSQL_SIMULATOR_PORT;
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return MYSQL_DEFAULT_PORT;
}

function resolveBaseUrl({ baseUrl, port } = {}) {
  if (baseUrl) {
    return baseUrl;
  }
  if (port) {
    return `http://localhost:${port}`;
  }
  return "http://localhost:4500";
}

async function parseJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Esperaba JSON pero recibí: ${text.slice(0, 120)}`);
  }
}

async function run({ baseUrl, port, mysqlPort } = {}) {
  const serviceBaseUrl = resolveBaseUrl({ baseUrl, port });
  const metricsUrl = `${serviceBaseUrl}/metrics`;
  const microfrontendUrl = `${serviceBaseUrl}/microfrontends/mysql-simulator.js`;
  const resolvedMysqlPort = resolveMysqlPort({ mysqlPort });

  const details = [];
  let passed = 0;
  let failed = 0;

  async function step(title, fn) {
    try {
      const detail = await fn();
      if (typeof detail === "string" && detail.length > 0) {
        details.push(`✅ ${title} (${detail})`);
      } else {
        details.push(`✅ ${title}`);
      }
      passed += 1;
    } catch (error) {
      details.push(`❌ ${title}: ${error.message}`);
      failed += 1;
    }
  }

  await step("/metrics responde con conteos", async () => {
    const response = await fetch(metricsUrl, { cache: "no-store" });
    assert.equal(response.status, 200, "El endpoint /metrics debe responder 200");
    const body = await parseJson(response);
    assert.ok(typeof body.queryCount === "number", "queryCount debe ser numérico");
    assert.ok(typeof body.databaseCount === "number", "databaseCount debe ser numérico");
    return `queryCount=${body.queryCount}, databaseCount=${body.databaseCount}`;
  });

  await step("microfrontend está disponible", async () => {
    const response = await fetch(microfrontendUrl, { cache: "no-store" });
    assert.equal(response.status, 200, "El microfrontend debe cargarse correctamente");
    const script = await response.text();
    assert.ok(script.includes("mysql-simulator-dashboard"), "El script debe definir el componente web");
    return `tamaño=${script.length}`;
  });

  await step("puede ejecutar operaciones básicas de MySQL", async () => {
    const connection = await mysql.createConnection({
      host: "127.0.0.1",
      port: resolvedMysqlPort,
      user: "tester",
      password: "",
    });

    const dbName = `test_${Date.now()}`;
    const tableName = "people";

    try {
      const [createDb] = await connection.query(`CREATE DATABASE ${dbName}`);
      assert.equal(createDb.affectedRows, 0, "CREATE DATABASE no debería afectar filas");

      const [useResult] = await connection.query(`USE ${dbName}`);
      assert.equal(useResult.affectedRows, 0, "USE no debería afectar filas");

      const [createTable] = await connection.query(
        `CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`
      );
      assert.equal(createTable.affectedRows, 0, "CREATE TABLE no debería afectar filas");

      const [insertResult] = await connection.query(
        `INSERT INTO ${tableName} (name) VALUES ('Alice'), ('Bob')`
      );
      assert.equal(insertResult.affectedRows, 2, "INSERT debe afectar 2 filas");

      const [beforeUpdateRows] = await connection.query(
        `SELECT id, name FROM ${tableName} ORDER BY id ASC`
      );
      assert.deepEqual(
        beforeUpdateRows.map((row) => row.name),
        ["Alice", "Bob"],
        "Los datos insertados deben recuperarse correctamente"
      );

      const [updateResult] = await connection.query(
        `UPDATE ${tableName} SET name='Robert' WHERE name='Bob'`
      );
      assert.equal(updateResult.affectedRows, 1, "UPDATE debe afectar 1 fila");

      const [deleteResult] = await connection.query(
        `DELETE FROM ${tableName} WHERE name='Alice'`
      );
      assert.equal(deleteResult.affectedRows, 1, "DELETE debe afectar 1 fila");

      const [finalRows] = await connection.query(
        `SELECT id, name FROM ${tableName} ORDER BY id ASC`
      );
      assert.deepEqual(
        finalRows.map((row) => row.name),
        ["Robert"],
        "Después de UPDATE y DELETE debe quedar un solo registro"
      );

      const metricsResponse = await fetch(metricsUrl, { cache: "no-store" });
      assert.equal(metricsResponse.status, 200, "/metrics debe responder 200 tras operaciones");
      const metrics = await parseJson(metricsResponse);
      const databaseMeta = Array.isArray(metrics.databases)
        ? metrics.databases.find((entry) => entry && entry.name === dbName)
        : undefined;
      assert.ok(databaseMeta, "Las métricas deben incluir la base de datos creada en la prueba");
      const tableMeta = Array.isArray(databaseMeta.tables)
        ? databaseMeta.tables.find((entry) => entry && entry.name === tableName)
        : undefined;
      assert.ok(tableMeta, "Las métricas deben listar la tabla creada");
      assert.equal(tableMeta.rowCount, 1, "Las métricas deben reflejar el número de filas restante");

      return `db=${dbName}, filas=${tableMeta.rowCount}`;
    } finally {
      await connection.end();
    }
  });

  return {
    passed,
    failed,
    details,
  };
}

module.exports = {
  run,
};
