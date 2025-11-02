# MicroSim Architecture Library

MicroSim es una colección de piezas de infraestructura auto-contenidas pensadas para simular
topologías modernas. Este README funciona como una guía viva para que cualquier módulo nuevo
mantenga la misma filosofía y resulte sencillo de mantener.

## Filosofía

- Cada componente debe ser ligero, simple y escrito en JavaScript moderno.
- Usamos siempre la última versión LTS de Node.js y dependemos únicamente de módulos estándar o
  dependencias explícitas en cada pieza.
- Toda pieza debe documentar con claridad sus responsabilidades, entradas y salidas.

## Guía rápida

| Tarea                        | Comando / Archivo                                                        |
| ---------------------------- | ------------------------------------------------------------------------ |
| Instalar dependencias       | `npm install` en la raíz del repositorio                                 |
| Lanzar todos los módulos    | `node launcher.js`                                                        |
| Lanzar módulos concretos    | `node launcher.js --piece ./modules/<nombre>` (múltiple bandera permitida) |
| Ejecutar pruebas            | `node tester.js --piece ./modules/<nombre>@<puerto>`                     |
| Manifest por defecto        | `./modules/manifest.json`                                                |

## Logs y estado

- Los servicios que generan ficheros deben crear carpetas por concepto y, dentro de ellas, por minuto
  (`./logs/<servicio>/<YYYYMMDD-HHMM>`).
- Toda salida operativa debe usar `console.info`, diagnósticos `console.debug` y errores `console.error`;
  no se debe escribir directamente en stdout/stderr sin estos niveles.
- Los servicios son preferentemente stateless salvo por el almacenamiento de logs o simulaciones en
  memoria documentadas.

## Contrato de módulos

Cada módulo dentro de `./modules/<nombre>` debe exportar como mínimo:

```js
module.exports = {
  start,            // async (options) => { server, stop }
  metadata: {
    name,           // Nombre corto mostrado en paneles y logs
    description,    // Descripción humana del propósito del módulo
  },
};
```

- `start(options)` recibe siempre un objeto con al menos `port`. Debe devolver un objeto que exponga
  un método `stop()` que cierre recursos (servidores HTTP, timers, conexiones, etc.).
- Si el módulo provee un micro frontend, exporta el objeto `microfrontend` con `tagName`, `url` y
  `props` opcionales. El tester realizará un smoke test sobre esta metadata.
- Documenta los parámetros adicionales aceptados por `start()` (por ejemplo `widgets`, `metricsUrl`) en
  la cabecera del archivo o en comentarios visibles.

### Estructura sugerida

```
modules/
  <nombre>/
    index.js          # Punto de entrada y contrato del módulo
    test.js           # Pruebas end-to-end ejecutadas por tester.js
    public/           # Activos estáticos (HTML/JS/CSS) si expone UI
    README.md         # (Opcional) Detalles específicos del módulo
```

## Manifests y configuración

- `launcher.js` lee `./modules/manifest.json` cuando no se pasan flags y levanta cada pieza en el puerto
  indicado. Cada entrada del manifest debe incluir `{ "module": "./modules/<nombre>", "port": 4200 }` y,
  opcionalmente, `"options"` para parámetros adicionales de `start()`.
- Para escenarios personalizados, crea un JSON con la misma estructura y ejecútalo con
  `node launcher.js --config ./ruta/escenario.json`.
- Puedes combinar `--config` con múltiples `--piece` para añadir servicios ad-hoc.

## Testing y visualización

- Cada módulo debe incluir `test.js` en su carpeta. Este archivo exporta `async function run({ baseUrl, port })`
  y asume que el servicio ya está levantado con `launcher.js`. Las pruebas deben recorrer los endpoints
  principales y validar el comportamiento observando efectos reales.
- `tester.js` busca automáticamente `test.js` y le pasa el `baseUrl` derivado del puerto configurado. Usa
  `node tester.js --piece ./modules/<nombre>@<puerto>` cuando quieras ejecutar pruebas de forma aislada.
- Exporta siempre un micro frontend cuando la pieza tenga métricas o estado que valga la pena mostrar.
  El micro frontend debe ser un módulo JavaScript consumible via `<script type="module">` o clásico,
  registrar un custom element y exponer atributos bien documentados.
- El módulo `dashboard` agrega todos los micro frontends. Si añades uno nuevo, actualiza su configuración
  (ya sea el manifest o las opciones del dashboard) para que aparezca.

## Eventos y APIs

- Documenta cada endpoint HTTP (ruta, método, parámetros, respuestas, códigos de error) directamente en
  `index.js` o en un README local. Mantén consistencia en rutas: `/metrics` para métricas, `/microfrontends`
  para activos UI y `/api/...` para interacciones de negocio.
- Los eventos entre servicios deben seguir nombres descriptivos (`queue.message.enqueued`,
  `queue.message.processed`). Centraliza constantes cuando sea necesario para evitar divergencias.

## Simulación de fallos

Cada módulo expone (en su README o metadata) cómo parametrizar fallos en la escala 0-3:

- **0**: operación perfecta, sin fallos.
- **1**: fallos leves y ocasionales (p. ej. pérdida mínima de mensajes, latencia ligera).
- **2**: fallos frecuentes (p. ej. pérdida notable de mensajes, latencia significativa).
- **3**: fallos graves (p. ej. desconexiones temporales, indisponibilidad intermitente).

Documenta cómo activar cada nivel (flags en `start()`, variables de entorno, etc.) para que los simuladores
puedan reproducir escenarios fácilmente.

## Ejemplo rápido: módulo Queue Simulator

El módulo `./modules/queue` implementa la cola en memoria y expone un micro frontend de monitorización.
Es un buen punto de referencia para:

- Estructura del servidor HTTP con rutas REST (`/queues/:name/messages`, `/metrics`).
- Pruebas end-to-end en `test.js` que validan la cola real en ejecución.
- Micro frontend accesible en `/microfrontends/queue-monitor.js` que consulta las métricas periódicamente.

## Checklist para nuevos módulos

1. Crea `./modules/<nombre>/index.js` exportando `start`, `metadata` y opcionalmente `microfrontend`.
   Añade `test.js` junto al índice para cubrir los escenarios principales contra el servicio en marcha.
2. Define los logs (`console.info/debug/error`) y crea carpetas de persistencia si las necesitas.
3. Documenta tus endpoints o eventos en comentarios visibles y añade instrucciones de fallo 0-3.
4. Registra tu pieza en `modules/manifest.json` con el puerto deseado y opciones necesarias.
5. Añade tu micro frontend al dashboard (directamente en su configuración o mediante opciones).
6. Ejecuta `node tester.js --piece ./modules/<nombre>@<puerto>` para validar que las pruebas sobre el
   servicio levantado pasan correctamente.

¡Bienvenidos a MicroSim, donde la arquitectura se diseña jugando!
