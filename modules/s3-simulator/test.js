"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const DEFAULT_BASE_URL = "http://localhost:4800";
const DATA_ROOT = path.join(__dirname, "data");

function resolveBaseUrl({ baseUrl, port } = {}) {
  if (typeof baseUrl === "string" && baseUrl.length > 0) {
    return baseUrl;
  }
  if (typeof port === "number" && Number.isFinite(port)) {
    return `http://localhost:${port}`;
  }
  return DEFAULT_BASE_URL;
}

async function parseJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Se esperaba JSON pero se recibió: ${text.slice(0, 120)}`);
  }
}

function removeTestArtifacts(prefix) {
  try {
    const absolutePrefix = path.join(DATA_ROOT, ...prefix.split("/"));
    if (absolutePrefix.startsWith(DATA_ROOT) && fs.existsSync(absolutePrefix)) {
      fs.rmSync(absolutePrefix, { recursive: true, force: true });
    }
  } catch (error) {
    // Ignorar errores de limpieza: el servicio también eliminará los archivos.
  }
}

async function run({ baseUrl, port } = {}) {
  const serviceBaseUrl = resolveBaseUrl({ baseUrl, port });
  const details = [];
  let passed = 0;
  let failed = 0;

  async function step(title, fn) {
    try {
      const result = await fn();
      if (typeof result === "string" && result.trim().length > 0) {
        details.push(`✅ ${title} (${result.trim()})`);
      } else if (result && typeof result === "object" && result.detail) {
        details.push(`✅ ${title} (${result.detail})`);
      } else {
        details.push(`✅ ${title}`);
      }
      passed += 1;
    } catch (error) {
      failed += 1;
      details.push(`❌ ${title}: ${error.message}`);
    }
  }

  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const uploadPrefix = `tests/${uniqueSuffix}`;
  const fileName = "archivo-prueba.txt";
  const fileContents = Buffer.from("contenido de prueba para s3 simulator", "utf8");
  const uploadUrl = `${serviceBaseUrl}/upload/${uploadPrefix}`;
  const listUrl = `${serviceBaseUrl}/list`;
  const metricsUrl = `${serviceBaseUrl}/metrics`;
  const widgetUrl = `${serviceBaseUrl}/widget`;

  let baselineMetrics = { totalFiles: 0, totalFolders: 0, totalSize: 0 };
  let uploadMetadata = null;
  let metricsAfterUpload = null;

  await step("/metrics expone conteo inicial", async () => {
    const response = await fetch(metricsUrl, { cache: "no-store" });
    assert.equal(response.status, 200, "El endpoint /metrics debe responder 200");
    const body = await parseJson(response);
    assert.equal(body.ok, true, "La respuesta de /metrics debe indicar ok=true");
    assert.ok(body.metrics, "La respuesta de /metrics debe incluir métricas");
    baselineMetrics = body.metrics;
    return `archivos=${baselineMetrics.totalFiles}`;
  });

  await step("POST /upload almacena archivo multipart", async () => {
    const form = new FormData();
    form.append("file", new Blob([fileContents]), fileName);
    const response = await fetch(uploadUrl, {
      method: "POST",
      body: form,
    });
    assert.equal(response.status, 201, "El endpoint /upload debe responder 201 al subir");
    const body = await parseJson(response);
    assert.equal(body.ok, true, "La respuesta de /upload debe indicar ok=true");
    assert.ok(body.file && typeof body.file.path === "string", "La respuesta debe incluir metadatos del archivo");
    uploadMetadata = body.file;
    assert.equal(uploadMetadata.path, `${uploadPrefix}/${fileName}`);
    assert.equal(uploadMetadata.size, fileContents.length);
    return uploadMetadata.path;
  });

  await step("GET /list filtra por prefijo", async () => {
    const response = await fetch(`${listUrl}?prefix=${encodeURIComponent(uploadPrefix)}`);
    assert.equal(response.status, 200, "El endpoint /list debe responder 200");
    const body = await parseJson(response);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.files), "La respuesta de /list debe incluir un array de archivos");
    const match = body.files.find((item) => item.path === uploadMetadata.path);
    assert.ok(match, "El archivo subido debe aparecer en el listado por prefijo");
    assert.equal(match.size, fileContents.length);
    return `${body.files.length} archivos`;
  });

  await step("GET /list permite filtrar por fecha", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const response = await fetch(`${listUrl}?from=${today}&to=${today}`);
    assert.equal(response.status, 200);
    const body = await parseJson(response);
    assert.equal(body.ok, true);
    const match = body.files.find((item) => item.path === uploadMetadata.path);
    assert.ok(match, "El archivo debe aparecer dentro del rango de fechas actual");
  });

  await step("/metrics refleja el archivo cargado", async () => {
    const response = await fetch(metricsUrl, { cache: "no-store" });
    assert.equal(response.status, 200);
    const body = await parseJson(response);
    assert.equal(body.ok, true);
    metricsAfterUpload = body.metrics;
    assert.ok(
      metricsAfterUpload.totalFiles >= baselineMetrics.totalFiles + 1,
      "El total de archivos debe incrementarse al menos en 1",
    );
    assert.ok(
      metricsAfterUpload.totalSize >= baselineMetrics.totalSize + fileContents.length,
      "El tamaño total debe incrementarse",
    );
  });

  await step("El microfrontend se sirve desde /widget", async () => {
    const response = await fetch(widgetUrl, { cache: "no-store" });
    assert.equal(response.status, 200);
    const script = await response.text();
    assert.ok(script.includes("customElements.define"), "El microfrontend debe registrar un custom element");
  });

  await step("DELETE /file elimina el archivo", async () => {
    const response = await fetch(
      `${serviceBaseUrl}/file?path=${encodeURIComponent(uploadMetadata.path)}`,
      { method: "DELETE" },
    );
    assert.equal(response.status, 200, "La eliminación debe responder 200");
    const body = await parseJson(response);
    assert.equal(body.ok, true);
  });

  await step("El listado queda vacío tras borrar", async () => {
    const response = await fetch(`${listUrl}?prefix=${encodeURIComponent(uploadPrefix)}`);
    assert.equal(response.status, 200);
    const body = await parseJson(response);
    assert.equal(body.ok, true);
    const match = body.files.find((item) => item.path === uploadMetadata.path);
    assert.equal(match, undefined, "El archivo eliminado no debe aparecer en el listado");
  });

  await step("/metrics disminuye tras la eliminación", async () => {
    const response = await fetch(metricsUrl, { cache: "no-store" });
    assert.equal(response.status, 200);
    const body = await parseJson(response);
    assert.equal(body.ok, true);
    const metricsAfterDelete = body.metrics;
    assert.ok(
      metricsAfterDelete.totalFiles <= metricsAfterUpload.totalFiles - 1,
      "El total de archivos debe disminuir tras borrar",
    );
  });

  removeTestArtifacts(uploadPrefix);

  return { passed, failed, details };
}

module.exports = { run };
