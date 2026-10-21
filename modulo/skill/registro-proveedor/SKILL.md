---
name: registro-proveedor
description: Conocimiento del proceso de registro como proveedor de Periferia IT Group (flujo, estados de campo, reglas RN1-RN5, soportes y reparto agente/humano). Úsalo al procesar solicitudes de registro de clientes en CO, EC, PE, PA o HN.
---
# Proceso: registro de Periferia IT Group como proveedor

## Para qué existe

Los clientes de Periferia (Colombia, Ecuador, Perú, Panamá, Honduras) piden registrarla como proveedor
con un formulario propio: plantilla Excel, formulario PDF o portal web. La información casi siempre
es la misma y vive en el repositorio maestro. El trabajo consiste en transcribir los datos, reunir los
soportes y dejar todo listo para la firma del representante legal. La firma y el envío los decide
siempre un humano.

## Flujo estándar de un caso

1. **Leer la solicitud** (`proveedor_leer_solicitud`): país, cliente, formato de salida, campos pedidos
   por la plantilla y soportes exigidos.
2. **Mapear campos** (`proveedor_mapear_campos`): cada etiqueta de la plantilla se cruza con el glosario
   de sinónimos y con el maestro. Resultado por campo: `lleno`, `faltante` o `requiere_confirmacion`.
3. **Generar el formulario** (`proveedor_generar_formulario`) en el formato del cliente:
   - `xlsx`: cada etiqueta y valor en la hoja y celda exactas de `plantilla-celdas.json`.
   - `pdf`: documento generado con todos los campos, en el orden de `plantilla-campos.json`.
   - `portal`: no se automatiza. Se produce `valores-portal.md` con los valores listos para copiar.
4. **Armar el paquete** (`proveedor_armar_paquete`): formulario, copias de soportes, `checklist.md`
   y `borrador-correo.md` en `out/<caso>/paquete/`.
5. **Pedir confirmación** al usuario. Solo con un "sí" explícito en el mensaje siguiente se ejecuta
   `proveedor_simular_envio`, que únicamente escribe `out/<caso>/ENVIO-SIMULADO.md`.

## Estados de un campo

| Estado | Significado |
|---|---|
| `lleno` | El valor sale del maestro; se reporta la ruta (`ruta`), p. ej. `representante_legal.nombre`. |
| `faltante` | No hay fuente en el maestro. Nunca se inventa; se deja vacío y se reporta. |
| `requiere_confirmacion` | El valor existe pero un humano debe validarlo: confianza del mapeo < 0.8, etiqueta ambigua o regla de país. |

## Reglas de negocio

- **RN1 · Identificador tributario por país.** CO → NIT, EC → RUC, PE → RUC, PA → RUC, HN → RTN.
  Periferia solo tiene NIT colombiano. Si el cliente no es de Colombia, el campo se llena con el NIT
  y queda en `requiere_confirmacion` con la nota "identificador extranjero". Una etiqueta genérica
  ("Identificación tributaria", "Número de identificación fiscal") siempre requiere confirmación y se
  propone el equivalente del país.
- **RN2 · Datos bancarios.** Se llenan solo si la plantilla los pide explícitamente (banco, tipo de
  cuenta, número de cuenta, titular, SWIFT). Nunca aparecen en `borrador-correo.md` ni en el resumen
  del chat.
- **RN3 · Listo para firma.** Un soporte exigido vencido (`vigencia_hasta` anterior a la fecha de
  ejecución) o ausente del repositorio bloquea `listo_para_firma`. Un campo `faltante` no bloquea,
  pero aparece en el checklist para que la analista lo complete a mano.
- **RN4 · Confirmación humana.** Ninguna acción externa (envío, firma, carga a portal) se ejecuta sin
  una confirmación explícita del usuario en el turno inmediatamente anterior.
- **RN5 · Trazabilidad.** Toda ejecución de herramienta deja una línea `{ ts, herramienta, ok, resumen }`
  en `out/log.jsonl` y en `out/<caso>/log.jsonl`.

## Soportes habituales

| Tipo | Qué es | Observación |
|---|---|---|
| `camara_comercio` | Certificado de existencia y representación legal | Vigencia corta (30 días); suele ser el primero en vencer. |
| `rut` | Registro Único Tributario | Sin vencimiento. |
| `certificacion_bancaria` | Certificación de cuenta bancaria | Contiene datos bancarios; va como adjunto, nunca en el cuerpo del correo. |
| `parafiscales` | Aportes parafiscales y seguridad social | Mensual; se renueva con el revisor fiscal. |
| `estados_financieros` | Estados financieros auditados | Anual. |
| `certificado_iso_9001` | Certificación de calidad | Plurianual. |

Todos los soportes de Periferia son emitidos en Colombia. Un cliente extranjero puede exigir apostilla
o un documento equivalente de su país (p. ej. "certificado de cumplimiento tributario" en Ecuador):
si el tipo exigido no existe en el repositorio, queda **ausente** y se le indica a la analista.

## Qué hace el agente y qué hace el humano

| Agente | Humano (analista / representante legal) |
|---|---|
| Lee la solicitud, mapea, genera formulario y paquete. | Completa los campos faltantes. |
| Señala identificadores extranjeros y soportes vencidos o ausentes. | Renueva soportes vencidos y consigue los ausentes. |
| Prepara el borrador de correo y los valores para portales. | Ingresa credenciales y hace clic en "Enviar" en portales. |
| Pide confirmación antes de simular el envío. | Firma el formulario y decide el envío real. |
