"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const DEFAULT_MICROFRONT_PATH = path.join(
  __dirname,
  "../microfront/EcommerceForm.microfrontend"
);

const TARIFFS = {
  flex: { code: "flex", name: "Tarifa Flex 2.0TD" },
  night: { code: "night", name: "Tarifa Noche 2.0TD" },
};

let cachedMicrofront = null;

function loadMicrofrontScript(customPath) {
  const scriptPath = customPath || DEFAULT_MICROFRONT_PATH;
  if (!cachedMicrofront || loadMicrofrontScript.lastPath !== scriptPath) {
    cachedMicrofront = fs.readFileSync(scriptPath, "utf8");
    loadMicrofrontScript.lastPath = scriptPath;
  }
  return cachedMicrofront;
}

function readJsonBody(request) {
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
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Payload JSON inválido"));
      }
    });
    request.on("error", reject);
  });
}

function requestJson(method, targetUrl, body) {
  const urlObject = new URL(targetUrl);
  const isHttps = urlObject.protocol === "https:";
  const payload = body !== undefined ? JSON.stringify(body) : null;
  const options = {
    method,
    hostname: urlObject.hostname,
    port: urlObject.port || (isHttps ? 443 : 80),
    path: `${urlObject.pathname}${urlObject.search}`,
    headers: {
      ...(payload
        ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
        : {}),
    },
  };
  const requestFn = isHttps ? https.request : http.request;

  return new Promise((resolve, reject) => {
    const req = requestFn(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        if (!ok) {
          reject(new Error(`${method} ${targetUrl} respondió ${res.statusCode}: ${raw}`));
          return;
        }
        if (!raw) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          resolve(raw);
        }
      });
    });
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function enableCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function handleOptions(response) {
  enableCors(response);
  response.writeHead(204);
  response.end();
}

function sanitizeText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function buildOrderPayload(body) {
  const customer = {
    firstName: sanitizeText(body.firstName),
    lastName: sanitizeText(body.lastName),
    dni: sanitizeText(body.dni),
  };
  const supplyPoint = {
    address: sanitizeText(body.address),
    cups: sanitizeText(body.cups),
  };
  const tariffKey = sanitizeText(body.tariff) || "flex";
  const tariff = TARIFFS[tariffKey];
  if (!tariff) {
    throw new Error("Tarifa seleccionada no es válida");
  }

  if (!customer.firstName || !customer.lastName || !customer.dni) {
    throw new Error("Datos de cliente incompletos");
  }
  if (!supplyPoint.address || !supplyPoint.cups) {
    throw new Error("Datos de punto de suministro incompletos");
  }

  const orderId = `ord_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();

  return {
    orderId,
    createdAt,
    customer,
    supplyPoint,
    contract: {
      tariffCode: tariff.code,
      tariffName: tariff.name,
      status: "pending-activation",
    },
  };
}

async function sendToEventLog(eventLogUrl, order) {
  const payload = {
    type: "ecommerce.order.created",
    source: "utility-ecommerce-bff",
    emittedAt: order.createdAt,
    order,
  };
  await requestJson("POST", eventLogUrl, payload);
}

async function handleOrder(request, response, config) {
  try {
    const body = await readJsonBody(request);
    const order = buildOrderPayload(body);
    await sendToEventLog(config.eventLogUrl, order);
    enableCors(response);
    response.writeHead(202, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        status: "accepted",
        orderId: order.orderId,
        recordedAt: order.createdAt,
      })
    );
  } catch (error) {
    enableCors(response);
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: error.message }));
  }
}

function createServer(config) {
  return http.createServer((request, response) => {
    const { method = "GET", url = "/" } = request;

    if (method === "OPTIONS") {
      handleOptions(response);
      return;
    }

    if (url === "/health") {
      enableCors(response);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (url === "/microfront/ecommerce-form.js" && method === "GET") {
      try {
        const script = loadMicrofrontScript(config.microfrontPath);
        enableCors(response);
        response.writeHead(200, { "Content-Type": "application/javascript" });
        response.end(script);
      } catch (error) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    if (url === "/api/orders" && method === "POST") {
      handleOrder(request, response, config);
      return;
    }

    enableCors(response);
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Not Found" }));
  });
}

async function start(options = {}) {
  if (!options.eventLogUrl) {
    throw new Error("eventLogUrl es obligatorio para el BFF de ecommerce");
  }
  const port = options.port || 5800;
  const server = createServer({
    eventLogUrl: options.eventLogUrl,
    microfrontPath: options.microfrontPath,
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, () => {
      console.info(`[utility:bff] Escuchando en el puerto ${port}`);
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
  });
}

module.exports = {
  start,
  metadata: {
    name: "utility-ecommerce-bff",
    description: "BFF que recibe pedidos y los publica en el event log 'ecommerce'",
  },
};
