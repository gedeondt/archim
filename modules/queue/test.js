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
  const queueWithSpaces = `${queueName}-cola con espacios válidos`;
  const queueWithSpacesUrl = `${serviceBaseUrl}/queues/${encodeURIComponent(queueWithSpaces)}/messages`;
  const queuesListingUrl = `${serviceBaseUrl}/queues`;
  const microfrontendUrl = `${serviceBaseUrl}/microfrontends/queue-monitor.js`;
  const invalidQueueUrl = `${serviceBaseUrl}/queues//messages`;

  const expectedPrimaryMessages = [{ hello: "world" }, { hello: "again" }];
  const expectedSecondaryMessage = ["mensaje", 1];
  const totalMessagesConsumed = expectedPrimaryMessages.length + 1;

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

  await step("enqueue de mensajes en múltiples colas", async () => {
    const operations = [
      { url: queueUrl, queue: queueName, payload: expectedPrimaryMessages[0], expectedSize: 1 },
      { url: queueUrl, queue: queueName, payload: expectedPrimaryMessages[1], expectedSize: 2 },
      { url: queueWithSpacesUrl, queue: queueWithSpaces, payload: expectedSecondaryMessage, expectedSize: 1 },
    ];

    for (const { url: targetUrl, queue, payload, expectedSize } of operations) {
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: payload }),
      });
      assert.equal(response.status, 202, `POST ${targetUrl} debe devolver 202`);
      const body = await parseJson(response);
      assert.equal(body.queue, queue);
      assert.equal(body.status, "queued");
      assert.equal(body.size, expectedSize, "La cola debe reportar su tamaño actual");
      assert.ok(
        typeof body.totalMessages === "number" && body.totalMessages >= expectedSize,
        "La respuesta debe incluir totalMessages coherente",
      );
    }
  });

  await step("lectura de mensajes vacía la cola y entrega payload", async () => {
    const response = await fetch(queueUrl);
    assert.equal(response.status, 200, "GET /queues/:name/messages debe devolver 200");
    const body = await parseJson(response);
    assert.equal(body.queue, queueName);
    assert.ok(Array.isArray(body.messages), "La respuesta debe incluir messages[]");
    assert.equal(
      body.messages.length,
      expectedPrimaryMessages.length,
      "Debe entregar exactamente los mensajes encolados",
    );
    assert.deepEqual(
      body.messages.map((entry) => entry.message),
      expectedPrimaryMessages,
      "Los mensajes devueltos deben respetar el orden de inserción",
    );
  });

  await step("lectura de mensajes respeta nombres con espacios", async () => {
    const response = await fetch(queueWithSpacesUrl);
    assert.equal(response.status, 200, "GET /queues/:name/messages debe devolver 200 para colas con espacios");
    const body = await parseJson(response);
    assert.equal(body.queue, queueWithSpaces);
    assert.ok(Array.isArray(body.messages), "La respuesta debe incluir messages[]");
    assert.equal(body.messages.length, 1, "Debe entregar exactamente un mensaje en la cola con espacios");
    assert.deepEqual(body.messages[0].message, expectedSecondaryMessage);
  });

  await step("las métricas incrementan tras consumir mensajes", async () => {
    const response = await fetch(metricsUrl);
    assert.equal(response.status, 200, "/metrics debe responder 200 tras consumir mensajes");
    const body = await parseJson(response);
    assert.ok(
      body.processedCount >= initialMetrics.processedCount + totalMessagesConsumed,
      "processedCount debe incrementarse tras la lectura de mensajes",
    );
  });

  await step("colas inválidas responden 404", async () => {
    const response = await fetch(invalidQueueUrl);
    assert.equal(response.status, 404, "GET /queues//messages debe devolver 404");
    const postResponse = await fetch(invalidQueueUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "invalid" }),
    });
    assert.equal(postResponse.status, 404, "POST /queues//messages debe devolver 404");
  });

  await step("el listado de colas expone nombres y mensajes", async () => {
    const response = await fetch(queuesListingUrl);
    assert.equal(response.status, 200, "GET /queues debe devolver 200");
    const body = await parseJson(response);
    assert.ok(Array.isArray(body.queues), "La respuesta debe incluir queues[]");
    assert.ok(body.queues.length >= 2, "Debe listar al menos las colas utilizadas en la prueba");

    const mainQueueEntry = body.queues.find((entry) => entry.name === queueName);
    assert.ok(mainQueueEntry, "Debe incluir la cola principal en el listado");
    assert.equal(mainQueueEntry.pendingCount, 0, "La cola principal debe quedar vacía tras consumirla");
    assert.equal(
      mainQueueEntry.totalMessages,
      expectedPrimaryMessages.length,
      "La cola principal debe exponer totalMessages consistente",
    );
    assert.deepEqual(
      mainQueueEntry.messages.map((entry) => entry.message),
      expectedPrimaryMessages,
      "El listado debe conservar el historial de mensajes de la cola principal",
    );

    const spacedQueueEntry = body.queues.find((entry) => entry.name === queueWithSpaces);
    assert.ok(spacedQueueEntry, "Debe incluir la cola con espacios");
    assert.equal(spacedQueueEntry.pendingCount, 0, "La cola con espacios debe quedar vacía tras consumirla");
    assert.equal(spacedQueueEntry.messages.length, 1, "El historial debe contener un mensaje");
    assert.deepEqual(spacedQueueEntry.messages[0].message, expectedSecondaryMessage);
  });

  await step("el microfrontend está disponible y muestra colas", async () => {
    const response = await fetch(microfrontendUrl);
    assert.equal(response.status, 200, "El microfrontend debe responder 200");
    const script = await response.text();
    assert.ok(
      script.includes("customElements.define"),
      "El script del microfrontend debe registrar un custom element",
    );
    assert.ok(
      script.includes("queues-url"),
      "El microfrontend debe permitir configurar la URL del listado de colas",
    );
    assert.ok(
      script.includes("Sin colas registradas"),
      "El microfrontend debe renderizar el estado vacío de colas",
    );
    assert.ok(
      script.includes("queue__messages"),
      "El microfrontend debe mostrar la lista de mensajes por cola",
    );
  });

  return { passed, failed, details };
}

module.exports = { run };
