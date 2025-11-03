# DynamoDB Simulator

Este servicio simula una base de datos documental estilo DynamoDB, persistiendo cada documento en disco y manteniendo un índice temporal en memoria para búsquedas por rango. También expone un microfrontend para visualizar métricas de las colecciones cargadas.

## Puesta en marcha

El módulo exporta una función `start({ port = 4600 })` que levanta un servidor HTTP en el puerto indicado. Los datos se almacenan en `./data` dentro del módulo y se recargan automáticamente al reiniciar el servicio.

```js
const { start } = require("./modules/dynamodb-simulator");

start({ port: 4600 });
```

## API HTTP

| Método | Ruta | Descripción |
| --- | --- | --- |
| `POST` | `/collections` | Crea una colección persistente. Requiere cuerpo `{ "name": "..." }`. |
| `POST` | `/collections/{collection}/documents` | Inserta un documento JSON en la colección indicada. El servicio asigna `id`, `createdAt` y `updatedAt`. |
| `PUT` | `/collections/{collection}/documents/{id}` | Actualiza un documento existente fusionando los campos enviados. `updatedAt` se regenera. |
| `DELETE` | `/collections/{collection}/documents/{id}` | Elimina el documento de la colección y del disco. |
| `GET` | `/collections/{collection}/documents` | Lista documentos con paginación y filtros `from`, `to` (ISO-8601), `page` y `pageSize`. |
| `GET` | `/metrics` | Devuelve conteos de colecciones y documentos cargados. |
| `GET` | `/microfrontends/dynamodb-simulator.js` | Sirve el microfrontend con las métricas para embebido en dashboards. |

### Ejemplos de uso

Crear una colección y añadir un documento:

```bash
curl -X POST http://localhost:4600/collections \
  -H "Content-Type: application/json" \
  -d '{"name":"ordenes"}'

curl -X POST http://localhost:4600/collections/ordenes/documents \
  -H "Content-Type: application/json" \
  -d '{"cliente":"ACME","total":199.99}'
```

Consultar los documentos creados en un rango temporal con paginación:

```bash
curl "http://localhost:4600/collections/ordenes/documents?from=2024-01-01T00:00:00Z&page=1&pageSize=20"
```

Recuperar métricas agregadas y el microfrontend:

```bash
curl http://localhost:4600/metrics
curl http://localhost:4600/microfrontends/dynamodb-simulator.js
```
