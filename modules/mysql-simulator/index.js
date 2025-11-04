"use strict";

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const MysqlTypes = {
  DECIMAL: 0x00,
  TINY: 0x01,
  SHORT: 0x02,
  LONG: 0x03,
  FLOAT: 0x04,
  DOUBLE: 0x05,
  NULL: 0x06,
  TIMESTAMP: 0x07,
  LONGLONG: 0x08,
  INT24: 0x09,
  DATE: 0x0a,
  TIME: 0x0b,
  DATETIME: 0x0c,
  YEAR: 0x0d,
  NEWDATE: 0x0e,
  VARCHAR: 0x0f,
  BIT: 0x10,
  JSON: 0xf5,
  NEWDECIMAL: 0xf6,
  ENUM: 0xf7,
  SET: 0xf8,
  TINY_BLOB: 0xf9,
  MEDIUM_BLOB: 0xfa,
  LONG_BLOB: 0xfb,
  BLOB: 0xfc,
  VAR_STRING: 0xfd,
  STRING: 0xfe,
  GEOMETRY: 0xff,
};

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

const MYSQL_COMMAND_STMT_PREPARE = 0x16;
const MYSQL_COMMAND_STMT_EXECUTE = 0x17;
const MYSQL_COMMAND_STMT_CLOSE = 0x19;

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

function clearDataDirectory() {
  if (!fs.existsSync(dataDirectory)) {
    return;
  }

  for (const entry of fs.readdirSync(dataDirectory)) {
    const entryPath = path.join(dataDirectory, entry);
    try {
      fs.rmSync(entryPath, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[mysql-simulator] Failed to remove ${entryPath}: ${error.message}`);
    }
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

function buildBinaryRowPacket(sequenceId, values, columnCount) {
  const header = Buffer.from([0x00]);
  const nullBitmapLength = Math.floor((columnCount + 2 + 7) / 8);
  const nullBitmap = Buffer.alloc(nullBitmapLength, 0);
  const parts = [header, nullBitmap];

  for (let index = 0; index < columnCount; index += 1) {
    const value = values[index];
    if (value === null || value === undefined) {
      const bitmapIndex = Math.floor((index + 2) / 8);
      const bit = (index + 2) % 8;
      nullBitmap[bitmapIndex] |= 1 << bit;
      continue;
    }

    if (Buffer.isBuffer(value)) {
      parts.push(writeLengthEncodedInteger(value.length));
      parts.push(Buffer.from(value));
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

function countStatementParameters(sql) {
  let count = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const prev = index > 0 ? sql[index - 1] : null;
    if (char === "'" && !inDouble && !inBacktick && prev !== "\\") {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle && !inBacktick && prev !== "\\") {
      inDouble = !inDouble;
      continue;
    }
    if (char === "`" && !inSingle && !inDouble && prev !== "\\") {
      inBacktick = !inBacktick;
      continue;
    }
    if (char === "?" && !inSingle && !inDouble && !inBacktick) {
      count += 1;
    }
  }
  return count;
}

function buildStmtPrepareOkPacket(sequenceId, { statementId, numColumns = 0, numParams = 0, warnings = 0 }) {
  const payload = Buffer.alloc(12);
  payload[0] = MYSQL_OK;
  payload.writeUInt32LE(statementId, 1);
  payload.writeUInt16LE(numColumns, 5);
  payload.writeUInt16LE(numParams, 7);
  payload[9] = 0x00;
  payload.writeUInt16LE(warnings, 10);
  return buildPacket(sequenceId, payload);
}

function padNumber(value, length) {
  return String(value).padStart(length, "0");
}

function parseBinaryDateOrDateTime(buffer, offset, type) {
  const length = buffer[offset];
  let consumed = 1;
  if (length === 0) {
    if (type === MysqlTypes.DATE || type === MysqlTypes.NEWDATE) {
      return ["0000-00-00", consumed];
    }
    return ["0000-00-00 00:00:00", consumed];
  }

  const year = buffer.readUInt16LE(offset + consumed);
  consumed += 2;
  const month = buffer[offset + consumed];
  consumed += 1;
  const day = buffer[offset + consumed];
  consumed += 1;

  let result = `${padNumber(year, 4)}-${padNumber(month, 2)}-${padNumber(day, 2)}`;

  if (type === MysqlTypes.DATE || type === MysqlTypes.NEWDATE || length === 4) {
    return [result, consumed];
  }

  const hour = buffer[offset + consumed];
  consumed += 1;
  const minute = buffer[offset + consumed];
  consumed += 1;
  const second = buffer[offset + consumed];
  consumed += 1;
  result += ` ${padNumber(hour, 2)}:${padNumber(minute, 2)}:${padNumber(second, 2)}`;

  if (length > 7) {
    const microseconds = buffer.readUInt32LE(offset + consumed);
    consumed += 4;
    if (microseconds > 0) {
      result += `.${padNumber(microseconds, 6)}`;
    }
  }

  return [result, consumed];
}

function parseBinaryTime(buffer, offset) {
  const length = buffer[offset];
  let consumed = 1;
  if (length === 0) {
    return ["00:00:00", consumed];
  }
  const isNegative = buffer[offset + consumed] === 1;
  consumed += 1;
  const days = buffer.readUInt32LE(offset + consumed);
  consumed += 4;
  const hours = buffer[offset + consumed];
  consumed += 1;
  const minutes = buffer[offset + consumed];
  consumed += 1;
  const seconds = buffer[offset + consumed];
  consumed += 1;

  let microseconds = 0;
  if (length > 8) {
    microseconds = buffer.readUInt32LE(offset + consumed);
    consumed += 4;
  }

  const totalHours = days * 24 + hours;
  let result = `${padNumber(totalHours, 2)}:${padNumber(minutes, 2)}:${padNumber(seconds, 2)}`;
  if (microseconds > 0) {
    result += `.${padNumber(microseconds, 6)}`;
  }
  if (isNegative) {
    result = `-${result}`;
  }
  return [result, consumed];
}

function parseBinaryParameterValue(buffer, offset, type, unsignedFlag = false) {
  switch (type) {
    case MysqlTypes.NULL:
      return [null, 0];
    case MysqlTypes.TINY:
      return [unsignedFlag ? buffer.readUInt8(offset) : buffer.readInt8(offset), 1];
    case MysqlTypes.SHORT:
      return [unsignedFlag ? buffer.readUInt16LE(offset) : buffer.readInt16LE(offset), 2];
    case MysqlTypes.LONG:
      return [unsignedFlag ? buffer.readUInt32LE(offset) : buffer.readInt32LE(offset), 4];
    case MysqlTypes.LONGLONG: {
      const low = buffer.readUInt32LE(offset);
      const high = buffer.readUInt32LE(offset + 4);
      let value = (BigInt(high) << 32n) | BigInt(low);
      if (!unsignedFlag && (high & 0x80000000)) {
        value -= 1n << 64n;
      }
      return [Number(value), 8];
    }
    case MysqlTypes.FLOAT:
      return [buffer.readFloatLE(offset), 4];
    case MysqlTypes.DOUBLE:
      return [buffer.readDoubleLE(offset), 8];
    case MysqlTypes.TIMESTAMP:
    case MysqlTypes.DATETIME:
    case MysqlTypes.DATE:
    case MysqlTypes.NEWDATE: {
      return parseBinaryDateOrDateTime(buffer, offset, type);
    }
    case MysqlTypes.TIME: {
      return parseBinaryTime(buffer, offset);
    }
    case MysqlTypes.YEAR:
      return [buffer.readUInt8(offset) + 1900, 1];
    case MysqlTypes.JSON:
    case MysqlTypes.DECIMAL:
    case MysqlTypes.NEWDECIMAL:
    case MysqlTypes.VARCHAR:
    case MysqlTypes.STRING:
    case MysqlTypes.VAR_STRING:
    case MysqlTypes.TINY_BLOB:
    case MysqlTypes.MEDIUM_BLOB:
    case MysqlTypes.LONG_BLOB:
    case MysqlTypes.BLOB:
    case MysqlTypes.GEOMETRY:
    case MysqlTypes.BIT: {
      const [length, consumed] = readLengthEncodedInteger(buffer, offset);
      const start = offset + consumed;
      const end = start + length;
      const slice = buffer.subarray(start, end);
      let value = slice.toString("utf8");
      if (
        type === MysqlTypes.TINY_BLOB ||
        type === MysqlTypes.MEDIUM_BLOB ||
        type === MysqlTypes.LONG_BLOB ||
        type === MysqlTypes.BLOB ||
        type === MysqlTypes.GEOMETRY ||
        type === MysqlTypes.BIT
      ) {
        value = Buffer.from(slice);
      } else if (type === MysqlTypes.JSON) {
        value = slice.toString("utf8");
      }
      return [value, consumed + length];
    }
    default: {
      const [length, consumed] = readLengthEncodedInteger(buffer, offset);
      const start = offset + consumed;
      const end = start + length;
      const slice = buffer.subarray(start, end);
      return [slice.toString("utf8"), consumed + length];
    }
  }
}

async function runSelectQuery(databaseName, sql, parameters = []) {
  const entry = getDatabaseEntry(databaseName);
  const normalizedSql = sql.trim().replace(/;+$/g, "");
  const statement = entry.db.prepare(normalizedSql.length > 0 ? normalizedSql : sql);
  const columnsMeta = typeof statement.columns === "function" ? statement.columns() : [];
  const columns = columnsMeta.length > 0 ? columnsMeta.map((column) => column.name) : [];
  const rowsData = statement.all(...parameters);
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

async function runNonSelectQuery(databaseName, sql, parameters = []) {
  const entry = getDatabaseEntry(databaseName);
  const normalizedSql = sql.trim().replace(/;+$/g, "");
  const statement = entry.db.prepare(normalizedSql.length > 0 ? normalizedSql : sql);
  let affectedRows = 0;
  const result = statement.run(...parameters);
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

async function sendResultSet(sequenceStart, connection, columns, rows, meta = {}, options = {}) {
  const packets = [];
  let sequenceId = sequenceStart;
  const binary = options.binary === true;
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
    if (binary) {
      packets.push(buildBinaryRowPacket(sequenceId, row, columns.length));
    } else {
      packets.push(buildRowPacket(sequenceId, row));
    }
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

async function executeSql(sequenceId, connection, sql, parameters = [], options = {}) {
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
      const result = await runSelectQuery(targetDatabase, trimmed, parameters);
      return sendResultSet(sequenceId, connection, result.columns, result.rows, {}, options);
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
      const { affectedRows } = await runNonSelectQuery(targetDatabase, trimmed, parameters);
      return [buildOkPacket(sequenceId, { affectedRows })];
    }

    return [buildErrPacket(sequenceId, { message: "Unsupported query" })];
  } catch (error) {
    return [buildErrPacket(sequenceId, { message: error.message })];
  }
}

async function handleQuery(sequenceId, connection, sql) {
  return executeSql(sequenceId, connection, sql, []);
}

async function handlePreparedStatementPrepare(sequenceId, connection, sql) {
  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    return [buildErrPacket(sequenceId, { message: "Empty statement" })];
  }

  try {
    const statementId = connection.nextStatementId;
    connection.nextStatementId += 1;
    const paramCount = countStatementParameters(trimmed);
    const statement = {
      id: statementId,
      sql: trimmed,
      paramCount,
      paramTypes: paramCount > 0 ? new Array(paramCount).fill(null) : [],
      columnNames: [],
    };
    connection.preparedStatements.set(statementId, statement);

    let numColumns = 0;
    const packets = [];
    let sequence = sequenceId;

    if (paramCount === 0 && /^\s*SELECT/i.test(trimmed)) {
      try {
        const targetDatabase = connection.currentDatabase || "default";
        const result = await runSelectQuery(targetDatabase, trimmed, []);
        statement.columnNames = result.columns;
        numColumns = result.columns.length;
      } catch (error) {
        numColumns = 0;
      }
    }

    packets.push(
      buildStmtPrepareOkPacket(sequence, {
        statementId,
        numColumns,
        numParams: paramCount,
        warnings: 0,
      })
    );
    sequence += 1;

    if (paramCount > 0) {
      for (let index = 0; index < paramCount; index += 1) {
        packets.push(
          buildColumnDefinitionPacket(sequence, {
            schema: connection.currentDatabase || "",
            table: "",
            name: `param${index + 1}`,
          })
        );
        sequence += 1;
      }
      packets.push(buildEofPacket(sequence, {}));
      sequence += 1;
    }

    if (numColumns > 0) {
      const columnNames = statement.columnNames.length > 0
        ? statement.columnNames
        : Array.from({ length: numColumns }, (_, index) => `column${index + 1}`);
      for (const columnName of columnNames) {
        packets.push(
          buildColumnDefinitionPacket(sequence, {
            schema: connection.currentDatabase || "",
            table: "",
            name: columnName,
          })
        );
        sequence += 1;
      }
      packets.push(buildEofPacket(sequence, {}));
    }

    return packets;
  } catch (error) {
    return [buildErrPacket(sequenceId, { message: error.message })];
  }
}

async function handlePreparedStatementExecute(sequenceId, connection, payload) {
  if (payload.length < 5) {
    return [buildErrPacket(sequenceId, { message: "Malformed execute command" })];
  }

  try {
    const statementId = payload.readUInt32LE(1);
    const statement = connection.preparedStatements.get(statementId);
    if (!statement) {
      return [buildErrPacket(sequenceId, { message: `Unknown statement ${statementId}` })];
    }

    const paramCount = statement.paramCount;
    let offset = 5; // command byte already consumed, statement id read
    offset += 1; // flags
    offset += 4; // iteration count

    const values = [];
    if (paramCount > 0) {
      const nullBitmapLength = Math.ceil(paramCount / 8);
      const nullBitmap = payload.subarray(offset, offset + nullBitmapLength);
      offset += nullBitmapLength;

      const newParamsBoundFlag = payload[offset];
      offset += 1;

      if (newParamsBoundFlag) {
        statement.paramTypes = Array.from({ length: paramCount }, () => ({ type: MysqlTypes.VAR_STRING, unsigned: false }));
        for (let index = 0; index < paramCount; index += 1) {
          const type = payload[offset];
          const flags = payload[offset + 1];
          statement.paramTypes[index] = {
            type,
            unsigned: (flags & 0x80) !== 0,
          };
          offset += 2;
        }
      } else if (
        !Array.isArray(statement.paramTypes) ||
        statement.paramTypes.length !== paramCount ||
        statement.paramTypes.some((entry) => !entry || typeof entry.type !== "number")
      ) {
        statement.paramTypes = Array.from({ length: paramCount }, () => ({ type: MysqlTypes.VAR_STRING, unsigned: false }));
      }

      const paramTypes = statement.paramTypes || [];
      for (let index = 0; index < paramCount; index += 1) {
        const bitmapByte = nullBitmap[Math.floor(index / 8)] || 0;
        const isNull = ((bitmapByte >> (index % 8)) & 0x01) === 1;
        if (isNull) {
          values.push(null);
          continue;
        }

        const typeInfo = paramTypes[index] || { type: MysqlTypes.VAR_STRING, unsigned: false };
        const [value, consumed] = parseBinaryParameterValue(payload, offset, typeInfo.type, typeInfo.unsigned);
        offset += consumed;
        values.push(value);
      }
    }

    return executeSql(sequenceId, connection, statement.sql, values, { binary: true });
  } catch (error) {
    return [buildErrPacket(sequenceId, { message: error.message })];
  }
}

function handlePreparedStatementClose(connection, payload) {
  if (payload.length < 5) {
    return;
  }
  const statementId = payload.readUInt32LE(1);
  connection.preparedStatements.delete(statementId);
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
      preparedStatements: new Map(),
      nextStatementId: 1,
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
    case MYSQL_COMMAND_STMT_PREPARE:
      handlePreparedStatementPrepare(1, connection, sqlString).then((packets) => {
        sendPackets(connection.socket, packets);
      });
      break;
    case MYSQL_COMMAND_STMT_EXECUTE:
      state.queryCount += 1;
      handlePreparedStatementExecute(1, connection, payload).then((packets) => {
        sendPackets(connection.socket, packets);
      });
      break;
    case MYSQL_COMMAND_STMT_CLOSE:
      handlePreparedStatementClose(connection, payload);
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
  const connections = new Set();
  const connectionHandler = createConnectionHandler(serverState);
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => {
      connections.delete(socket);
    });
    connectionHandler(socket);
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, () => {
      console.info(`[mysql-simulator] Listening for MySQL connections on port ${port}`);
      resolve({
        server,
        stop: () =>
          new Promise((stopResolve) => {
            for (const socket of connections) {
              socket.destroy();
            }
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
  const connections = new Set();
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

  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => {
      connections.delete(socket);
    });
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.info(`[mysql-simulator] HTTP metrics server running on port ${port}`);
      resolve({
        server,
        stop: () =>
          new Promise((stopResolve) => {
            for (const socket of connections) {
              socket.destroy();
            }
            server.close(() => stopResolve());
          }),
      });
    });
  });
}

async function start({ port = 4500, mysqlPort = 3307 } = {}) {
  closeDatabases();
  state.queryCount = 0;
  clearDataDirectory();
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
