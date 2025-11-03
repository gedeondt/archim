"use strict";

const assert = require("node:assert/strict");

const DEFAULT_BASE_URL = "http://localhost:4400";

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
    throw new Error(`Esperaba JSON pero recibí: ${text.slice(0, 120)}`);
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
      if (result && typeof result === "object" && "detail" in result) {
        details.push(`✅ ${title} (${result.detail})`);
      } else if (typeof result === "string" && result.trim()) {
        details.push(`✅ ${title} (${result.trim()})`);
      } else {
        details.push(`✅ ${title}`);
      }
      passed += 1;
    } catch (error) {
      failed += 1;
      details.push(`❌ ${title}: ${error.message}`);
    }
  }

  const metricsUrl = `${serviceBaseUrl}/metrics`;
  const queueName = `users-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const secondQueueName = `${queueName}-payments`;
  const queueUrl = `${serviceBaseUrl}/event-log/queues/${encodeURIComponent(queueName)}/events`;
  const secondQueueUrl = `${serviceBaseUrl}/event-log/queues/${encodeURIComponent(secondQueueName)}/events`;
  const microfrontendUrl = `${serviceBaseUrl}/microfrontends/event-log-monitor.js`;
  const invalidQueueUrl = `${serviceBaseUrl}/event-log/queues//events`;

  const events = [
    { type: "user.registered", payload: { userId: "abc-1" } },
    { type: "user.updated", payload: { changes: ["email"] } },
  ];

  await step("el endpoint de métricas responde antes de crear eventos", async () => {
    const response = await fetch(metricsUrl);
    assert.equal(response.status, 200, "GET /metrics debe devolver 200");
    const body = await parseJson(response);
    assert.equal(body.totalEvents, 0, "Sin eventos iniciales");
    assert.ok(Array.isArray(body.queues), "La respuesta debe incluir queues[]");
  });

  await step("POST crea eventos en distintas colas", async () => {
    const postResponses = await Promise.all(
      [
        fetch(queueUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(events[0]),
        }),
        fetch(queueUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(events[1]),
        }),
        fetch(secondQueueUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "payment.completed", amount: 42 }),
        }),
      ],
    );

    for (const response of postResponses) {
      assert.equal(response.status, 201, "POST /event-log/.../events debe devolver 201");
      const body = await parseJson(response);
      assert.equal(body.status, "stored");
      assert.ok(typeof body.id === "string" && body.id.length > 0, "La respuesta debe incluir id");
      assert.ok(body.recordedAt, "La respuesta debe incluir recordedAt");
    }
  });

  await step("GET requiere parámetro since", async () => {
    const response = await fetch(queueUrl);
    assert.equal(response.status, 400, "GET sin since debe fallar");
    const body = await parseJson(response);
    assert.ok(body.error.includes("since"));
  });

  const baseline = new Date(Date.now() - 1_000).toISOString();

  await step("GET devuelve eventos sin eliminarlos", async () => {
    const firstResponse = await fetch(`${queueUrl}?since=${encodeURIComponent(baseline)}`);
    assert.equal(firstResponse.status, 200);
    const firstBody = await parseJson(firstResponse);
    assert.equal(firstBody.queue, queueName);
    assert.equal(firstBody.events.length, events.length, "Debe devolver ambos eventos");
    assert.deepEqual(
      firstBody.events.map((entry) => entry.event.type),
      events.map((entry) => entry.type),
    );

    const secondResponse = await fetch(`${queueUrl}?since=${encodeURIComponent(baseline)}`);
    assert.equal(secondResponse.status, 200, "La segunda lectura debe seguir siendo válida");
    const secondBody = await parseJson(secondResponse);
    assert.equal(secondBody.events.length, events.length, "Los eventos no se eliminan tras leerlos");
  });

  await step("GET filtra eventos por fecha", async () => {
    const futureDate = new Date(Date.now() + 60_000).toISOString();
    const response = await fetch(`${queueUrl}?since=${encodeURIComponent(futureDate)}`);
    assert.equal(response.status, 200);
    const body = await parseJson(response);
    assert.equal(body.events.length, 0, "Con fecha futura no hay eventos");
  });

  await step("el endpoint de métricas refleja totales", async () => {
    const response = await fetch(metricsUrl);
    assert.equal(response.status, 200);
    const body = await parseJson(response);
    assert.equal(body.totalEvents, events.length + 1);
    const queues = new Map(body.queues.map((entry) => [entry.name, entry]));
    assert.equal(queues.get(queueName).totalEvents, events.length);
    assert.equal(queues.get(secondQueueName).totalEvents, 1);
  });

  await step("microfrontend se entrega como script", async () => {
    const response = await fetch(microfrontendUrl);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(text.includes("event-log-monitor"));
    assert.ok(text.includes("customElements.define"));
  });

  await step("colas inválidas responden 404", async () => {
    const response = await fetch(invalidQueueUrl);
    assert.equal(response.status, 404);
    const postResponse = await fetch(invalidQueueUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "invalid" }),
    });
    assert.equal(postResponse.status, 404);
  });

  const summary = failed === 0 ? "✅ Todas las pruebas pasaron" : "❌ Algunas pruebas fallaron";

  return {
    passed,
    failed,
    details,
    summary,
  };
}

module.exports = { run };
