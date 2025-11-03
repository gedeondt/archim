"use strict";

const assert = require("node:assert/strict");

const DEFAULT_BASE_URL = "http://localhost:4700";

function resolveBaseUrl({ baseUrl, port } = {}) {
  if (baseUrl) {
    return baseUrl;
  }
  if (port) {
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run({ baseUrl, port } = {}) {
  const serviceBaseUrl = resolveBaseUrl({ baseUrl, port });
  const metricsUrl = `${serviceBaseUrl}/metrics`;
  const microfrontendUrl = `${serviceBaseUrl}/microfrontends/redis-simulator.js`;

  const details = [];
  let passed = 0;
  let failed = 0;

  async function step(title, fn) {
    try {
      const detail = await fn();
      if (detail) {
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

  try {
    await step("/metrics responde con conteo inicial", async () => {
      const response = await fetch(metricsUrl, { cache: "no-store" });
      assert.equal(response.status, 200, "El endpoint /metrics debe responder 200");
      const body = await parseJson(response);
      assert.ok(typeof body.totalKeys === "number");
      return `totalKeys=${body.totalKeys}`;
    });

    await step("PUT /kv crea registros con TTL", async () => {
      const key = `alpha-${Date.now()}`;
      const response = await fetch(`${serviceBaseUrl}/kv/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "valor-prueba", ttlSeconds: 1.2 }),
      });
      assert.equal(response.status, 200, "La creación de KV debe responder 200");
      const body = await parseJson(response);
      assert.equal(body.key, key);
      assert.equal(body.value, "valor-prueba");
      const readResponse = await fetch(`${serviceBaseUrl}/kv/${encodeURIComponent(key)}`);
      assert.equal(readResponse.status, 200, "El registro recién creado debe existir");
      return key;
    });

    await step("KV caduca automáticamente", async () => {
      const key = `beta-${Date.now()}`;
      await fetch(`${serviceBaseUrl}/kv/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "temporal", ttlSeconds: 1 }),
      });
      await delay(1500);
      const response = await fetch(`${serviceBaseUrl}/kv/${encodeURIComponent(key)}`);
      assert.equal(response.status, 404, "El registro debe caducar");
    });

    await step("Listas soportan push y pop", async () => {
      const key = `lista-${Date.now()}`;
      const pushRight = await fetch(`${serviceBaseUrl}/lists/${encodeURIComponent(key)}/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "ultimo" }),
      });
      assert.equal(pushRight.status, 200);
      const pushLeft = await fetch(`${serviceBaseUrl}/lists/${encodeURIComponent(key)}/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "primero", direction: "left" }),
      });
      assert.equal(pushLeft.status, 200);
      const listResponse = await fetch(`${serviceBaseUrl}/lists/${encodeURIComponent(key)}`);
      assert.equal(listResponse.status, 200);
      const listBody = await parseJson(listResponse);
      assert.deepEqual(listBody.values, ["primero", "ultimo"], "El orden debe respetar los extremos");
      const popRight = await fetch(`${serviceBaseUrl}/lists/${encodeURIComponent(key)}/pop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction: "right" }),
      });
      assert.equal(popRight.status, 200);
      const popRightBody = await parseJson(popRight);
      assert.equal(popRightBody.value, "ultimo");
      const popLeft = await fetch(`${serviceBaseUrl}/lists/${encodeURIComponent(key)}/pop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction: "left" }),
      });
      const popLeftBody = await parseJson(popLeft);
      assert.equal(popLeftBody.value, "primero");
      return key;
    });

    await step("TTL elimina listas completas", async () => {
      const key = `lista-ttl-${Date.now()}`;
      await fetch(`${serviceBaseUrl}/lists/${encodeURIComponent(key)}/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "temporal", ttlSeconds: 1 }),
      });
      await delay(1500);
      const response = await fetch(`${serviceBaseUrl}/lists/${encodeURIComponent(key)}`);
      assert.equal(response.status, 404, "La lista debe haber caducado");
    });

    await step("Sets mantienen valores únicos", async () => {
      const key = `set-${Date.now()}`;
      const addOne = await fetch(`${serviceBaseUrl}/sets/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: ["a", "b", "a"] }),
      });
      assert.equal(addOne.status, 200);
      const addBody = await parseJson(addOne);
      assert.equal(addBody.size, 2, "El set debe contener valores únicos");
      const removeResponse = await fetch(
        `${serviceBaseUrl}/sets/${encodeURIComponent(key)}/members/${encodeURIComponent("a")}`,
        { method: "DELETE" },
      );
      assert.equal(removeResponse.status, 200);
      const getResponse = await fetch(`${serviceBaseUrl}/sets/${encodeURIComponent(key)}`);
      const getBody = await parseJson(getResponse);
      assert.deepEqual(getBody.values.sort(), ["b"], "El valor restante debe ser 'b'");
      return key;
    });

    await step("TTL limpia sets", async () => {
      const key = `set-ttl-${Date.now()}`;
      await fetch(`${serviceBaseUrl}/sets/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "temporal", ttlSeconds: 1 }),
      });
      await delay(1500);
      const response = await fetch(`${serviceBaseUrl}/sets/${encodeURIComponent(key)}`);
      assert.equal(response.status, 404, "El set debe haber caducado");
    });

    await step("Las métricas informan claves por caducar", async () => {
      const key = `gamma-${Date.now()}`;
      await fetch(`${serviceBaseUrl}/kv/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "corto", ttlSeconds: 3 }),
      });
      const response = await fetch(metricsUrl, { cache: "no-store" });
      const body = await parseJson(response);
      assert.ok(body.expiringSoon >= 1, "Debe haber al menos un registro por caducar");
      return `expiringSoon=${body.expiringSoon}`;
    });

    await step("Microfrontend está disponible", async () => {
      const response = await fetch(microfrontendUrl, { cache: "no-store" });
      assert.equal(response.status, 200, "El microfrontend debe servirse");
      const text = await response.text();
      assert.ok(text.includes("customElements.define"), "El microfrontend debe registrar el custom element");
      return `bytes=${text.length}`;
    });
  } finally {
    return {
      passed,
      failed,
      details,
    };
  }
}

module.exports = { run };
