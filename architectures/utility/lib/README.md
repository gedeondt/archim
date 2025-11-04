# Utilidades para arquitecturas Utility

Este directorio contiene piezas compartidas entre los servicios de la arquitectura `utility`.

## `event-log-client.js`

Cliente HTTP ligero para interactuar con el simulador de event log:

- `createEventLogClient(config)` devuelve un objeto con métodos `fetchEvents`, `fetchQueueEvents` y
  `publishEvent`.
- Gestiona la normalización del `endpoint` y serializa los payloads JSON.
- Se utiliza tanto en el middleware `event-log-to-crm` como en el BFF de facturación para evitar
  duplicar lógica de sondeo/publicación.

Importa el módulo de forma relativa según la pieza que lo use, por ejemplo:

- `services/billing-dashboard/bff/index.js`: `require("../../../lib/event-log-client")`.
- `infra/middleware/event-log-to-crm.js`: `require("../../lib/event-log-client")`.
