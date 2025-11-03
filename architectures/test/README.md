# Arquitectura de prueba (`test`)

Esta arquitectura recorre todos los simuladores disponibles para validar el flujo extremo a extremo:

1. Un microfront simple expone un botón **Emit** que llama a su BFF.
2. El BFF publica un mensaje en la cola `test` del simulador de colas.
3. Un worker `queue-to-store` vacía la cola, registra el evento y lo persiste en DynamoDB.
4. El worker `dynamodb-to-mysql` resume los documentos almacenados y actualiza métricas en MySQL.
5. El worker `logs-to-redis-s3` lee el registro de eventos, guarda el último procesado en Redis y
   genera un archivo corto con contenido aleatorio en el simulador S3.

## Componentes

- **Infraestructura**: cola, log de eventos, MySQL, DynamoDB, Redis y S3. El dashboard se inicia con
  un widget adicional que carga el microfront del emisor.
- **Inicialización**: crea la base de datos `test_metrics`, prepara la tabla `message_metrics`,
  registra la colección `test-messages` en DynamoDB y verifica que la cola `test` esté accesible.
- **Middleware**:
  - `queue-to-store.js` obtiene mensajes de la cola, los registra en el event log y los almacena en
    DynamoDB.
  - `dynamodb-to-mysql.js` consulta DynamoDB y mantiene un agregado en MySQL con el total procesado
    por `source` y la última fecha recibida.
  - `logs-to-redis-s3.js` monitoriza el event log, actualiza un valor en Redis y sube un archivo a S3
    por cada lote procesado.
- **Servicios**:
  - `services/emitter/bff/index.js` expone `/api/emit` y sirve el microfront.
  - `services/emitter/microfront/EmitButton.microfrontend` define el Web Component del botón.

## Puesta en marcha manual

1. Ejecuta `node launcher.js --architecture test` para levantar todos los módulos, inicializar la
   infraestructura y arrancar los workers y el BFF.
2. Abre el dashboard en `http://localhost:4300` y busca el widget **Test Emitter**.
3. Pulsa **Emit** para generar mensajes automáticos. Observa cómo se actualizan las métricas en los
   simuladores y en la tabla `message_metrics` del MySQL simulator.

## Directorios

- `init/mysql/metrics-schema.sql`: definición de la tabla de métricas.
- `init/dynamodb/messages-table.json`: metadatos de la colección de DynamoDB.
- `infra/queues/test-queue.json`: metadatos de la cola `test`.
- `infra/middleware/*.js`: workers de integración.
- `services/emitter/*`: BFF y microfront.
- `manifest.json`: orquesta todas las fases para el launcher.
