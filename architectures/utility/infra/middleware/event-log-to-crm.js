"use strict";

const mysql = require("mysql2/promise");
const { createEventLogClient } = require("../../../../lib/utility/event-log-client");

function ensureOrderPayload(eventEntry) {
  if (!eventEntry || typeof eventEntry !== "object") {
    return null;
  }
  const payload = eventEntry.event || eventEntry.order || null;
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (payload.order && typeof payload.order === "object") {
    return payload.order;
  }
  return payload;
}

function sanitizeText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

async function getFirstRow(connection, query, params) {
  const [rows] = await connection.execute(query, params);
  if (Array.isArray(rows) && rows.length > 0) {
    return rows[0];
  }
  return null;
}

function parseId(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : null;
  }
  if (typeof value === "string") {
    if (value === "") {
      return null;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function mapCustomerRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: parseId(row.id),
    firstName: sanitizeText(row.first_name),
    lastName: sanitizeText(row.last_name),
    dni: sanitizeText(row.dni),
    createdAt: row.created_at || null,
  };
}

function mapSupplyPointRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: parseId(row.id),
    customerId: parseId(row.customer_id),
    address: sanitizeText(row.address),
    cups: sanitizeText(row.cups),
    createdAt: row.created_at || null,
  };
}

function mapContractRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: parseId(row.id),
    supplyPointId: parseId(row.supply_point_id),
    orderId: row.order_id || null,
    tariffCode: sanitizeText(row.tariff_code),
    tariffName: sanitizeText(row.tariff_name),
    status: sanitizeText(row.status),
    recordedAt: row.recorded_at || null,
    rawPayload: row.raw_payload || null,
  };
}

async function fetchCustomerById(connection, customerId) {
  if (!customerId) {
    return null;
  }
  const row = await getFirstRow(
    connection,
    "SELECT id, first_name, last_name, dni, created_at FROM customers WHERE id = ? LIMIT 1",
    [customerId]
  );
  return mapCustomerRow(row);
}

async function fetchSupplyPointById(connection, supplyPointId) {
  if (!supplyPointId) {
    return null;
  }
  const row = await getFirstRow(
    connection,
    "SELECT id, customer_id, address, cups, created_at FROM supply_points WHERE id = ? LIMIT 1",
    [supplyPointId]
  );
  return mapSupplyPointRow(row);
}

async function fetchContractById(connection, contractId) {
  if (!contractId) {
    return null;
  }
  const row = await getFirstRow(
    connection,
    `SELECT id, supply_point_id, order_id, tariff_code, tariff_name, status, recorded_at, raw_payload
     FROM contracts WHERE id = ? LIMIT 1`,
    [contractId]
  );
  return mapContractRow(row);
}

async function ensureCustomer(connection, customer, createdAt) {
  const firstName = sanitizeText(customer.firstName);
  const lastName = sanitizeText(customer.lastName);
  const dni = sanitizeText(customer.dni);

  if (dni) {
    console.debug(
      `[event-log-to-crm] Buscando cliente por DNI`,
      { dni, firstName, lastName, createdAt }
    );
    const existing = await getFirstRow(connection, "SELECT id FROM customers WHERE dni = ? LIMIT 1", [dni]);
    const existingId = existing ? parseId(existing.id) : null;
    if (existingId) {
      console.debug("[event-log-to-crm] Cliente encontrado por DNI", { id: existingId, dni });
      return existingId;
    }
  }

  console.debug("[event-log-to-crm] Insertando nuevo cliente", {
    firstName,
    lastName,
    dni,
    createdAt,
  });
  const [result] = await connection.execute(
    "INSERT INTO customers (first_name, last_name, dni, created_at) VALUES (?, ?, ?, ?)",
    [firstName, lastName, dni, createdAt]
  );

  const insertId = result ? parseId(result.insertId) : null;
  if (insertId) {
    console.debug("[event-log-to-crm] Cliente insertado", { id: insertId, dni, firstName, lastName });
    return insertId;
  }

  const fallbackQuery = dni
    ? "SELECT id FROM customers WHERE dni = ? ORDER BY id DESC LIMIT 1"
    : "SELECT id FROM customers WHERE first_name = ? AND last_name = ? AND created_at = ? ORDER BY id DESC LIMIT 1";
  const fallbackParams = dni ? [dni] : [firstName, lastName, createdAt];
  console.debug("[event-log-to-crm] Buscando cliente por fallback", { query: fallbackQuery, params: fallbackParams });
  const fallback = await getFirstRow(connection, fallbackQuery, fallbackParams);
  const fallbackId = fallback ? parseId(fallback.id) : null;
  if (fallbackId) {
    console.debug("[event-log-to-crm] Cliente encontrado por fallback", { id: fallbackId, query: fallbackQuery });
    return fallbackId;
  }

  console.error("[event-log-to-crm] No se pudo determinar el cliente persistido", {
    firstName,
    lastName,
    dni,
    createdAt,
  });
  throw new Error("No se pudo determinar el cliente persistido");
}

async function ensureSupplyPoint(connection, customerId, supplyPoint, createdAt) {
  const address = sanitizeText(supplyPoint.address);
  const cups = sanitizeText(supplyPoint.cups);

  if (cups) {
    const existing = await getFirstRow(
      connection,
      "SELECT id, customer_id, address FROM supply_points WHERE cups = ? LIMIT 1",
      [cups]
    );
    const existingId = existing ? parseId(existing.id) : null;
    if (existingId) {
      const existingCustomerId = existing ? parseId(existing.customer_id) : null;
      const existingAddress = existing ? sanitizeText(existing.address) : "";
      if (existingCustomerId !== customerId || existingAddress !== address) {
        await connection.execute(
          "UPDATE supply_points SET customer_id = ?, address = ?, created_at = ? WHERE id = ?",
          [customerId, address, createdAt, existingId]
        );
      }
      return existingId;
    }
  }

  const [result] = await connection.execute(
    "INSERT INTO supply_points (customer_id, address, cups, created_at) VALUES (?, ?, ?, ?)",
    [customerId, address, cups, createdAt]
  );

  const insertId = result ? parseId(result.insertId) : null;
  if (insertId) {
    return insertId;
  }

  const fallback = await getFirstRow(
    connection,
    "SELECT id FROM supply_points WHERE cups = ? ORDER BY id DESC LIMIT 1",
    [cups]
  );
  const fallbackId = fallback ? parseId(fallback.id) : null;
  if (fallbackId) {
    return fallbackId;
  }

  throw new Error("No se pudo determinar el punto de suministro persistido");
}

async function upsertContract(connection, supplyPointId, order, recordedAt) {
  const contract = order.contract || {};
  const orderId = order.orderId || `order-${Date.now()}`;
  const rawTariffCode = sanitizeText(contract.tariffCode);
  const tariffCode = rawTariffCode || "unknown";
  const tariffName = sanitizeText(contract.tariffName) || rawTariffCode || "Sin nombre";
  const status = sanitizeText(contract.status) || "pending";
  const rawPayload = JSON.stringify(order);

  const existing = await getFirstRow(
    connection,
    "SELECT id FROM contracts WHERE order_id = ? LIMIT 1",
    [orderId]
  );

  const existingId = existing ? parseId(existing.id) : null;
  if (existingId) {
    await connection.execute(
      "UPDATE contracts SET supply_point_id = ?, tariff_code = ?, tariff_name = ?, status = ?, recorded_at = ?, raw_payload = ? WHERE id = ?",
      [supplyPointId, tariffCode, tariffName, status, recordedAt, rawPayload, existingId]
    );
    return fetchContractById(connection, existingId);
  }

  await connection.execute(
    "INSERT INTO contracts (supply_point_id, order_id, tariff_code, tariff_name, status, recorded_at, raw_payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [supplyPointId, orderId, tariffCode, tariffName, status, recordedAt, rawPayload]
  );

  const created = await getFirstRow(
    connection,
    "SELECT id FROM contracts WHERE order_id = ? ORDER BY id DESC LIMIT 1",
    [orderId]
  );
  const createdId = created ? parseId(created.id) : null;
  return fetchContractById(connection, createdId);
}

async function persistOrder(connection, order, recordedAt) {
  const customer = order.customer || {};
  const supplyPoint = order.supplyPoint || {};

  const createdAt = order.createdAt || recordedAt;
  const customerId = await ensureCustomer(connection, customer, createdAt);
  const supplyPointId = await ensureSupplyPoint(connection, customerId, supplyPoint, createdAt);
  const contractRecord = await upsertContract(connection, supplyPointId, order, recordedAt);
  const customerRecord = await fetchCustomerById(connection, customerId);
  const supplyPointRecord = await fetchSupplyPointById(connection, supplyPointId);

  return {
    customer: customerRecord,
    supplyPoint: supplyPointRecord,
    contract: contractRecord,
  };
}

async function publishCrmEvents(eventLogClient, publishQueues, persisted, recordedAt) {
  if (!eventLogClient || !publishQueues) {
    return;
  }

  const tasks = [];
  const customer = persisted.customer;
  const supplyPoint = persisted.supplyPoint;
  const contract = persisted.contract;
  const customerQueue = publishQueues.customerQueue;
  const contractQueue = publishQueues.contractQueue;

  if (customer && customerQueue) {
    const fullName = `${customer.firstName} ${customer.lastName}`.trim();
    const payload = {
      eventType: "crm.customer.created",
      recordedAt,
      source: "crm",
      customer: {
        id: customer.id,
        firstName: customer.firstName,
        lastName: customer.lastName,
        fullName,
        dni: customer.dni,
        createdAt: customer.createdAt,
      },
    };
    tasks.push(
      eventLogClient.publishEvent(customerQueue, payload).catch((error) => {
        console.error(`[event-log-to-crm] Error publicando evento de cliente: ${error.message}`);
      })
    );
  }

  if (contract && contractQueue) {
    const payload = {
      eventType: "crm.contract.created",
      recordedAt,
      source: "crm",
      contract: {
        id: contract.id,
        orderId: contract.orderId,
        tariffCode: contract.tariffCode,
        tariffName: contract.tariffName,
        status: contract.status,
        recordedAt: contract.recordedAt,
        supplyPointId: contract.supplyPointId,
        rawPayload: contract.rawPayload,
      },
      supplyPoint: supplyPoint
        ? {
            id: supplyPoint.id,
            customerId: supplyPoint.customerId,
            address: supplyPoint.address,
            cups: supplyPoint.cups,
            createdAt: supplyPoint.createdAt,
          }
        : null,
      customer: customer
        ? {
            id: customer.id,
            firstName: customer.firstName,
            lastName: customer.lastName,
            dni: customer.dni,
            createdAt: customer.createdAt,
          }
        : null,
    };
    if (supplyPoint && !payload.contract.cups) {
      payload.contract.cups = supplyPoint.cups;
    }
    tasks.push(
      eventLogClient.publishEvent(contractQueue, payload).catch((error) => {
        console.error(`[event-log-to-crm] Error publicando evento de contrato: ${error.message}`);
      })
    );
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
  }
}

async function processEvents(connection, events, state, context = {}) {
  const { eventLogClient, publishQueues } = context;
  for (const entry of events) {
    const recordedAt = entry.recordedAt || state.since;
    const order = ensureOrderPayload(entry);
    if (!order) {
      console.warn("[event-log-to-crm] Evento ignorado por no contener un pedido válido", entry);
      state.lastProcessedAt = new Date(recordedAt);
      continue;
    }

    const recordedTime = new Date(recordedAt);
    if (state.lastProcessedAt && recordedTime.getTime() <= state.lastProcessedAt.getTime()) {
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const persisted = await persistOrder(connection, order, recordedAt);
      await publishCrmEvents(eventLogClient, publishQueues, persisted, recordedAt);
      state.lastProcessedAt = recordedTime;
      console.info(`[event-log-to-crm] Pedido ${order.orderId || "(sin id)"} almacenado en CRM`);
    } catch (error) {
      console.error(`[event-log-to-crm] Error guardando pedido: ${error.message}`);
      if (!state.lastProcessedAt || recordedTime.getTime() > state.lastProcessedAt.getTime()) {
        state.lastProcessedAt = recordedTime;
      }
    }
  }
}

function start(options = {}) {
  const eventLogConfig = options.eventLog || {};
  const mysqlConfig = options.mysql || {};
  const pollIntervalMs = options.pollIntervalMs || 4000;
  const eventLogClient = createEventLogClient(eventLogConfig);
  const publishQueues = eventLogConfig.publishQueues || {};

  let stopped = false;
  let timer = null;
  const state = {
    since: options.startSince || new Date(0).toISOString(),
    lastProcessedAt: options.startSince ? new Date(options.startSince) : null,
  };

  let connectionPromise = mysql
    .createConnection({
      host: mysqlConfig.host || "localhost",
      port: mysqlConfig.port || 3307,
      user: mysqlConfig.user || "root",
      password: mysqlConfig.password || "",
      database: mysqlConfig.database || "crm",
    })
    .then((connection) => {
      console.info("[event-log-to-crm] Conectado a MySQL CRM");
      return connection;
    });

  const scheduleNext = () => {
    if (stopped) {
      return;
    }
    timer = setTimeout(async () => {
      try {
        const connection = await connectionPromise;
        const events = await eventLogClient.fetchEvents(state.since);
        if (events.length > 0) {
          await processEvents(connection, events, state, { eventLogClient, publishQueues });
          if (state.lastProcessedAt) {
            const nextSince = new Date(state.lastProcessedAt.getTime() + 1);
            state.since = nextSince.toISOString();
          }
        }
      } catch (error) {
        console.error(`[event-log-to-crm] Error en ciclo de sondeo: ${error.message}`);
      } finally {
        scheduleNext();
      }
    }, pollIntervalMs);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
  };

  scheduleNext();

  return Promise.resolve({
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
      try {
        const connection = await connectionPromise;
        await connection.end();
      } catch (error) {
        console.error(`[event-log-to-crm] Error cerrando conexión MySQL: ${error.message}`);
      }
    },
  });
}

module.exports = {
  start,
  metadata: {
    name: "event-log-to-crm",
    description:
      "Replica eventos del log 'ecommerce' en el esquema CRM de MySQL y publica eventos CRM para otros dominios",
  },
};
