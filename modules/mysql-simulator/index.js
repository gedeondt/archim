"use strict";

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const dataDirectory = path.join(__dirname, "data");
const microfrontendPath = path.join(__dirname, "mysql-simulator.microfrontend");

const MYSQL_OK = 0x00;
const MYSQL_ERR = 0xff;
const MYSQL_EOF = 0xfe;

const SERVER_VERSION = "5.7.0-archim";
const DEFAULT_STATUS_FLAGS = 0x0002; // SERVER_STATUS_AUTOCOMMIT

const CLIENT_LONG_PASSWORD = 0x00000001;
const CLIENT_LONG_FLAG = 0x00000004;
const CLIENT_CONNECT_WITH_DB = 0x00000008;
const CLIENT_PROTOCOL_41 = 0x00000200;
const CLIENT_SECURE_CONNECTION = 0x00008000;
const CLIENT_PLUGIN_AUTH = 0x00080000;
const CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA = 0x00200000;

const SERVER_CAPABILITIES =
  CLIENT_LONG_PASSWORD |
  CLIENT_LONG_FLAG |
  CLIENT_CONNECT_WITH_DB |
  CLIENT_PROTOCOL_41 |
  CLIENT_SECURE_CONNECTION |
  CLIENT_PLUGIN_AUTH |
  CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA;

const MYSQL_TYPE_VAR_STRING = 0xfd;
const MYSQL_CHARACTER_SET_UTF8MB4 = 0x21;

let cachedMicrofrontend = null;

const state = {
  queryCount: 0,
  databases: new Map(), // dbName -> { name, sanitized, path, db, tables: Map(tableName -> { columns: string[], rowCount: number }) }
};

function closeDatabases() {
  for (const entry of state.databases.values()) {
    if (entry && entry.db) {
      try {
        entry.db.close();
      } catch (error) {
        console.warn(`[mysql-simulator] Failed to close database ${entry.name}: ${error.message}`);
      }
    }
  }
  state.databases.clear();
}

function ensureDataDirectory() {
  if (!fs.existsSync(dataDirectory)) {
    fs.mkdirSync(dataDirectory, { recursive: true });
  }
}

function sanitizeDatabaseName(name) {
  return String(name || "default").trim().replace(/[^A-Za-z0-9_]/g, "_") || "default";
}

function getDatabaseEntry(name) {
  const sanitized = sanitizeDatabaseName(name);
  const filePath = path.join(dataDirectory, `${sanitized}.sqlite`);
  ensureDataDirectory();
  if (!state.databases.has(name)) {
    const db = new Database(filePath);
    try {
      db.pragma("journal_mode = WAL");
    } catch (error) {
      console.warn(`[mysql-simulator] Unable to set journal_mode for ${name}: ${error.message}`);
    }
    db.pragma("foreign_keys = ON");
    state.databases.set(name, {
      name,
      sanitized,
      path: filePath,
      db,
      tables: new Map(),
    });
  }
  const entry = state.databases.get(name);
  if (!entry.db) {
    entry.db = new Database(entry.path);
  }
  return entry;
}

async function refreshDatabaseMetadata(name) {
  const entry = getDatabaseEntry(name);
  const tables = entry.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")
    .all();
  const tablesMap = new Map();
  for (const tableInfo of tables) {
    const tableName = tableInfo.name;
    if (!tableName) {
      continue;
    }
    const quotedTable = tableName.replace(/'/g, "''");
    const schema = entry.db.prepare(`PRAGMA table_info('${quotedTable}');`).all();
    const columns = schema.map((column) => column.name);
    const rowCountRow = entry.db
      .prepare(`SELECT COUNT(*) as count FROM '${quotedTable}';`)
      .get();
    const rowCount = rowCountRow ? Number(rowCountRow.count) || 0 : 0;
    tablesMap.set(tableName, {
      columns,
      rowCount,
    });
  }
  entry.tables = tablesMap;
  return entry;
}

function buildMetricsSnapshot() {
  const databases = Array.from(state.databases.values()).map((db) => ({
    name: db.name,
    tables: Array.from(db.tables.entries()).map(([tableName, tableMeta]) => ({
      name: tableName,
      columnCount: tableMeta.columns.length,
      rowCount: tableMeta.rowCount,
    })),
  }));
  return {
    queryCount: state.queryCount,
    databaseCount: databases.length,
    databases,
  };
}

function writeLengthEncodedInteger(value) {
  if (value < 0xfb) {
    return Buffer.from([value]);
  }
  if (value < 0x10000) {
    const buffer = Buffer.alloc(3);
    buffer[0] = 0xfc;
    buffer.writeUInt16LE(value, 1);
    return buffer;
  }
  if (value < 0x1000000) {
    const buffer = Buffer.alloc(4);
    buffer[0] = 0xfd;
    buffer.writeUIntLE(value, 1, 3);
    return buffer;
  }
  const buffer = Buffer.alloc(9);
  buffer[0] = 0xfe;
  buffer.writeBigUInt64LE(BigInt(value), 1);
  return buffer;
}

function writeLengthEncodedString(value) {
  const stringBuffer = Buffer.from(value, "utf8");
  return Buffer.concat([writeLengthEncodedInteger(stringBuffer.length), stringBuffer]);
}

function buildPacket(sequenceId, payload) {
  const header = Buffer.alloc(4);
  header.writeUIntLE(payload.length, 0, 3);
  header[3] = sequenceId;
  return Buffer.concat([header, payload]);
}

function buildOkPacket(sequenceId, { affectedRows = 0, lastInsertId = 0, status = DEFAULT_STATUS_FLAGS, warnings = 0, message = "" } = {}) {
  const payload = Buffer.concat([
    Buffer.from([MYSQL_OK]),
    writeLengthEncodedInteger(affectedRows),
    writeLengthEncodedInteger(lastInsertId),
    Buffer.from([status & 0xff, (status >> 8) & 0xff]),
    Buffer.from([warnings & 0xff, (warnings >> 8) & 0xff]),
    Buffer.from(message, "utf8"),
  ]);
  return buildPacket(sequenceId, payload);
}

function buildErrPacket(sequenceId, { code = 0x1235, sqlState = "HY000", message }) {
  const payload = Buffer.concat([
    Buffer.from([MYSQL_ERR]),
    Buffer.from([code & 0xff, (code >> 8) & 0xff]),
    Buffer.from("#" + sqlState, "utf8"),
    Buffer.from(message || "Unknown error", "utf8"),
  ]);
  return buildPacket(sequenceId, payload);
}

function buildEofPacket(sequenceId, { status = DEFAULT_STATUS_FLAGS, warnings = 0 } = {}) {
  const payload = Buffer.from([
    MYSQL_EOF,
    warnings & 0xff,
    (warnings >> 8) & 0xff,
    status & 0xff,
    (status >> 8) & 0xff,
  ]);
  return buildPacket(sequenceId, payload);
}

function buildColumnDefinitionPacket(sequenceId, { schema = "", table = "", name }) {
  const payload = Buffer.concat([
    writeLengthEncodedString("def"),
    writeLengthEncodedString(schema),
    writeLengthEncodedString(table),
    writeLengthEncodedString(table),
    writeLengthEncodedString(name),
    writeLengthEncodedString(name),
    Buffer.from([0x0c]),
    Buffer.from([MYSQL_CHARACTER_SET_UTF8MB4 & 0xff, (MYSQL_CHARACTER_SET_UTF8MB4 >> 8) & 0xff]),
    Buffer.from([0xff, 0xff, 0x00, 0x00]),
    Buffer.from([MYSQL_TYPE_VAR_STRING]),
    Buffer.from([0x00, 0x00]),
    Buffer.from([0x00]),
    Buffer.from([0x00, 0x00]),
  ]);
  return buildPacket(sequenceId, payload);
}

function buildRowPacket(sequenceId, values) {
  const parts = [];
  for (const value of values) {
    if (value === null || value === undefined) {
      parts.push(Buffer.from([0xfb]));
    } else {
      const stringValue = typeof value === "string" ? value : String(value);
      parts.push(writeLengthEncodedString(stringValue));
    }
  }
  return buildPacket(sequenceId, Buffer.concat(parts));
}

function readLengthEncodedInteger(buffer, offset) {
  const first = buffer[offset];
  if (first < 0xfb) {
    return [first, 1];
  }
  if (first === 0xfc) {
    return [buffer.readUInt16LE(offset + 1), 3];
  }
  if (first === 0xfd) {
    return [buffer.readUIntLE(offset + 1, 3), 4];
  }
  if (first === 0xfe) {
    return [Number(buffer.readBigUInt64LE(offset + 1)), 9];
  }
  return [null, 1];
}

async function runSelectQuery(databaseName, sql) {
  const entry = getDatabaseEntry(databaseName);
  const normalizedSql = sql.trim().replace(/;+$/g, "");
  const statement = entry.db.prepare(normalizedSql.length > 0 ? normalizedSql : sql);
  const columnsMeta = typeof statement.columns === "function" ? statement.columns() : [];
  const columns = columnsMeta.length > 0 ? columnsMeta.map((column) => column.name) : [];
  const rowsData = statement.all();
  const resolvedColumns = columns.length > 0 && rowsData.length > 0
    ? columns
    : rowsData.length > 0
      ? Object.keys(rowsData[0])
      : columns;
  const rows = rowsData.map((row) =>
    resolvedColumns.map((column) =>
      (Object.prototype.hasOwnProperty.call(row, column) ? row[column] : null)
    )
  );
  return {
    columns: resolvedColumns,
    rows,
  };
}

async function runNonSelectQuery(databaseName, sql) {
  const entry = getDatabaseEntry(databaseName);
  const normalizedSql = sql.trim().replace(/;+$/g, "");
  const statement = entry.db.prepare(normalizedSql.length > 0 ? normalizedSql : sql);
  let affectedRows = 0;
  const result = statement.run();
  if (typeof result.changes === "number") {
    affectedRows = result.changes;
  }
  await refreshDatabaseMetadata(databaseName);
  return { affectedRows };
}

async function handleShowDatabases(sequenceId, connection) {
  const rows = Array.from(state.databases.keys()).map((name) => [name]);
  const columns = ["Database"];
  return sendResultSet(sequenceId, connection, columns, rows, { schema: "information_schema", table: "SCHEMATA" });
}

async function handleShowTables(sequenceId, connection) {
  const current = connection.currentDatabase;
  if (!current) {
    return [buildErrPacket(sequenceId, { message: "No database selected" })];
  }
  await refreshDatabaseMetadata(current);
  const entry = state.databases.get(current);
  const rows = Array.from(entry.tables.keys()).map((name) => [name]);
  const columns = ["Tables_in_" + current];
  return sendResultSet(sequenceId, connection, columns, rows, { schema: current, table: "tables" });
}

async function handleDescribe(sequenceId, connection, tableName) {
  const current = connection.currentDatabase;
  if (!current) {
    return [buildErrPacket(sequenceId, { message: "No database selected" })];
  }
  await refreshDatabaseMetadata(current);
  const entry = state.databases.get(current);
  const tableMeta = entry.tables.get(tableName);
  if (!tableMeta) {
    return [buildErrPacket(sequenceId, { message: `Unknown table '${tableName}'` })];
  }
  const rows = tableMeta.columns.map((name) => [name]);
  const columns = ["Field"];
  return sendResultSet(sequenceId, connection, columns, rows, { schema: current, table: tableName });
}

function sendPackets(socket, packets) {
  for (const packet of packets) {
    socket.write(packet);
  }
}

function sendHandshake(connection) {
  const authData = crypto.randomBytes(20);
  const connectionIdBuffer = Buffer.alloc(4);
  connectionIdBuffer.writeUInt32LE(connection.id, 0);
  const part1 = authData.subarray(0, 8);
  const part2 = authData.subarray(8);
  const payload = Buffer.concat([
    Buffer.from([0x0a]),
    Buffer.from(SERVER_VERSION + "\0", "utf8"),
    connectionIdBuffer,
    part1,
    Buffer.from([0x00]),
    Buffer.from([SERVER_CAPABILITIES & 0xff, (SERVER_CAPABILITIES >> 8) & 0xff]),
    Buffer.from([MYSQL_CHARACTER_SET_UTF8MB4]),
    Buffer.from([DEFAULT_STATUS_FLAGS & 0xff, (DEFAULT_STATUS_FLAGS >> 8) & 0xff]),
    Buffer.from([
      (SERVER_CAPABILITIES >> 16) & 0xff,
      (SERVER_CAPABILITIES >> 24) & 0xff,
      authData.length + 1,
    ]),
    Buffer.alloc(10, 0x00),
    Buffer.concat([part2, Buffer.from([0x00])]),
    Buffer.from("mysql_native_password\0", "utf8"),
  ]);
  const packet = buildPacket(0x00, payload);
  connection.socket.write(packet);
  connection.state = "handshake";
}

async function sendResultSet(sequenceStart, connection, columns, rows, meta = {}) {
  const packets = [];
  let sequenceId = sequenceStart;
  packets.push(buildPacket(sequenceId, writeLengthEncodedInteger(columns.length)));
  sequenceId += 1;
  for (const columnName of columns) {
    packets.push(
      buildColumnDefinitionPacket(sequenceId, {
        schema: meta.schema || connection.currentDatabase || "",
        table: meta.table || "",
        name: columnName,
      })
    );
    sequenceId += 1;
  }
  packets.push(buildEofPacket(sequenceId, {}));
  sequenceId += 1;
  for (const row of rows) {
    packets.push(buildRowPacket(sequenceId, row));
    sequenceId += 1;
  }
  packets.push(buildEofPacket(sequenceId, {}));
  return packets;
}

function parseHandshakeResponse(connection, payload) {
  let offset = 0;
  const clientCapabilities = payload.readUInt32LE(offset);
  offset += 4;
  offset += 4; // max packet size
  offset += 1; // charset
  offset += 23; // reserved

  const usernameEnd = payload.indexOf(0x00, offset);
  let username = "";
  if (usernameEnd >= 0) {
    username = payload.subarray(offset, usernameEnd).toString("utf8");
    offset = usernameEnd + 1;
  } else {
    username = payload.subarray(offset).toString("utf8");
    offset = payload.length;
  }

  let authResponseLength = 0;
  if (clientCapabilities & CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA) {
    const [len, consumed] = readLengthEncodedInteger(payload, offset);
    offset += consumed;
    authResponseLength = len || 0;
    offset += authResponseLength;
  } else if (clientCapabilities & CLIENT_SECURE_CONNECTION) {
    authResponseLength = payload[offset];
    offset += 1 + authResponseLength;
  } else {
    const end = payload.indexOf(0x00, offset);
    if (end >= 0) {
      offset = end + 1;
    } else {
      offset = payload.length;
    }
  }

  let databaseName = null;
  if (clientCapabilities & CLIENT_CONNECT_WITH_DB) {
    const end = payload.indexOf(0x00, offset);
    if (end >= 0) {
      databaseName = payload.subarray(offset, end).toString("utf8");
      offset = end + 1;
    }
  }

  if (clientCapabilities & CLIENT_PLUGIN_AUTH) {
    const end = payload.indexOf(0x00, offset);
    if (end >= 0) {
      offset = end + 1;
    }
  }

  connection.username = username;
  if (databaseName) {
    connection.currentDatabase = databaseName;
    refreshDatabaseMetadata(databaseName).catch(() => {});
  }
}

async function handleUseDatabase(sequenceId, connection, databaseName) {
  if (!databaseName) {
    return [buildErrPacket(sequenceId, { message: "Database name is required" })];
  }
  connection.currentDatabase = databaseName;
  await refreshDatabaseMetadata(databaseName).catch(() => {});
  return [buildOkPacket(sequenceId, { message: `Using database ${databaseName}` })];
}

async function handleQuery(sequenceId, connection, sql) {
  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    return [buildOkPacket(sequenceId, {})];
  }

  const upper = trimmed.toUpperCase();

  if (upper.startsWith("USE ")) {
    const dbName = trimmed.slice(4).replace(/;$/, "").trim();
    return handleUseDatabase(sequenceId, connection, dbName);
  }

  if (upper === "SHOW DATABASES") {
    return handleShowDatabases(sequenceId, connection);
  }

  if (upper === "SHOW TABLES") {
    return handleShowTables(sequenceId, connection);
  }

  const describeMatch = trimmed.match(/^DESCRIBE\s+([A-Za-z0-9_]+)/i);
  if (describeMatch) {
    return handleDescribe(sequenceId, connection, describeMatch[1]);
  }

  let targetDatabase = connection.currentDatabase || "default";
  getDatabaseEntry(targetDatabase);

  try {
    if (upper.startsWith("SELECT")) {
      const result = await runSelectQuery(targetDatabase, trimmed);
      return sendResultSet(sequenceId, connection, result.columns, result.rows);
    }

    if (upper.startsWith("CREATE DATABASE")) {
      const name = trimmed.replace(/CREATE DATABASE/i, "").replace(/;$/, "").trim();
      await refreshDatabaseMetadata(name).catch(() => {});
      return [buildOkPacket(sequenceId, { message: `Database ${name} created` })];
    }

    if (
      upper.startsWith("CREATE") ||
      upper.startsWith("INSERT") ||
      upper.startsWith("UPDATE") ||
      upper.startsWith("DELETE")
    ) {
      const { affectedRows } = await runNonSelectQuery(targetDatabase, trimmed);
      return [buildOkPacket(sequenceId, { affectedRows })];
    }

    return [buildErrPacket(sequenceId, { message: "Unsupported query" })];
  } catch (error) {
    return [buildErrPacket(sequenceId, { message: error.message })];
  }
}

function createConnectionHandler(serverState) {
  return (socket) => {
    const connection = {
      id: serverState.nextConnectionId += 1,
      socket,
      buffer: Buffer.alloc(0),
      state: "initial",
      currentDatabase: null,
      username: "",
    };

    sendHandshake(connection);

    socket.on("data", (chunk) => {
      connection.buffer = Buffer.concat([connection.buffer, chunk]);
      while (connection.buffer.length >= 4) {
        const packetLength = connection.buffer.readUIntLE(0, 3);
        const totalLength = packetLength + 4;
        if (connection.buffer.length < totalLength) {
          break;
        }
        const sequenceId = connection.buffer[3];
        const payload = connection.buffer.subarray(4, totalLength);
        connection.buffer = connection.buffer.subarray(totalLength);

        if (connection.state === "handshake") {
          parseHandshakeResponse(connection, payload);
          const okPacket = buildOkPacket(sequenceId + 1, { message: "Welcome" });
          socket.write(okPacket);
          connection.state = "ready";
        } else if (connection.state === "ready") {
          handleCommand(connection, payload, sequenceId);
        }
      }
    });

    socket.on("error", () => {
      socket.destroy();
    });
  };
}

function handleCommand(connection, payload, sequenceId) {
  if (payload.length === 0) {
    return;
  }
  const command = payload[0];
  const sqlString = payload.length > 1 ? payload.subarray(1).toString("utf8") : "";

  switch (command) {
    case 0x01: // COM_QUIT
      connection.socket.end();
      break;
    case 0x02: // COM_INIT_DB
      state.queryCount += 1;
      handleUseDatabase(1, connection, sqlString).then((packets) => {
        sendPackets(connection.socket, packets);
      });
      break;
    case 0x03: // COM_QUERY
      state.queryCount += 1;
      handleQuery(1, connection, sqlString).then((packets) => {
        sendPackets(connection.socket, packets);
      });
      break;
    case 0x0e: // COM_PING
      connection.socket.write(buildOkPacket(1, { message: "Pong" }));
      break;
    default:
      connection.socket.write(buildErrPacket(1, { message: `Command 0x${command.toString(16)} not supported` }));
      break;
  }
}

function startMySqlServer(port) {
  const serverState = { nextConnectionId: 0 };
  const server = net.createServer(createConnectionHandler(serverState));
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, () => {
      console.info(`[mysql-simulator] Listening for MySQL connections on port ${port}`);
      resolve({
        server,
        stop: () => new Promise((stopResolve) => {
          server.close(() => stopResolve());
        }),
      });
    });
  });
}

function getMicrofrontendScript() {
  if (cachedMicrofrontend === null) {
    cachedMicrofrontend = fs.readFileSync(microfrontendPath, "utf8");
  }
  return cachedMicrofrontend;
}

function startHttpServer(port) {
  const server = http.createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      response.end();
      return;
    }

    if (request.url === "/metrics") {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      response.end(JSON.stringify(buildMetricsSnapshot()));
      return;
    }

    if (request.url === "/microfrontends/mysql-simulator.js") {
      response.writeHead(200, {
        "Content-Type": "application/javascript",
        "Access-Control-Allow-Origin": "*",
      });
      response.end(getMicrofrontendScript());
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not Found");
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.info(`[mysql-simulator] HTTP metrics server running on port ${port}`);
      resolve({
        server,
        stop: () => new Promise((stopResolve) => {
          server.close(() => stopResolve());
        }),
      });
    });
  });
}

async function start({ port = 4500, mysqlPort = 3307 } = {}) {
  closeDatabases();
  state.queryCount = 0;
  ensureDataDirectory();
  const [mysqlServer, httpServer] = await Promise.all([
    startMySqlServer(mysqlPort),
    startHttpServer(port),
  ]);

  return {
    servers: { mysql: mysqlServer.server, http: httpServer.server },
    stop: async () => {
      await Promise.all([mysqlServer.stop(), httpServer.stop()]);
      closeDatabases();
    },
  };
}

module.exports = {
  start,
  metadata: {
    name: "MySQL Simulator",
    description: "Simulates a basic MySQL server backed by SQLite and exposes monitoring metrics.",
  },
};
