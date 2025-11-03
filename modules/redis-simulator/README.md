# Redis Simulator

Redis Simulator proporciona un servicio HTTP que replica operaciones básicas de Redis (claves KV con TTL, listas y conjuntos) y emite métricas junto a un microfrontend.

## Puesta en marcha

Ejecute `start({ port = 4700 })` para iniciar el servidor HTTP con limpieza periódica de claves expiradas.

```js
const { start } = require("./modules/redis-simulator");

start({ port: 4700 });
```

## API HTTP

| Método | Ruta | Descripción |
| --- | --- | --- |
| `PUT/POST` | `/kv/{clave}` | Guarda un valor JSON `{ "value": ..., "ttlSeconds": opcional }`. |
| `GET` | `/kv/{clave}` | Recupera la clave junto a su fecha de expiración (si existe). |
| `DELETE` | `/kv/{clave}` | Elimina la clave y cancela su expiración. |
| `POST` | `/lists/{clave}/push` | Inserta en la lista (`direction: left/right`, `value`, `ttlSeconds` opcional). |
| `POST` | `/lists/{clave}/pop` | Extrae un elemento de la lista (`direction: left/right`). |
| `GET` | `/lists/{clave}` | Devuelve todos los valores de la lista y el TTL restante. |
| `DELETE` | `/lists/{clave}` | Borra por completo la lista. |
| `POST` | `/sets/{clave}` | Agrega valores (`value` o `values` array) y TTL opcional. |
| `DELETE` | `/sets/{clave}/members/{valor}` | Elimina un miembro específico del set. |
| `GET` | `/sets/{clave}` | Retorna los miembros actuales y expiración. |
| `DELETE` | `/sets/{clave}` | Borra todo el set. |
| `GET` | `/metrics` | Métricas generales: conteo por tipo y claves próximas a expirar. |
| `GET` | `/microfrontends/redis-simulator.js` | Entrega el microfrontend de monitoreo. |

Todas las rutas admiten CORS y limpian expiraciones antes de responder.

### Ejemplos de uso

```bash
curl -X POST http://localhost:4700/kv/sesion \
  -H "Content-Type: application/json" \
  -d '{"value":{"usuario":"ana"},"ttlSeconds":30}'

curl -X POST http://localhost:4700/lists/tareas/push \
  -H "Content-Type: application/json" \
  -d '{"value":"pendiente","direction":"right"}'

curl http://localhost:4700/metrics
```
