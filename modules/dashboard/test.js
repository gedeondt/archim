"use strict";

const assert = require("node:assert/strict");

const DEFAULT_BASE_URL = "http://localhost:4300";

function resolveBaseUrl({ baseUrl, port } = {}) {
  if (baseUrl) {
    return baseUrl;
  }
  if (port) {
    return `http://localhost:${port}`;
  }
  return DEFAULT_BASE_URL;
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

  await step("la página principal se sirve correctamente", async () => {
    const response = await fetch(`${serviceBaseUrl}/`);
    assert.equal(response.status, 200, "GET / debe responder 200");
    const html = await response.text();
    assert.ok(html.includes("MicroSim Dashboard"), "El HTML debe contener el título");
    assert.ok(html.includes("/dashboard.js"), "El HTML debe cargar el script principal");
  });

  await step("el bundle de dashboard está disponible", async () => {
    const response = await fetch(`${serviceBaseUrl}/dashboard.js`);
    assert.equal(response.status, 200, "GET /dashboard.js debe responder 200");
    const script = await response.text();
    assert.ok(
      script.includes("bootstrapDashboard"),
      "El script debe exponer bootstrapDashboard",
    );
  });

  await step("la configuración expone widgets válidos", async () => {
    const response = await fetch(`${serviceBaseUrl}/dashboard-config.json`);
    assert.equal(response.status, 200, "GET /dashboard-config.json debe responder 200");
    const config = await response.json();
    assert.ok(Array.isArray(config.widgets), "La configuración debe incluir un array widgets");
    assert.ok(Array.isArray(config.moduleWidgets), "La configuración debe incluir moduleWidgets");
    assert.ok(config.moduleWidgets.length > 0, "Debe existir al menos un widget de módulos");
    const architectureWidgets = Array.isArray(config.architectureWidgets)
      ? config.architectureWidgets
      : [];

    for (const widget of config.moduleWidgets) {
      assert.ok(widget.id, "Cada widget debe tener id");
      assert.ok(widget.title, "Cada widget debe tener title");
      assert.ok(widget.url, "Cada widget debe tener url");
      assert.ok(widget.tagName, "Cada widget debe tener tagName");
    }

    for (const widget of architectureWidgets) {
      assert.ok(widget.id, "Cada widget de arquitectura debe tener id");
      assert.ok(widget.title, "Cada widget de arquitectura debe tener title");
      assert.ok(widget.url, "Cada widget de arquitectura debe tener url");
      assert.ok(widget.tagName, "Cada widget de arquitectura debe tener tagName");
    }
  });

  return { passed, failed, details };
}

module.exports = { run };
