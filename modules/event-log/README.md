# Event Log Simulator

El Event Log Simulator provee un registro de eventos en memoria que persiste en disco para depuración y genera métricas por cola. Incluye un microfrontend con un web component para visualizar las métricas.

## Puesta en marcha

El módulo exporta `start({ port = 4400, storageDir, failureLevel = 0 })`, que inicia un servidor HTTP y purga el almacenamiento indicado en cada arranque.

```js
const { start } = require("./modules/event-log");

start({ port: 4400 });
```

## API HTTP

| Método | Ruta | Descripción |
| --- | --- | --- |
| `POST` | `/event-log/queues/{nombre}/events` | Almacena un evento JSON asociado a la cola indicada. Devuelve identificador y marca temporal. |
| `GET` | `/event-log/queues/{nombre}/events?since=ISO-8601` | Lista los eventos registrados desde la fecha `since` (incluida). |
| `GET` | `/metrics` | Entrega totales de eventos globales y por cola. |
| `GET` | `/microfrontends/event-log-monitor.js` | Sirve el microfrontend que muestra las métricas. |

### Ejemplos de uso

Registrar eventos y consultarlos:

```bash
curl -X POST http://localhost:4400/event-log/queues/pagos/events \
  -H "Content-Type: application/json" \
  -d '{"tipo":"aprobado","monto":25.5}'

curl "http://localhost:4400/event-log/queues/pagos/events?since=2024-01-01T00:00:00Z"
```

Consultar métricas y embebidos:

```bash
curl http://localhost:4400/metrics
curl http://localhost:4400/microfrontends/event-log-monitor.js
```
