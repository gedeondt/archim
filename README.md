# MicroSim Architecture Library

## Filosofía
- Cada componente debe ser ligero, simple y escrito en JavaScript.
- Usaremos siempre la última versión LTS de Node.js.
- Todos los servicios deben instalarse con `npm install` y documentar sus dependencias.

## Logs y Estado
- Los servicios que generan ficheros crearán carpetas por concepto, y dentro de ellas, por minuto.
- Logs se generarán en niveles: info, debug, error, usando pipes estándar.
  
## Configuración y Consistencia
- Los servicios reciben parámetros para configuración (puertos, etc.).
- Todos son preferentemente stateless, salvo sus logs.

## Testing y Visualización
- Cada servicio incluye un script de test y exporta un micro frontend.
- Todos los micro frontends podrán ser embebidos en un panel de control web, mostrando sus datos.

## Estructura de Módulos
- Cada pieza de infraestructura vive en `./modules/<nombre>` para mantener el código agrupado.
- La cola en memoria se encuentra ahora en `./modules/queue` junto a su micro frontend.

## Puesta en Marcha
- Ejecuta `node launcher.js` sin parámetros para arrancar todas las piezas descritas en `./modules/manifest.json`.
- El manifest describe los módulos y puertos usados por defecto; puede personalizarse o complementarse con `--config` o `--piece`.

## Eventos y APIs
- Todos los servicios deben documentar sus eventos y APIs.
- Se establece un estándar común de eventos para la comunicación entre servicios.

## Simulación de Fallos
- Todos los componentes operarán en una escala de errores de 0 a 3.
  - 0: Operación perfecta, sin fallos.
  - 1: Fallos ocasionales leves (por ejemplo, pérdida de pocos mensajes en una cola).
  - 2: Fallos frecuentes (pérdida de muchos mensajes, latencia alta, etc.).
  - 3: Fallos graves (conexiones caídas, indisponibilidad total por momentos).

¡Bienvenidos a MicroSim, donde la arquitectura se diseña jugando!
