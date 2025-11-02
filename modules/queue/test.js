"use strict";

const assert = require("node:assert/strict");

const DEFAULT_BASE_URL = "http://localhost:4200";

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
    throw new Error(`Expected JSON response but received: ${text.slice(0, 120)}`);
  }
}

async function run({ baseUrl, port } = {}) {
  const serviceBaseUrl = resolveBaseUrl({ baseUrl, port });
  const details = [];
  let passed = 0;
  let failed = 0;

  async function step(title, fn) {
    try {
      await fn();
      details.push(`✅ ${title}`);
      passed += 1;
    } catch (error) {
      details.push(`❌ ${title}: ${error.message}`);
      failed += 1;
    }
  }

  const metricsUrl = `${serviceBaseUrl}/metrics`;
  const queueName = `tester-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const queueUrl = `${serviceBaseUrl}/queues/${encodeURIComponent(queueName)}/messages`;
  const microfrontendUrl = `${serviceBaseUrl}/microfrontends/queue-monitor.js`;

  let initialMetrics = { processedCount: 0 };

  await step("metrics endpoint responde antes de comenzar", async () => {
    const response = await fetch(metricsUrl);
    assert.equal(response.status, 200, "/metrics debe responder 200");
    initialMetrics = await parseJson(response);
    assert.ok(
      typeof initialMetrics.processedCount === "number",
      "/metrics debe exponer processedCount numérico",
    );
  });

  await step("enqueue de mensajes encola correctamente", async () => {
    const response = await fetch(queueUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { hello: "world" } }),
    });
    assert.equal(response.status, 202, "POST /queues/:name/messages debe devolver 202");
    const body = await parseJson(response);
    assert.equal(body.queue, queueName);
    assert.equal(body.status, "queued");
    assert.equal(body.size, 1);
  });

  await step("lectura de mensajes vacía la cola y entrega payload", async () => {
    const response = await fetch(queueUrl);
    assert.equal(response.status, 200, "GET /queues/:name/messages debe devolver 200");
    const body = await parseJson(response);
    assert.equal(body.queue, queueName);
    assert.ok(Array.isArray(body.messages), "La respuesta debe incluir messages[]");
    assert.equal(body.messages.length, 1, "Debe entregar exactamente un mensaje");
    assert.deepEqual(body.messages[0].message, { hello: "world" });
  });

  await step("las métricas incrementan tras consumir mensajes", async () => {
    const response = await fetch(metricsUrl);
    assert.equal(response.status, 200, "/metrics debe responder 200 tras consumir mensajes");
    const body = await parseJson(response);
    assert.ok(body.processedCount >= initialMetrics.processedCount + 1, "processedCount debe incrementarse");
  });

  await step("el microfrontend está disponible", async () => {
    const response = await fetch(microfrontendUrl);
    assert.equal(response.status, 200, "El microfrontend debe responder 200");
    const script = await response.text();
    assert.ok(
      script.includes("customElements.define"),
      "El script del microfrontend debe registrar un custom element",
    );
  });

  return { passed, failed, details };
}

module.exports = { run };
