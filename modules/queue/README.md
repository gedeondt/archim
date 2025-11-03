# Queue Simulator

Queue Simulator implementa una cola en memoria con endpoints HTTP para publicar y consumir mensajes, y expone métricas y un microfrontend de monitoreo.

## Puesta en marcha

Inicie el servicio mediante `start({ port = 4200 })`, que levanta el servidor HTTP.

```js
const { start } = require("./modules/queue");

start({ port: 4200 });
```

## API HTTP

| Método | Ruta | Descripción |
| --- | --- | --- |
| `GET` | `/queues` | Lista todas las colas con sus mensajes pendientes e historial. |
| `POST` | `/queues/{nombre}/messages` | Encola un mensaje JSON `{ "message": ... }`. Devuelve estado y tamaños de cola. |
| `GET` | `/queues/{nombre}/messages` | Extrae todos los mensajes pendientes, vaciando la cola. |
| `GET` | `/metrics` | Retorna el contador global de mensajes procesados. |
| `GET` | `/microfrontends/queue-monitor.js` | Sirve el microfrontend de monitoreo. |

Todas las rutas aceptan CORS (`OPTIONS`). Los mensajes procesados se guardan en `history` para consultas posteriores.

### Ejemplos de uso

```bash
curl -X POST http://localhost:4200/queues/facturacion/messages \
  -H "Content-Type: application/json" \
  -d '{"message":{"id":1,"estado":"pendiente"}}'

curl http://localhost:4200/queues/facturacion/messages
curl http://localhost:4200/metrics
```
