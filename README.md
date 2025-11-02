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

## Eventos y APIs
- Todos los servicios deben documentar sus eventos y APIs.
- Se establece un estándar común de eventos para la comunicación entre servicios.

¡Bienvenidos a MicroSim, donde la arquitectura se diseña jugando!
