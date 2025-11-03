"use strict";

/**
 * S3-like storage simulator module.
 * - Persists uploaded objects to disk under ./data
 * - Keeps an in-memory index rebuilt at startup
 * - Exposes upload, list, delete and metrics HTTP endpoints
 * - Serves a microfrontend web component for dashboards
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const DATA_ROOT = path.join(__dirname, "data");
const MICROFRONTEND_PATH = path.join(__dirname, "s3-simulator.microfrontend");
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB upper bound for multipart payloads

const state = {
  index: new Map(),
  microfrontendCache: null,
};

function ensureDataRoot() {
  if (!fs.existsSync(DATA_ROOT)) {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
  }
}

function normalizeS3Key(input) {
  if (!input) {
    return "";
  }
  return String(input)
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function sanitizeFileName(name) {
  const base = path.basename(name || "file");
  const sanitized = base.replace(/[^A-Za-z0-9._+-]/g, "_");
  return sanitized || "file";
}

function resolveStoragePath(s3Key) {
  const relativeSegments = normalizeS3Key(s3Key).split("/").filter(Boolean);
  const fullPath = path.resolve(DATA_ROOT, ...relativeSegments);
  if (!fullPath.startsWith(path.resolve(DATA_ROOT))) {
    throw new Error("Ruta fuera del directorio permitido");
  }
  return fullPath;
}

function metadataFromStats(s3Key, stats) {
  const timestamp = Number.isFinite(stats.birthtimeMs)
    ? stats.birthtimeMs
    : Number.isFinite(stats.mtimeMs)
    ? stats.mtimeMs
    : Date.now();
  return {
    path: s3Key,
    uploadedAt: new Date(timestamp).toISOString(),
    size: stats.size,
  };
}

async function walkAndIndex(currentDir, prefix = "") {
  const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    const entryKey = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walkAndIndex(entryPath, entryKey);
    } else if (entry.isFile()) {
      const stats = await fs.promises.stat(entryPath);
      state.index.set(entryKey, metadataFromStats(entryKey, stats));
    }
  }
}

async function rebuildIndex() {
  ensureDataRoot();
  state.index.clear();
  await walkAndIndex(DATA_ROOT);
}

function computeMetrics() {
  const files = Array.from(state.index.values());
  const folderSet = new Set();
  let totalSize = 0;
  for (const file of files) {
    totalSize += file.size;
    const lastSlash = file.path.lastIndexOf("/");
    const folder = lastSlash === -1 ? "" : file.path.slice(0, lastSlash);
    if (folder) {
      folderSet.add(folder);
    }
  }
  return {
    totalFiles: files.length,
    totalFolders: folderSet.size,
    totalSize,
  };
}

function readMicrofrontend() {
  if (state.microfrontendCache === null) {
    state.microfrontendCache = fs.readFileSync(MICROFRONTEND_PATH, "utf8");
  }
  return state.microfrontendCache;
}

function parseHeadersBlock(block) {
  const lines = block.split("\r\n");
  const headers = new Map();
  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    headers.set(name, value);
  }
  return headers;
}

function parseContentDisposition(value = "") {
  const [type, ...params] = value.split(";");
  const disposition = {
    type: type ? type.trim().toLowerCase() : "",
    params: {},
  };
  for (const param of params) {
    const [rawKey, rawValue] = param.split("=");
    if (!rawKey || !rawValue) {
      continue;
    }
    const key = rawKey.trim().toLowerCase();
    const cleanedValue = rawValue.trim().replace(/^"|"$/g, "");
    disposition.params[key] = cleanedValue;
  }
  return disposition;
}

function parseMultipartFile(request) {
  return new Promise((resolve, reject) => {
    const contentType = request.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(?:\"?)([^";]+)(?:\"?)/i);
    if (!boundaryMatch) {
      reject(new Error("Multipart boundary no encontrado"));
      return;
    }
    const boundaryId = boundaryMatch[1];
    const boundary = Buffer.from(`--${boundaryId}`);
    const boundaryPrefix = Buffer.from(`\r\n--${boundaryId}`);
    const boundarySuffix = Buffer.from(`\r\n--${boundaryId}--`);
    const headerDelimiter = Buffer.from("\r\n\r\n");

    const chunks = [];
    let totalLength = 0;

    request.on("data", (chunk) => {
      totalLength += chunk.length;
      if (totalLength > MAX_UPLOAD_SIZE) {
        reject(new Error("Archivo demasiado grande"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      try {
        const buffer = Buffer.concat(chunks);
        if (buffer.length === 0) {
          reject(new Error("Contenido multipart vacío"));
          return;
        }
        let position = buffer.indexOf(boundary);
        if (position !== 0) {
          reject(new Error("Formato multipart inválido"));
          return;
        }
        position += boundary.length;
        if (buffer[position] === 13 && buffer[position + 1] === 10) {
          position += 2; // Skip initial CRLF
        }
        while (position < buffer.length) {
          const headerEnd = buffer.indexOf(headerDelimiter, position);
          if (headerEnd === -1) {
            break;
          }
          const headersBlock = buffer.toString("utf8", position, headerEnd);
          const headers = parseHeadersBlock(headersBlock);
          const contentDisposition = parseContentDisposition(headers.get("content-disposition"));
          const dataStart = headerEnd + headerDelimiter.length;
          let nextBoundaryIndex = buffer.indexOf(boundaryPrefix, dataStart);
          let usedSuffix = false;
          if (nextBoundaryIndex === -1) {
            nextBoundaryIndex = buffer.indexOf(boundarySuffix, dataStart);
            if (nextBoundaryIndex !== -1) {
              usedSuffix = true;
            }
          }
          if (nextBoundaryIndex === -1) {
            nextBoundaryIndex = buffer.length;
          }
          let dataEnd = nextBoundaryIndex;
          if (dataEnd >= 2 && buffer[dataEnd - 2] === 13 && buffer[dataEnd - 1] === 10) {
            dataEnd -= 2; // remove trailing CRLF before boundary
          }
          const payload = buffer.subarray(dataStart, dataEnd);
          if (contentDisposition.type === "form-data" && contentDisposition.params.filename) {
            resolve({
              filename: contentDisposition.params.filename,
              contentType: headers.get("content-type") || "application/octet-stream",
              data: Buffer.from(payload),
            });
            return;
          }
          if (usedSuffix) {
            break;
          }
          if (nextBoundaryIndex === buffer.length) {
            break;
          }
          position = nextBoundaryIndex + boundaryPrefix.length;
          if (position >= buffer.length) {
            break;
          }
          if (buffer[position] === 13 && buffer[position + 1] === 10) {
            position += 2;
          }
        }
        reject(new Error("No se encontró archivo en el formulario"));
      } catch (error) {
        reject(error);
      }
    });

    request.on("error", (error) => {
      reject(error);
    });
  });
}

async function handleUpload(request, response, uploadPrefix) {
  try {
    const result = await parseMultipartFile(request);
    const safePrefix = normalizeS3Key(uploadPrefix);
    const safeFileName = sanitizeFileName(result.filename);
    const s3Key = safePrefix ? `${safePrefix}/${safeFileName}` : safeFileName;
    const destinationPath = resolveStoragePath(s3Key);
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.promises.writeFile(destinationPath, result.data);
    const stats = await fs.promises.stat(destinationPath);
    const metadata = metadataFromStats(s3Key, stats);
    state.index.set(s3Key, metadata);
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, file: metadata }));
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, message: error.message }));
  }
}

function parseDateParam(value, endOfDay = false) {
  if (!value) {
    return null;
  }
  const isoString = value.includes("T")
    ? value
    : `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
  const timestamp = Date.parse(isoString);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return timestamp;
}

async function handleList(response, searchParams) {
  const prefix = normalizeS3Key(searchParams.get("prefix") || "");
  const fromTimestamp = parseDateParam(searchParams.get("from"));
  const toTimestamp = parseDateParam(searchParams.get("to"), true);

  const files = Array.from(state.index.values())
    .filter((entry) => {
      if (prefix && !entry.path.startsWith(prefix)) {
        return false;
      }
      const uploadedTime = Date.parse(entry.uploadedAt);
      if (fromTimestamp && Number.isFinite(uploadedTime) && uploadedTime < fromTimestamp) {
        return false;
      }
      if (toTimestamp && Number.isFinite(uploadedTime) && uploadedTime > toTimestamp) {
        return false;
      }
      return true;
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, files }));
}

async function handleDelete(response, filePathParam) {
  const normalized = normalizeS3Key(filePathParam);
  if (!normalized) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, message: "Ruta inválida" }));
    return;
  }
  try {
    const diskPath = resolveStoragePath(normalized);
    await fs.promises.unlink(diskPath);
    state.index.delete(normalized);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  } catch (error) {
    response.writeHead(error.code === "ENOENT" ? 404 : 500, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ ok: false, message: error.code === "ENOENT" ? "Archivo no encontrado" : error.message })
    );
  }
}

function handleMetrics(response) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, metrics: computeMetrics() }));
}

function handleWidget(response) {
  response.writeHead(200, { "content-type": "application/javascript" });
  response.end(readMicrofrontend());
}

function applyCors(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}

async function routeRequest(request, response) {
  applyCors(response);

  const parsedUrl = new URL(request.url, "http://localhost");
  const pathname = parsedUrl.pathname || "/";

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "POST" && (pathname === "/upload" || pathname.startsWith("/upload/"))) {
    const uploadPrefix = pathname.length > "/upload/".length ? pathname.slice("/upload/".length) : "";
    await handleUpload(request, response, uploadPrefix);
    return;
  }

  if (request.method === "GET" && pathname === "/list") {
    await handleList(response, parsedUrl.searchParams);
    return;
  }

  if (request.method === "DELETE" && pathname === "/file") {
    const filePathParam = parsedUrl.searchParams.get("path");
    await handleDelete(response, filePathParam);
    return;
  }

  if (request.method === "GET" && pathname === "/metrics") {
    handleMetrics(response);
    return;
  }

  if (request.method === "GET" && pathname === "/widget") {
    handleWidget(response);
    return;
  }

  if (request.method === "GET" && pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: false, message: "Ruta no encontrada" }));
}

function start({ port = 4800 } = {}) {
  ensureDataRoot();
  return rebuildIndex().then(
    () =>
      new Promise((resolve) => {
        const server = http.createServer((request, response) => {
          Promise.resolve(routeRequest(request, response)).catch((error) => {
            console.error(`[s3-simulator] Error handling request: ${error.message}`);
            response.writeHead(500, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: false, message: "Error interno" }));
          });
        });
        server.listen(port, () => {
          console.info(`[s3-simulator] Listening on port ${port}`);
          resolve({
            server,
            stop: () =>
              new Promise((stopResolve, stopReject) => {
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
      })
  );
}

module.exports = {
  start,
  metadata: {
    name: "S3 Simulator",
    description:
      "Servicio ligero tipo S3 con subida multipart, índice en memoria, listados filtrables y microfrontend de métricas.",
  },
  microfrontend: {
    tagName: "s3-simulator-widget",
    url: "/widget",
    props: {
      "metrics-url": "/metrics",
    },
  },
};
