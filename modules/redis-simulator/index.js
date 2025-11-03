"use strict";

const http = require("node:http");
const url = require("node:url");
const fs = require("node:fs");
const path = require("node:path");

const MICROFRONTEND_FILE = path.join(__dirname, "redis-simulator.microfrontend");
const EXPIRING_SOON_THRESHOLD_MS = 5000;
const CLEANUP_INTERVAL_MS = 1000;

const state = {
  kv: new Map(),
  lists: new Map(),
  sets: new Map(),
  expirations: new Map(),
  cleanupTimer: null,
};

let cachedMicrofrontend = null;

function readMicrofrontend() {
  if (cachedMicrofrontend === null) {
    cachedMicrofrontend = fs.readFileSync(MICROFRONTEND_FILE, "utf8");
  }
  return cachedMicrofrontend;
}

function compositeKey(type, key) {
  return `${type}:${key}`;
}

function scheduleCleanup() {
  if (state.cleanupTimer) {
    clearInterval(state.cleanupTimer);
  }
  state.cleanupTimer = setInterval(() => {
    try {
      cleanupExpired();
    } catch (error) {
      console.error(`[redis-simulator] Cleanup error: ${error.message}`);
    }
  }, CLEANUP_INTERVAL_MS);
  if (state.cleanupTimer.unref) {
    state.cleanupTimer.unref();
  }
}

function cleanupExpired() {
  const now = Date.now();
  const expiredKeys = [];
  for (const [id, entry] of state.expirations.entries()) {
    if (entry.expiresAt <= now) {
      expiredKeys.push({ type: entry.type, key: entry.key });
      state.expirations.delete(id);
    }
  }
  for (const { type, key } of expiredKeys) {
    switch (type) {
      case "kv":
        state.kv.delete(key);
        break;
      case "list":
        state.lists.delete(key);
        break;
      case "set":
        state.sets.delete(key);
        break;
      default:
        break;
    }
  }
}

function updateExpiration(type, key, ttlSeconds) {
  const id = compositeKey(type, key);
  if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    state.expirations.set(id, { type, key, expiresAt });
  } else {
    state.expirations.delete(id);
  }
}

function ensureKeyIsFresh(type, key) {
  cleanupExpired();
  const id = compositeKey(type, key);
  const expiration = state.expirations.get(id);
  if (expiration && expiration.expiresAt <= Date.now()) {
    updateExpiration(type, key, undefined);
    switch (type) {
      case "kv":
        state.kv.delete(key);
        break;
      case "list":
        state.lists.delete(key);
        break;
      case "set":
        state.sets.delete(key);
        break;
      default:
        break;
    }
  }
}

function parseJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {
        reject(new Error("Payload demasiado grande"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed);
      } catch (error) {
        reject(new Error("JSON inválido"));
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
  const script = readMicrofrontend();
  response.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(script);
}

function handleOptions(response) {
  response.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  response.end();
}

function handleNotFound(response) {
  sendJson(response, 404, { error: "No encontrado" });
}

function ensureList(key) {
  if (!state.lists.has(key)) {
    state.lists.set(key, []);
  }
  return state.lists.get(key);
}

function ensureSet(key) {
  if (!state.sets.has(key)) {
    state.sets.set(key, new Set());
  }
  return state.sets.get(key);
}

function countExpiringSoon() {
  cleanupExpired();
  const now = Date.now();
  let count = 0;
  for (const entry of state.expirations.values()) {
    if (entry.expiresAt > now && entry.expiresAt - now <= EXPIRING_SOON_THRESHOLD_MS) {
      count += 1;
    }
  }
  return count;
}

function handleMetrics(response) {
  cleanupExpired();
  const payload = {
    totalKeys: state.kv.size + state.lists.size + state.sets.size,
    kvCount: state.kv.size,
    listCount: state.lists.size,
    setCount: state.sets.size,
    expiringSoon: countExpiringSoon(),
    expiringSoonWindowSeconds: EXPIRING_SOON_THRESHOLD_MS / 1000,
  };
  sendJson(response, 200, payload);
}

async function handleSetKv(request, response, key) {
  try {
    const body = await parseJsonBody(request);
    if (!("value" in body)) {
      sendJson(response, 400, { error: "Se requiere el campo 'value'" });
      return;
    }
    state.kv.set(key, body.value);
    updateExpiration("kv", key, body.ttlSeconds);
    sendJson(response, 200, { key, value: body.value, ttlSeconds: body.ttlSeconds || null });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
}

function handleGetKv(response, key) {
  ensureKeyIsFresh("kv", key);
  if (!state.kv.has(key)) {
    handleNotFound(response);
    return;
  }
  const value = state.kv.get(key);
  const expiration = state.expirations.get(compositeKey("kv", key));
  sendJson(response, 200, {
    key,
    value,
    expiresAt: expiration ? new Date(expiration.expiresAt).toISOString() : null,
  });
}

function handleDeleteKv(response, key) {
  state.kv.delete(key);
  state.expirations.delete(compositeKey("kv", key));
  sendJson(response, 200, { removed: true, key });
}

async function handleListPush(request, response, key) {
  try {
    const body = await parseJsonBody(request);
    if (!("value" in body)) {
      sendJson(response, 400, { error: "Se requiere el campo 'value'" });
      return;
    }
    const direction = body.direction === "left" ? "left" : "right";
    const list = ensureList(key);
    if (direction === "left") {
      list.unshift(body.value);
    } else {
      list.push(body.value);
    }
    updateExpiration("list", key, body.ttlSeconds);
    sendJson(response, 200, { key, size: list.length, direction, value: body.value });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
}

async function handleListPop(request, response, key) {
  try {
    const body = await parseJsonBody(request);
    const direction = body.direction === "left" ? "left" : "right";
    ensureKeyIsFresh("list", key);
    const list = state.lists.get(key);
    if (!list || list.length === 0) {
      sendJson(response, 200, { key, value: null, size: 0 });
      return;
    }
    const value = direction === "left" ? list.shift() : list.pop();
    if (list.length === 0) {
      state.lists.delete(key);
      state.expirations.delete(compositeKey("list", key));
    }
    sendJson(response, 200, { key, value, size: list.length });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
}

function handleGetList(response, key) {
  ensureKeyIsFresh("list", key);
  const list = state.lists.get(key);
  if (!list) {
    handleNotFound(response);
    return;
  }
  const expiration = state.expirations.get(compositeKey("list", key));
  sendJson(response, 200, {
    key,
    size: list.length,
    values: list.slice(),
    expiresAt: expiration ? new Date(expiration.expiresAt).toISOString() : null,
  });
}

function handleDeleteList(response, key) {
  state.lists.delete(key);
  state.expirations.delete(compositeKey("list", key));
  sendJson(response, 200, { removed: true, key });
}

async function handleSetAdd(request, response, key) {
  try {
    const body = await parseJsonBody(request);
    const values = Array.isArray(body.values)
      ? body.values
      : body.value !== undefined
      ? [body.value]
      : null;
    if (!values) {
      sendJson(response, 400, { error: "Se requiere 'value' o 'values'" });
      return;
    }
    const set = ensureSet(key);
    let added = 0;
    for (const entry of values) {
      const before = set.size;
      set.add(entry);
      if (set.size > before) {
        added += 1;
      }
    }
    updateExpiration("set", key, body.ttlSeconds);
    sendJson(response, 200, { key, size: set.size, added });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
}

function handleSetRemove(response, key, value) {
  ensureKeyIsFresh("set", key);
  const set = state.sets.get(key);
  if (!set) {
    handleNotFound(response);
    return;
  }
  const removed = set.delete(value);
  if (set.size === 0) {
    state.sets.delete(key);
    state.expirations.delete(compositeKey("set", key));
  }
  sendJson(response, 200, { key, removed });
}

function handleGetSet(response, key) {
  ensureKeyIsFresh("set", key);
  const set = state.sets.get(key);
  if (!set) {
    handleNotFound(response);
    return;
  }
  const expiration = state.expirations.get(compositeKey("set", key));
  sendJson(response, 200, {
    key,
    size: set.size,
    values: Array.from(set.values()),
    expiresAt: expiration ? new Date(expiration.expiresAt).toISOString() : null,
  });
}

function handleDeleteSet(response, key) {
  state.sets.delete(key);
  state.expirations.delete(compositeKey("set", key));
  sendJson(response, 200, { removed: true, key });
}

function routeRequest(request, response) {
  const parsedUrl = url.parse(request.url || "/", true);
  const method = request.method || "GET";

  cleanupExpired();

  if (method === "OPTIONS") {
    handleOptions(response);
    return;
  }

  if (parsedUrl.pathname === "/metrics" && method === "GET") {
    handleMetrics(response);
    return;
  }

  if (parsedUrl.pathname === "/microfrontends/redis-simulator.js" && method === "GET") {
    sendMicrofrontend(response);
    return;
  }

  const kvMatch = parsedUrl.pathname.match(/^\/kv\/([^/]+)$/);
  if (kvMatch) {
    const key = decodeURIComponent(kvMatch[1]);
    if (method === "PUT" || method === "POST") {
      handleSetKv(request, response, key);
      return;
    }
    if (method === "GET") {
      handleGetKv(response, key);
      return;
    }
    if (method === "DELETE") {
      handleDeleteKv(response, key);
      return;
    }
  }

  const listPushMatch = parsedUrl.pathname.match(/^\/lists\/([^/]+)\/push$/);
  if (listPushMatch && method === "POST") {
    const key = decodeURIComponent(listPushMatch[1]);
    handleListPush(request, response, key);
    return;
  }

  const listPopMatch = parsedUrl.pathname.match(/^\/lists\/([^/]+)\/pop$/);
  if (listPopMatch && method === "POST") {
    const key = decodeURIComponent(listPopMatch[1]);
    handleListPop(request, response, key);
    return;
  }

  const listMatch = parsedUrl.pathname.match(/^\/lists\/([^/]+)$/);
  if (listMatch) {
    const key = decodeURIComponent(listMatch[1]);
    if (method === "GET") {
      handleGetList(response, key);
      return;
    }
    if (method === "DELETE") {
      handleDeleteList(response, key);
      return;
    }
  }

  const setMemberMatch = parsedUrl.pathname.match(/^\/sets\/([^/]+)\/members\/(.+)$/);
  if (setMemberMatch) {
    const key = decodeURIComponent(setMemberMatch[1]);
    const member = decodeURIComponent(setMemberMatch[2]);
    if (method === "DELETE") {
      handleSetRemove(response, key, member);
      return;
    }
  }

  const setMatch = parsedUrl.pathname.match(/^\/sets\/([^/]+)$/);
  if (setMatch) {
    const key = decodeURIComponent(setMatch[1]);
    if (method === "POST") {
      handleSetAdd(request, response, key);
      return;
    }
    if (method === "GET") {
      handleGetSet(response, key);
      return;
    }
    if (method === "DELETE") {
      handleDeleteSet(response, key);
      return;
    }
  }

  handleNotFound(response);
}

function start({ port = 4700 } = {}) {
  return new Promise((resolve) => {
    scheduleCleanup();
    const server = http.createServer(routeRequest);
    server.listen(port, () => {
      console.info(`[redis-simulator] Escuchando en el puerto ${port}`);
      resolve({
        server,
        stop: () =>
          new Promise((stopResolve, stopReject) => {
            if (state.cleanupTimer) {
              clearInterval(state.cleanupTimer);
              state.cleanupTimer = null;
            }
            server.close((error) => {
              if (error) {
                stopReject(error);
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
    name: "Redis Simulator",
    description: "Simulación simplificada de Redis con TTL para KV, listas y sets.",
  },
  microfrontend: {
    tagName: "redis-simulator-dashboard",
    url: "/microfrontends/redis-simulator.js",
    props: {
      "metrics-url": "/metrics",
    },
  },
};
