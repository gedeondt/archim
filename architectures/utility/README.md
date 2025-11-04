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
   Tras persistir cada pedido, publica los eventos `crm.customer.created` y `crm.contract.created`
   en las colas `crm-clients` y `crm-contracts` del event log.
4. El dominio de facturación escucha dichas colas a través del BFF `utility-billing-bff`, replica
   los clientes y contratos en su propia base de datos (`billing.customers` y `billing.contracts`) y
   expone endpoints de consulta.
5. El dashboard incorpora cuatro widgets: el formulario ecommerce, el monitor del event log, el
   panel del CRM y el panel de facturación para visualizar la réplica.

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
  - `services/billing-dashboard/bff/index.js`: replica los eventos de CRM hacia la base `billing`
    y ofrece `/api/billing/customers` y `/api/billing/contracts`.
  - `services/billing-dashboard/microfront/BillingDashboard.microfrontend`: panel web para explorar
    la información de facturación.
  - La carpeta `lib/` dentro de la arquitectura contiene utilidades compartidas, como el cliente
    ligero para publicar y leer eventos del log.

## Puesta en marcha manual

1. Ejecuta `node launcher.js --architecture utility` para iniciar los simuladores, aplicar el
   esquema y levantar los servicios.
2. Accede al dashboard en `http://localhost:4300` y localiza los widgets **Utility Ecommerce**,
   **Eventos ecommerce**, **Utility CRM Dashboard** y **Facturación CRM**.
3. Completa el formulario y emite un pedido. Verás el evento en el widget de event log y los datos
   estructurados en la base `crm` del simulador MySQL, así como la réplica en el panel de
   facturación.
