"use strict";

const assert = require("node:assert/strict");

function resolveBaseUrl({ baseUrl, port } = {}) {
  if (baseUrl) {
    return baseUrl;
  }
  if (port) {
    return `http://localhost:${port}`;
  }
  return "http://localhost:4500";
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
  const metricsUrl = `${serviceBaseUrl}/metrics`;
  const microfrontendUrl = `${serviceBaseUrl}/microfrontends/mysql-simulator.js`;

  const details = [];
  let passed = 0;
  let failed = 0;

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

  await step("/metrics responde con conteos", async () => {
    const response = await fetch(metricsUrl, { cache: "no-store" });
    assert.equal(response.status, 200, "El endpoint /metrics debe responder 200");
    const body = await parseJson(response);
    assert.ok(typeof body.queryCount === "number", "queryCount debe ser numérico");
    assert.ok(typeof body.databaseCount === "number", "databaseCount debe ser numérico");
    return `queryCount=${body.queryCount}, databaseCount=${body.databaseCount}`;
  });

  await step("microfrontend está disponible", async () => {
    const response = await fetch(microfrontendUrl, { cache: "no-store" });
    assert.equal(response.status, 200, "El microfrontend debe cargarse correctamente");
    const script = await response.text();
    assert.ok(script.includes("mysql-simulator-dashboard"), "El script debe definir el componente web");
    return `tamaño=${script.length}`;
  });

  return {
    passed,
    failed,
    details,
  };
}

module.exports = {
  run,
};
