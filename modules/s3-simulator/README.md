# S3 Simulator

S3 Simulator reproduce un servicio de almacenamiento tipo S3 con subida multipart, indexación en memoria y métricas accesibles por HTTP, además de un microfrontend embebible.

## Puesta en marcha

Inicie el servicio con `start({ port = 4800 })`. Al arrancar se garantiza el directorio `./data` y se reconstruye el índice de objetos existentes.

```js
const { start } = require("./modules/s3-simulator");

start({ port: 4800 });
```

## API HTTP

| Método | Ruta | Descripción |
| --- | --- | --- |
| `POST` | `/upload` o `/upload/{prefijo}` | Acepta un formulario `multipart/form-data` y guarda el archivo con nombre saneado bajo el prefijo indicado. |
| `GET` | `/list?prefix=&from=&to=` | Lista archivos indexados, filtrando por prefijo y rango de fechas (`from`/`to` en ISO o `YYYY-MM-DD`). |
| `DELETE` | `/file?path=...` | Elimina el archivo indicado del disco y del índice. |
| `GET` | `/metrics` | Devuelve totales de archivos, carpetas y tamaño acumulado. |
| `GET` | `/widget` | Sirve el microfrontend para dashboards. |
| `GET` | `/health` | Respuesta simple para probes. |

Las subidas tienen un límite de 50 MB y el servicio valida que las rutas no salgan del directorio de datos.

### Ejemplos de uso

```bash
curl -X POST http://localhost:4800/upload/logs \
  -F "file=@/ruta/a/archivo.txt"

curl "http://localhost:4800/list?prefix=logs&from=2024-01-01"
curl -X DELETE "http://localhost:4800/file?path=logs/archivo.txt"
curl http://localhost:4800/metrics
```
