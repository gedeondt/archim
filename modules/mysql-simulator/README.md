# MySQL Simulator

Este módulo levanta dos servidores: una implementación compatible con el protocolo MySQL que usa SQLite como motor subyacente y un servidor HTTP auxiliar con métricas y un microfrontend.

## Puesta en marcha

Use la función `start({ port = 4500, mysqlPort = 3307 })` para levantar ambos servicios. El puerto `mysqlPort` expone el protocolo nativo y `port` sirve las métricas HTTP.

```js
const { start } = require("./modules/mysql-simulator");

start({ port: 4500, mysqlPort: 3307 });
```

## Protocolo MySQL

* Soporta autenticación sin contraseña y negocia capacidades básicas (`CLIENT_PROTOCOL_41`, `CLIENT_PLUGIN_AUTH`, etc.).
* Los comandos implementados son `COM_QUERY`, `COM_INIT_DB`, `COM_PING` y `COM_QUIT`.
* El método `COM_QUERY` permite ejecutar instrucciones `SELECT`, `CREATE DATABASE`, `CREATE`, `INSERT`, `UPDATE` y `DELETE`, delegándolas a una base SQLite por cada base de datos solicitada. Las consultas `SHOW DATABASES`, `SHOW TABLES` y `DESCRIBE <tabla>` también están disponibles.
* Cada conexión mantiene un `currentDatabase` (por defecto `default`). Las bases se almacenan como archivos `.sqlite` en `./data`.

### Ejemplo rápido

```bash
mysql -h 127.0.0.1 -P 3307 -u root -proot --protocol=tcp \
  -e "CREATE DATABASE demo; USE demo; CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items(name) VALUES('foo'); SELECT * FROM items;"
```

## API HTTP

| Método | Ruta | Descripción |
| --- | --- | --- |
| `GET` | `/metrics` | Devuelve `queryCount`, bases detectadas y tablas por base. |
| `GET` | `/microfrontends/mysql-simulator.js` | Sirve el microfrontend de monitoreo. |

El endpoint responde con CORS habilitado y rechaza cualquier otra ruta con 404.

### Ejemplo rápido

```bash
curl http://localhost:4500/metrics
curl http://localhost:4500/microfrontends/mysql-simulator.js
```
