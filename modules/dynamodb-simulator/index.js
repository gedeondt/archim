"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

const DATA_DIRECTORY = path.join(__dirname, "data");
const MICROFRONTEND_PATH = path.join(
  __dirname,
  "dynamodb-simulator.microfrontend"
);

const DEFAULT_PAGE_SIZE = 10;

const state = {
  collections: new Map(), // name -> { name, dir, documents: Map(id -> object), index: Array<{ id, timestamp }> }
  microfrontendCache: null,
};

function ensureDataDirectory() {
  if (!fs.existsSync(DATA_DIRECTORY)) {
    fs.mkdirSync(DATA_DIRECTORY, { recursive: true });
  }
}

async function resetDataDirectory() {
  try {
    await fs.promises.rm(DATA_DIRECTORY, { recursive: true, force: true });
  } catch (error) {
    console.warn(
      `[dynamodb-simulator] Failed to reset data directory: ${error.message}`
    );
  }
  await fs.promises.mkdir(DATA_DIRECTORY, { recursive: true });
  state.collections.clear();
}

function sanitizeCollectionName(name) {
  return String(name || "default")
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    || "default";
}

async function loadDocumentFile(filePath) {
  const raw = await fs.promises.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.id) {
    parsed.id = path.basename(filePath, path.extname(filePath));
  }
  if (!parsed.createdAt) {
    const stats = await fs.promises.stat(filePath);
    parsed.createdAt = new Date(stats.birthtimeMs || stats.mtimeMs).toISOString();
  }
  if (!parsed.updatedAt) {
    parsed.updatedAt = parsed.createdAt;
  }
  return parsed;
}

async function loadCollectionFromDisk(collectionName) {
  const collectionDir = path.join(DATA_DIRECTORY, collectionName);
  const documents = new Map();
  const index = [];
  const entries = await fs.promises.readdir(collectionDir, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(collectionDir, entry.name);
    try {
      const document = await loadDocumentFile(filePath);
      documents.set(document.id, document);
      const timestamp = Date.parse(document.createdAt);
      index.push({ id: document.id, timestamp: Number.isFinite(timestamp) ? timestamp : 0 });
    } catch (error) {
      console.warn(
        `[dynamodb-simulator] Failed to load document ${entry.name} from ${collectionName}: ${error.message}`
      );
    }
  }

  index.sort((a, b) => a.timestamp - b.timestamp);
  state.collections.set(collectionName, {
    name: collectionName,
    dir: collectionDir,
    documents,
    index,
  });
}

async function loadCollectionsFromDisk() {
  ensureDataDirectory();
  const entries = await fs.promises.readdir(DATA_DIRECTORY, {
    withFileTypes: true,
  });
  state.collections.clear();
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    await loadCollectionFromDisk(entry.name);
  }
}

function getCollection(name) {
  const sanitized = sanitizeCollectionName(name);
  return state.collections.get(sanitized);
}

async function createCollection(name) {
  const sanitized = sanitizeCollectionName(name);
  if (state.collections.has(sanitized)) {
    return state.collections.get(sanitized);
  }
  const dir = path.join(DATA_DIRECTORY, sanitized);
  await fs.promises.mkdir(dir, { recursive: true });
  const collection = {
    name: sanitized,
    dir,
    documents: new Map(),
    index: [],
  };
  state.collections.set(sanitized, collection);
  return collection;
}

function serializeDocument(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

async function persistDocument(collection, document) {
  const filePath = path.join(collection.dir, `${document.id}.json`);
  await fs.promises.writeFile(filePath, serializeDocument(document), "utf8");
}

async function deleteDocumentFile(collection, documentId) {
  const filePath = path.join(collection.dir, `${documentId}.json`);
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function cloneDocument(document) {
  return JSON.parse(JSON.stringify(document));
}

function insertIntoIndex(collection, documentId, createdAt) {
  const timestamp = Number.isFinite(createdAt) ? createdAt : 0;
  const { index } = collection;
  let low = 0;
  let high = index.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (index[mid].timestamp < timestamp) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  index.splice(low, 0, { id: documentId, timestamp });
}

function removeFromIndex(collection, documentId) {
  const { index } = collection;
  const position = index.findIndex((entry) => entry.id === documentId);
  if (position >= 0) {
    index.splice(position, 1);
  }
}

function handleRangeQuery(collection, query) {
  const fromMsRaw = Date.parse(query.from);
  const toMsRaw = Date.parse(query.to);
  const fromMs = Number.isFinite(fromMsRaw) ? fromMsRaw : null;
  const toMs = Number.isFinite(toMsRaw) ? toMsRaw : null;
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.max(parseInt(query.pageSize, 10) || DEFAULT_PAGE_SIZE, 1);

  const { index } = collection;

  let start = 0;
  let end = index.length;

  if (fromMs !== null) {
    let low = 0;
    let high = index.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (index[mid].timestamp < fromMs) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    start = low;
  }

  if (toMs !== null) {
    let low = start;
    let high = index.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (index[mid].timestamp <= toMs) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    end = low;
  }

  const filtered = index.slice(start, end);
  const total = filtered.length;
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  const offset = (page - 1) * pageSize;
  const pageEntries = filtered.slice(offset, offset + pageSize);
  const documents = pageEntries.map((entry) =>
    cloneDocument(collection.documents.get(entry.id))
  );

  return {
    collection: collection.name,
    page,
    pageSize,
    totalDocuments: total,
    totalPages,
    documents,
  };
}

function buildMetrics() {
  const perCollection = {};
  let totalDocuments = 0;
  for (const [name, collection] of state.collections) {
    const count = collection.documents.size;
    perCollection[name] = count;
    totalDocuments += count;
  }
  return {
    collectionCount: state.collections.size,
    totalDocuments,
    perCollection,
    generatedAt: new Date().toISOString(),
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

function handleOptions(request, response) {
  response.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  response.end();
}

async function parseJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new Error("Invalid JSON payload");
  }
}

async function handleCreateCollection(request, response) {
  try {
    const body = await parseJsonBody(request);
    const { name } = body;
    if (!name || typeof name !== "string") {
      sendError(response, 400, "Collection name must be provided as a string");
      return;
    }
    const collection = await createCollection(name);
    sendJson(response, 201, { name: collection.name });
  } catch (error) {
    sendError(response, 500, error.message);
  }
}

async function handleCreateDocument(request, response, collectionName) {
  const collection = getCollection(collectionName);
  if (!collection) {
    sendError(response, 404, `Collection '${collectionName}' not found`);
    return;
  }
  try {
    const body = await parseJsonBody(request);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      sendError(response, 400, "Document payload must be a JSON object");
      return;
    }
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const document = { ...body, id, createdAt, updatedAt: createdAt };
    collection.documents.set(id, document);
    insertIntoIndex(collection, id, Date.parse(createdAt));
    await persistDocument(collection, document);
    sendJson(response, 201, cloneDocument(document));
  } catch (error) {
    sendError(response, 500, error.message);
  }
}

async function handleUpdateDocument(request, response, collectionName, documentId) {
  const collection = getCollection(collectionName);
  if (!collection) {
    sendError(response, 404, `Collection '${collectionName}' not found`);
    return;
  }
  const existing = collection.documents.get(documentId);
  if (!existing) {
    sendError(response, 404, `Document '${documentId}' not found in collection '${collectionName}'`);
    return;
  }
  try {
    const body = await parseJsonBody(request);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      sendError(response, 400, "Document payload must be a JSON object");
      return;
    }
    const updatedAt = new Date().toISOString();
    const document = { ...existing, ...body, id: existing.id, createdAt: existing.createdAt, updatedAt };
    collection.documents.set(documentId, document);
    await persistDocument(collection, document);
    sendJson(response, 200, cloneDocument(document));
  } catch (error) {
    sendError(response, 500, error.message);
  }
}

async function handleDeleteDocument(response, collectionName, documentId) {
  const collection = getCollection(collectionName);
  if (!collection) {
    sendError(response, 404, `Collection '${collectionName}' not found`);
    return;
  }
  if (!collection.documents.has(documentId)) {
    sendError(response, 404, `Document '${documentId}' not found in collection '${collectionName}'`);
    return;
  }
  collection.documents.delete(documentId);
  removeFromIndex(collection, documentId);
  try {
    await deleteDocumentFile(collection, documentId);
    sendJson(response, 200, { id: documentId, deleted: true });
  } catch (error) {
    sendError(response, 500, error.message);
  }
}

async function handleQueryDocuments(response, collectionName, query) {
  const collection = getCollection(collectionName);
  if (!collection) {
    sendError(response, 404, `Collection '${collectionName}' not found`);
    return;
  }
  try {
    const result = handleRangeQuery(collection, query);
    sendJson(response, 200, result);
  } catch (error) {
    sendError(response, 500, error.message);
  }
}

function getMicrofrontendScript() {
  if (state.microfrontendCache === null) {
    state.microfrontendCache = fs.readFileSync(MICROFRONTEND_PATH, "utf8");
  }
  return state.microfrontendCache;
}

function handleRequest(request, response) {
  if (request.method === "OPTIONS") {
    handleOptions(request, response);
    return;
  }

  const url = new URL(request.url, "http://localhost");
  const segments = url.pathname.split("/").filter(Boolean);

  if (request.method === "POST" && url.pathname === "/collections") {
    handleCreateCollection(request, response);
    return;
  }

  if (request.method === "POST" && segments.length === 3 && segments[0] === "collections" && segments[2] === "documents") {
    handleCreateDocument(request, response, segments[1]);
    return;
  }

  if (
    request.method === "PUT" &&
    segments.length === 4 &&
    segments[0] === "collections" &&
    segments[2] === "documents"
  ) {
    handleUpdateDocument(request, response, segments[1], segments[3]);
    return;
  }

  if (
    request.method === "DELETE" &&
    segments.length === 4 &&
    segments[0] === "collections" &&
    segments[2] === "documents"
  ) {
    handleDeleteDocument(response, segments[1], segments[3]);
    return;
  }

  if (
    request.method === "GET" &&
    segments.length === 3 &&
    segments[0] === "collections" &&
    segments[2] === "documents"
  ) {
    handleQueryDocuments(response, segments[1], Object.fromEntries(url.searchParams.entries()));
    return;
  }

  if (request.method === "GET" && url.pathname === "/metrics") {
    sendJson(response, 200, buildMetrics());
    return;
  }

  if (request.method === "GET" && url.pathname === "/microfrontends/dynamodb-simulator.js") {
    response.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    response.end(getMicrofrontendScript());
    return;
  }

  response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "Not Found" }));
}

async function start({ port = 4600 } = {}) {
  await resetDataDirectory();
  await loadCollectionsFromDisk();
  const server = http.createServer((request, response) => {
    try {
      handleRequest(request, response);
    } catch (error) {
      console.error(`[dynamodb-simulator] Unexpected error: ${error.message}`);
      sendError(response, 500, "Internal Server Error");
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", (error) => {
      console.error(`[dynamodb-simulator] Server error: ${error.message}`);
      reject(error);
    });

    server.listen(port, () => {
      console.info(`[dynamodb-simulator] Listening on port ${port}`);
      resolve({
        server,
        stop: () =>
          new Promise((stopResolve) => {
            server.close(() => stopResolve());
          }),
      });
    });
  });
}

module.exports = {
  start,
  metadata: {
    name: "DynamoDB Simulator",
    description:
      "Simulates a disk-backed, document-oriented NoSQL database with range queries and exposes monitoring metrics.",
  },
};
