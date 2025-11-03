# Arquitecturas compuestas

Este documento describe cómo estructurar y documentar arquitecturas completas que reutilizan los
simuladores individuales incluidos en `./modules`. El objetivo es poder desplegar escenarios
funcionales (CRM, ERP, etc.) invocando el `launcher` con un manifiesto que indique la arquitectura
que se desea levantar.

## Ubicación y convención general

- Todas las arquitecturas se definen dentro de `./architectures/<nombre>/`.
- El nombre de la carpeta debe ser corto, en minúsculas y sin espacios (`utility`, `retail`, etc.).
- Cada arquitectura contiene un `manifest.json` que guía al `launcher` por las fases necesarias.
- Los únicos servicios de infraestructura permitidos son los simuladores existentes en `./modules`.
  No se introducen tecnologías adicionales ni dependencias externas.

### Estructura base recomendada

```
architectures/
  <nombre>/
    README.md            # Descripción funcional y supuestos del escenario
    manifest.json        # Pasos y scripts que el launcher ejecutará en orden
    init/
      mysql/             # Esquemas, seeds y datos de arranque para simuladores MySQL
      dynamodb/          # Definición de tablas para el simulador DynamoDB
    infra/
      queues/            # Definiciones de colas soportadas por el simulador correspondiente
      middleware/        # Scripts que coordinan eventos entre módulos
    services/
      <servicio>/
        bff/             # Backend For Frontend del servicio
        microfront/      # Micro frontend asociado
    scripts/             # Utilidades opcionales para orquestar fases manualmente
```

- `manifest.json` expone un arreglo de pasos. Cada paso define `phase` y `script`, además de la
  configuración que se pasará al script (`options`). El `launcher` puede recibir la ruta al
  manifiesto mediante `--config` para activar automáticamente la arquitectura.
- Los artefactos de `init/` describen el estado inicial de los simuladores (bases de datos, colas,
  tablas, etc.).
- `infra/` alberga scripts que actúan como middleware: escuchan eventos, coordinan colas y persisten
  en los simuladores que correspondan.
- `services/` contiene los componentes de experiencia (microfronts) y su BFF asociado. Cada servicio
  puede apoyarse en los módulos definidos en `./modules` para operar.
- `scripts/` ofrece utilidades opcionales (`init.sh`, `start-microfronts.sh`, etc.) que pueden ser
  invocadas por el `manifest.json` o manualmente durante el desarrollo.

### Ejemplo: arquitectura `utility`

```
architectures/
  utility/
    manifest.json
    init/
      mysql/
        crm-schema.sql
        erp-schema.sql
    infra/
      queues/
        crm-to-erp-clients.json
        crm-to-erp-contracts.json
      middleware/
        crm-events-worker.js
        crm-contracts-worker.js
    services/
      crm/
        bff/
        microfront/
      erp/
        bff/
        microfront/
```

- El CRM usa el simulador MySQL para gestionar leads, clientes, contratos e interacciones.
- El ERP también se apoya en el simulador MySQL para persistir su catálogo de clientes y contratos.
- La integración CRM → ERP se realiza mediante dos colas gestionadas por el simulador de colas
  disponible en `./modules`. Los scripts de middleware en `infra/middleware/` procesan los mensajes y
  sincronizan los estados.
- Los microfronts (CRM y ERP) se respaldan en sus respectivos BFFs, que a su vez consumen los
  simuladores (`mysql`, `queue`, etc.) configurados en el `manifest.json`.

### Ejemplo: arquitectura `test`

Arquitectura mínima que ejercita todos los módulos base (`mysql`, `dynamodb`, `queue`, `event-log`,
`redis`, `s3`). Sirve como plantilla de referencia para verificar que los scripts de middleware y los
microfronts puedan orquestarse en cadena. Consulta la carpeta [`architectures/test`](./architectures/test/)
para ver la implementación real.

```
architectures/
  test/
    manifest.json
    README.md
    init/
      mysql/
        metrics-schema.sql          # Tabla `message_metrics` para contar mensajes procesados
      dynamodb/
        messages-table.json         # Definición de tabla `test-messages`
    infra/
      queues/
        test-queue.json             # Cola "test" en el simulador de colas
      middleware/
        queue-to-store.js           # Del BFF (cola) a DynamoDB + event-log
        dynamodb-to-mysql.js        # Resume cuentas en MySQL
        logs-to-redis-s3.js         # Última actualización → Redis + archivo aleatorio en S3
    services/
      emitter/
        bff/
          index.js
        microfront/
          EmitButton.microfrontend
```

- El microfront `EmitButton.microfrontend` muestra un botón **Emit** que invoca al BFF por HTTP. El
  BFF publica el payload en la cola `test` del simulador `./modules/queue`.
- `queue-to-store.js` escucha la cola `test`, registra cada mensaje en el simulador `event-log`
  (archivo/stream propio) y persiste el cuerpo en la tabla `test-messages` de DynamoDB con marca de
  tiempo.
- `dynamodb-to-mysql.js` se ejecuta en intervalos regulares, lee los ítems de DynamoDB y mantiene una
  tabla `message_metrics` en MySQL con el conteo total por `source` y fecha.
- `logs-to-redis-s3.js` procesa los logs generados por `queue-to-store.js`, guarda en Redis la última
  marca de tiempo procesada (`SET test:lastProcessed ...`) y genera un archivo con texto aleatorio en
  el simulador de S3 para cada lote procesado.

#### Manifiesto ilustrativo

```json
{
  "phases": [
    {
      "phase": "initialize",
      "script": "./architectures/test/init/initialize.js",
      "options": {
        "mysql": {
          "schema": "./architectures/test/init/mysql/metrics-schema.sql"
        },
        "dynamodb": {
          "tables": ["./architectures/test/init/dynamodb/messages-table.json"]
        },
        "queue": {
          "definitions": ["./architectures/test/infra/queues/test-queue.json"]
        }
      }
    },
    {
      "phase": "start-infra",
      "script": "./architectures/test/infra/middleware/start.js",
      "options": {
        "workers": [
          "./architectures/test/infra/middleware/queue-to-store.js",
          "./architectures/test/infra/middleware/dynamodb-to-mysql.js",
          "./architectures/test/infra/middleware/logs-to-redis-s3.js"
        ]
      }
    },
    {
      "phase": "start-services",
      "script": "./architectures/test/services/emitter/bff/index.js",
      "options": {
        "port": 5700,
        "queueUrl": "http://localhost:4500/queues/test"
      }
    },
    {
      "phase": "start-microfronts",
      "script": "./architectures/test/services/emitter/microfront/register.js",
      "options": {
        "tagName": "test-emitter",
        "bffUrl": "http://localhost:5700/api/emit"
      }
    }
  ]
}
```

Este manifiesto mantiene el orden recomendado: inicialización de datos, arranque de middleware,
servicios de backend y finalmente UI. Puedes duplicar esta carpeta para crear arquitecturas más
elaboradas reutilizando los mismos módulos base.

## Buenas prácticas específicas

- Mantén toda la lógica de negocio de una arquitectura encapsulada dentro de su carpeta. No se
  comparten librerías ni componentes entre arquitecturas; cualquier reutilización debe hacerse a
  través de los módulos base ubicados en `./modules`.
- No es necesario definir scripts de `teardown`: al reiniciar el `launcher` se destruye el estado
  existente de los simuladores y se puede volver a inicializar desde cero.
- Documenta en `README.md` (dentro de cada arquitectura) las variables, dependencias y flujos para
  que otros desarrolladores puedan comprenderla sin revisar el código.
- Versiona los datos de ejemplo (esquemas SQL, seeds, configuraciones de colas) junto al resto de
  artefactos para que el escenario sea reproducible.

## Uso con el launcher

1. Crea o actualiza `architectures/<nombre>/manifest.json` con los pasos necesarios (`initialize`,
   `start-infra`, `start-services`, `start-microfronts`, etc.).
2. Ejecuta `node launcher.js --config architectures/<nombre>/manifest.json` para inicializar la
   arquitectura.
3. El `launcher` puede seguir recibiendo banderas `--piece` adicionales para añadir módulos puntuales
   sobre la arquitectura seleccionada.

Con esta convención se obtiene una base sólida para crecer en arquitecturas sin perder trazabilidad ni
coherencia con los simuladores existentes.
