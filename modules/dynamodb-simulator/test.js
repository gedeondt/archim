"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_BASE_URL = "http://localhost:4600";
const DATA_DIRECTORY = path.join(__dirname, "data");

function resolveBaseUrl({ baseUrl, port } = {}) {
  if (baseUrl) {
    return baseUrl;
  }
  if (port) {
    return `http://localhost:${port}`;
  }
  return DEFAULT_BASE_URL;
}

function sanitizeCollectionName(name) {
  return (
    String(name || "default")
      .trim()
      .replace(/[^A-Za-z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "default"
  );
}

async function parseJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Se esperaba JSON pero se recibió: ${text.slice(0, 120)}`);
  }
}

async function removeDirectoryIfExists(targetPath) {
  await fs.rm(targetPath, { force: true, recursive: true });
}

async function run({ baseUrl, port } = {}) {
  const serviceBaseUrl = resolveBaseUrl({ baseUrl, port });
  const rawCollectionName = `Colección DynamoDB ${Date.now()} ! prueba`; // incluye espacios y caracteres especiales
  const expectedCollectionName = sanitizeCollectionName(rawCollectionName);
  let collectionName = expectedCollectionName;
  let collectionDirPath = path.join(DATA_DIRECTORY, collectionName);
  const collectionEndpointBase = () =>
    `${serviceBaseUrl}/collections/${encodeURIComponent(collectionName)}/documents`;
  const metricsUrl = `${serviceBaseUrl}/metrics`;
  const microfrontendUrl = `${serviceBaseUrl}/microfrontends/dynamodb-simulator.js`;

  const details = [];
  let passed = 0;
  let failed = 0;
  const createdDocuments = [];

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

  async function cleanup() {
    await removeDirectoryIfExists(collectionDirPath);
  }

  try {
    await step("/metrics responde antes de crear colecciones", async () => {
      const response = await fetch(metricsUrl, { cache: "no-store" });
      assert.equal(response.status, 200, "El endpoint /metrics debe responder 200");
      const body = await parseJson(response);
      assert.ok(typeof body.collectionCount === "number", "collectionCount debe ser numérico");
      assert.ok(typeof body.totalDocuments === "number", "totalDocuments debe ser numérico");
      return `collections=${body.collectionCount}, documentos=${body.totalDocuments}`;
    });

    await step("creación de colección sanitiza el nombre", async () => {
      const response = await fetch(`${serviceBaseUrl}/collections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: rawCollectionName }),
      });
      assert.equal(response.status, 201, "POST /collections debe responder 201");
      const body = await parseJson(response);
      assert.equal(
        body.name,
        expectedCollectionName,
        "El servicio debe sanitizar el nombre de la colección",
      );
      collectionName = body.name;
      collectionDirPath = path.join(DATA_DIRECTORY, collectionName);
      assert.ok(collectionName.length > 0, "El nombre de la colección no debe quedar vacío");
      return collectionName;
    });

    await step("rechaza documentos con payload inválido", async () => {
      const response = await fetch(collectionEndpointBase(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["entrada", "inválida"]),
      });
      assert.equal(response.status, 400, "Debe rechazar payloads que no sean objetos");
    });

    await step("creación de documentos devuelve metadata", async () => {
      const documentsToCreate = [
        { type: "alpha", value: 5 },
        { type: "beta", value: 10 },
        { type: "gamma", value: 15 },
      ];
      for (const payload of documentsToCreate) {
        const response = await fetch(collectionEndpointBase(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        assert.equal(response.status, 201, "POST /collections/:name/documents debe responder 201");
        const body = await parseJson(response);
        assert.equal(body.type, payload.type);
        assert.equal(body.value, payload.value);
        assert.ok(typeof body.id === "string" && body.id.length > 0, "El documento debe tener id");
        assert.ok(body.createdAt, "El documento debe incluir createdAt");
        assert.ok(body.updatedAt, "El documento debe incluir updatedAt");
        createdDocuments.push(body);
      }
      return `ids=${createdDocuments.map((doc) => doc.id).join(",")}`;
    });

    await step("las consultas por rango respetan paginación", async () => {
      assert.ok(createdDocuments.length === 3, "Se esperaban 3 documentos creados");
      const sorted = [...createdDocuments].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      const first = sorted[0];
      const last = sorted[sorted.length - 1];

      const page1Url = new URL(collectionEndpointBase());
      page1Url.searchParams.set("from", first.createdAt);
      page1Url.searchParams.set("to", last.createdAt);
      page1Url.searchParams.set("pageSize", "2");
      const page1Response = await fetch(page1Url, { cache: "no-store" });
      assert.equal(page1Response.status, 200, "La consulta debe responder 200");
      const page1Body = await parseJson(page1Response);
      assert.equal(page1Body.collection, collectionName);
      assert.equal(page1Body.page, 1);
      assert.equal(page1Body.pageSize, 2);
      assert.equal(page1Body.totalDocuments, 3);
      assert.equal(page1Body.totalPages, 2);
      assert.equal(page1Body.documents.length, 2, "La primera página debe tener 2 documentos");
      const page1Ids = new Set(page1Body.documents.map((doc) => doc.id));

      const page2Url = new URL(collectionEndpointBase());
      page2Url.searchParams.set("from", first.createdAt);
      page2Url.searchParams.set("to", last.createdAt);
      page2Url.searchParams.set("page", "2");
      page2Url.searchParams.set("pageSize", "2");
      const page2Response = await fetch(page2Url, { cache: "no-store" });
      assert.equal(page2Response.status, 200, "La segunda página debe responder 200");
      const page2Body = await parseJson(page2Response);
      assert.equal(page2Body.documents.length, 1, "La segunda página debe tener 1 documento");
      assert.ok(page2Body.documents.every((doc) => !page1Ids.has(doc.id)), "Las páginas no deben repetir documentos");
    });

    await step("actualización de documento conserva createdAt y cambia updatedAt", async () => {
      const target = createdDocuments[1];
      const previousUpdatedAt = target.updatedAt;
      const response = await fetch(`${collectionEndpointBase()}/${target.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: 99, extra: "updated" }),
      });
      assert.equal(response.status, 200, "PUT debe responder 200");
      const body = await parseJson(response);
      assert.equal(body.id, target.id);
      assert.equal(body.value, 99);
      assert.equal(body.extra, "updated");
      assert.equal(body.createdAt, target.createdAt, "createdAt no debe cambiar");
      assert.notEqual(body.updatedAt, previousUpdatedAt, "updatedAt debe cambiar tras la actualización");
      createdDocuments[1] = body;
    });

    await step("actualizar documento inexistente responde 404", async () => {
      const response = await fetch(`${collectionEndpointBase()}/no-such-id`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: 1 }),
      });
      assert.equal(response.status, 404, "Actualizar un documento inexistente debe responder 404");
    });

    await step("eliminación de documento lo quita del disco", async () => {
      const target = createdDocuments.pop();
      const response = await fetch(`${collectionEndpointBase()}/${target.id}`, {
        method: "DELETE",
      });
      assert.equal(response.status, 200, "DELETE debe responder 200");
      const body = await parseJson(response);
      assert.deepEqual(body, { id: target.id, deleted: true });
      const filePath = path.join(collectionDirPath, `${target.id}.json`);
      await assert.rejects(() => fs.access(filePath), {
        code: "ENOENT",
      });
    });

    await step("las consultas reflejan el documento eliminado", async () => {
      const response = await fetch(collectionEndpointBase(), { cache: "no-store" });
      assert.equal(response.status, 200, "GET debe responder 200");
      const body = await parseJson(response);
      assert.equal(body.totalDocuments, 2, "Deben quedar 2 documentos tras la eliminación");
      const ids = body.documents.map((doc) => doc.id);
      assert.equal(ids.length, 2);
      const expectedIds = new Set(createdDocuments.map((doc) => doc.id));
      assert.equal(expectedIds.size, 2);
      assert.deepEqual(new Set(ids), expectedIds, "Solo deben permanecer los documentos actualizados");
    });

    await step("las métricas reportan la colección creada", async () => {
      const response = await fetch(metricsUrl, { cache: "no-store" });
      assert.equal(response.status, 200, "/metrics debe responder 200 tras las operaciones");
      const body = await parseJson(response);
      assert.ok(body.collectionCount >= 1, "Debe existir al menos una colección");
      assert.ok(body.totalDocuments >= 2, "totalDocuments debe reflejar los documentos restantes");
      assert.ok(
        body.perCollection && typeof body.perCollection === "object",
        "perCollection debe ser un objeto",
      );
      assert.equal(
        body.perCollection[collectionName],
        2,
        "perCollection debe mostrar la cantidad actualizada de documentos",
      );
      assert.ok(body.generatedAt, "Las métricas deben incluir generatedAt");
    });

    await step("el microfrontend está disponible", async () => {
      const response = await fetch(microfrontendUrl, { cache: "no-store" });
      assert.equal(response.status, 200, "El microfrontend debe responder 200");
      const script = await response.text();
      assert.ok(script.length > 0, "El microfrontend no debe estar vacío");
      assert.ok(
        /dynamodb-simulator-dashboard/.test(script),
        "El script debe incluir el nombre del componente del microfrontend",
      );
      return `tamaño=${script.length}`;
    });
  } finally {
    await cleanup();
  }

  return {
    passed,
    failed,
    details,
  };
}

module.exports = {
  run,
};
