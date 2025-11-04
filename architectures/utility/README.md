# Arquitectura Utility (`utility`)

La arquitectura `utility` modela el alta de contratos eléctricos desde un canal ecommerce muy
ligero. El flujo se apoya en el simulador de event log como bus de eventos y en el simulador de
MySQL como CRM persistente.

## Flujo funcional

1. El microfront **Utility Ecommerce** muestra un formulario con los datos básicos del cliente
   (nombre, apellidos, DNI), del punto de suministro (dirección y CUPS) y un selector de tarifa.
2. Al pulsar **Emitir pedido**, el BFF `utility-ecommerce-bff` valida el payload y genera un evento
   `ecommerce.order.created` en la cola `ecommerce` del event log.
3. El worker `event-log-to-crm` realiza polling periódico sobre los eventos de dicha cola y
   construye el modelo relacional del CRM en MySQL:
   - Tabla `customers`: datos personales.
   - Tabla `supply_points`: dirección y CUPS asociados al cliente.
   - Tabla `contracts`: tarifa seleccionada, estado y payload completo del pedido.
4. El dashboard incorpora dos widgets: el formulario ecommerce y el monitor del event log para
   observar los pedidos registrados.
5. Un tercer widget, **Utility CRM Dashboard**, consulta el CRM mediante su BFF para mostrar
   clientes y contratos con paginación.

## Componentes

- **Infraestructura**: event log y MySQL simulator.
- **Inicialización**: script `init/initialize.js` que aplica el esquema `crm-schema.sql` para crear la
  base de datos `crm` y sus tablas.
- **Middleware**: `infra/middleware/event-log-to-crm.js` lee los eventos `ecommerce` y persiste el
  pedido estructurado en MySQL.
- **Servicios**:
  - `services/ecommerce/bff/index.js`: expone `/api/orders`, publica eventos y sirve el microfront.
  - `services/ecommerce/microfront/EcommerceForm.microfrontend`: web component con el formulario de
    contratación.
  - `services/crm-dashboard/bff/index.js`: expone el microfront de CRM y endpoints paginados para
    `/api/crm/customers` y `/api/crm/contracts`.
  - `services/crm-dashboard/microfront/CrmDashboard.microfrontend`: web component con dos pestañas
    (clientes y contratos) que consumen el BFF.

## Puesta en marcha manual

1. Ejecuta `node launcher.js --architecture utility` para iniciar los simuladores, aplicar el
   esquema y levantar los servicios.
2. Accede al dashboard en `http://localhost:4300` y localiza los widgets **Utility Ecommerce**,
   **Eventos ecommerce** y **Utility CRM Dashboard**.
3. Completa el formulario y emite un pedido. Verás el evento en el widget de event log y los datos
   estructurados en la base `crm` del simulador MySQL.
