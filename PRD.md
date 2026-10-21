# Reto técnico 01 — Agente conversacional "Registro como Proveedor"

> Proceso de selección · Equipo Perxia 2.0 · Periferia IT Group
> Versión 2.0 · 2026-09-03 · Documento entregado al candidato al inicio de la sesión

---

## 0. Ficha del reto

| Elemento | Definición |
|---|---|
| **Duración** | Se comunica al inicio de la sesión. |
| **Reto** | Construir un **agente conversacional completo e independiente** que automatice el llenado de formularios de registro como proveedor: interfaz de chat, backend con el ciclo del agente y sus herramientas, y conexión a un modelo de lenguaje. Debe poder probarse desde un link. |
| **Lenguaje** | TypeScript (Bun o Node 20+) en backend y herramientas. Front libre: React, Svelte, Vue o HTML plano. |
| **Modelo de lenguaje** | El que elijas (Anthropic, OpenAI, Google, Azure, Mistral, local). La clave es tuya. Se lee de variable de entorno y **nunca** aparece en el repositorio, el front ni los logs. |
| **IA permitida** | Cualquier asistente de IA para construir (Claude, ChatGPT, Gemini, Copilot, Cursor, etc.). Debes **declarar cuáles usaste y para qué** en `SOLUCION.md`. Debes poder explicar cada línea que entregas. |
| **Lo que NO recibes** | Código ni acceso a ningún producto de Periferia. El reto es independiente: se resuelve con los fixtures adjuntos y este documento. |
| **Entregable** | Repositorio con la aplicación, link para probarla, `demo.ts` que ejecuta las herramientas sin modelo, y `SOLUCION.md` con el planteamiento de la solución. Ver sección 9. |
| **Bonus** | Hasta +10 puntos si además entregas el agente empaquetado como módulo reutilizable (sección 9.4). |
| **Aprobación** | 70 / 100 puntos según la rúbrica de la sección 10. |

---

## 1. Resumen ejecutivo

El área administrativa de Periferia pierde una persona y debe automatizar lo repetitivo. El proceso con mayor retorno inmediato es el **registro como proveedor ante clientes**: entre 8 y 12 formularios al mes, con información que ya existe en un repositorio interno y que hoy se transcribe a mano en Excel, PDF o portales web.

El reto consiste en construir un agente que, a partir de una solicitud recibida por correo, **identifique los campos pedidos, los llene desde el repositorio maestro, genere el formulario en el formato solicitado y arme el paquete de soportes listo para la firma del representante legal**. El agente nunca firma ni envía: prepara y deja a un humano la decisión final.

---

## 2. Contexto y problema

### 2.1 Situación actual (as-is)

| Dimensión | Hoy |
|---|---|
| Volumen | 8–12 solicitudes al mes. |
| Origen | Correo electrónico de clientes en Colombia, Ecuador, Perú, Panamá y Honduras. Llegan a recepción. |
| Datos | Se repiten casi siempre. Existen en un repositorio interno junto con los soportes: Cámara de Comercio, RUT, certificación bancaria, parafiscales, estados financieros. |
| Variabilidad | El **formato de salida**: plantilla Excel del cliente, formulario PDF, o portal web con usuario y contraseña. |
| Cierre | Firma del representante legal, física o electrónica. |
| Esfuerzo | Transcripción manual campo por campo, búsqueda de soportes, armado del correo de respuesta. |

### 2.2 Dolor que resolvemos

1. **Retrabajo**: la misma información se transcribe cada vez, con riesgo de error en datos sensibles (cuenta bancaria, NIT).
2. **Dependencia de una persona**: el conocimiento de dónde está cada soporte y qué pide cada país no está sistematizado.
3. **Tiempo de respuesta**: un registro puede tardar días por colas de trabajo, lo que retrasa la facturación.

### 2.3 Lo que este reto NO resuelve

- La firma del representante legal (decisión humana).
- El envío del paquete al cliente (decisión humana).
- El llenado de portales web reales (se diseña, no se implementa; ver sección 7.4).

---

## 3. Objetivos y no-objetivos

### 3.1 Objetivos

| # | Objetivo | Métrica de éxito en el reto |
|---|---|---|
| O1 | Reducir la transcripción manual a cero en formatos Excel y PDF. | Los casos `co-industrias-delta`, `ec-corp-andina` y `hn-agroexport-sula` producen un formulario lleno sin intervención humana en los campos que existen en el maestro. |
| O2 | Hacer explícito lo que falta. | Todo campo solicitado que no exista en el maestro queda listado en un reporte de faltantes, nunca inventado. |
| O3 | Preparar el cierre humano. | El agente genera un "paquete para firma" con checklist de soportes y un borrador de correo, y **pide confirmación** antes de cualquier acción externa. |

### 3.2 No-objetivos

- Integración real con correo, SharePoint, firma electrónica o portales de clientes.
- Autenticación de usuarios, roles o multiusuario.
- Persistencia en base de datos. El sistema de archivos local es suficiente.

---

## 4. Usuarios y actores

| Actor | Rol en el flujo | Interacción con el agente |
|---|---|---|
| **Recepción** | Recibe el correo del cliente. | Deposita la solicitud en la carpeta de entrada (fixture). No usa el agente. |
| **Analista administrativa** (usuaria principal) | Prepara el formulario y los soportes. | Conversa con el agente en el chat: "procesa la solicitud X". Revisa faltantes, aprueba el paquete. |
| **Representante legal** (firmante) | Firma el formulario. | Recibe el paquete listo. Nunca interactúa con el agente. |
| **Cliente** | Solicita el registro. | Fuera del sistema. |

---

## 5. Historias de usuario y criterios de aceptación

### HU-1 · Leer la solicitud
**Como** analista, **quiero** que el agente lea el correo del cliente y la plantilla adjunta, **para** saber qué campos y qué soportes me piden sin abrir cada archivo.

Criterios de aceptación:
- Dado `solicitud.json` (correo) y su plantilla (`plantilla-celdas.json` para Excel o `plantilla-campos.json` para PDF), el agente devuelve la lista de campos solicitados, el país del cliente, el formato de salida y la lista de soportes exigidos.
- Si la plantilla tiene campos ambiguos (ej. "Identificación tributaria"), el agente los reporta como `requiere_confirmacion` y propone el equivalente del país (NIT en Colombia, RUC en Ecuador, Perú y Panamá, RTN en Honduras).

### HU-2 · Mapear campos al maestro
**Como** analista, **quiero** que el agente cruce cada campo solicitado con el repositorio maestro, **para** que el llenado sea exacto y trazable.

Criterios de aceptación:
- Cada campo solicitado termina en uno de tres estados: `lleno` (con la ruta del dato en el maestro), `faltante` (no existe en el maestro) o `requiere_confirmacion` (mapeo con confianza < 0.8 o regla de país).
- El agente **nunca** inventa un valor. Un campo sin fuente es `faltante`.
- Los sinónimos del glosario (`fixtures/reto-01/glosario-campos.json`) se resuelven automáticamente.

### HU-3 · Generar el formulario en el formato pedido
**Como** analista, **quiero** obtener el formulario lleno en el mismo formato que envió el cliente, **para** no reformatear nada.

Criterios de aceptación:
- **P0 — Excel**: se produce `out/<caso>/formulario.xlsx` escribiendo cada etiqueta y su valor exactamente en la hoja y celda indicadas por `plantilla-celdas.json`.
- **P1 — PDF**: se produce `out/<caso>/formulario.pdf` a partir de `plantilla-campos.json`. Se acepta un PDF generado (no un AcroForm rellenado) siempre que reproduzca todos los campos con etiqueta y valor en el orden dado.
- **P2 — Portal web**: no se implementa. El agente responde con `formato no soportado` y produce `out/<caso>/valores-portal.md` con los valores listos para copiar. El diseño completo va en `SOLUCION.md` (sección 7.4).

### HU-4 · Armar el paquete para firma
**Como** analista, **quiero** un paquete con el formulario, los soportes y un borrador de correo, **para** enviarlo a firma en un solo paso.

Criterios de aceptación:
- Se crea `out/<caso>/paquete/` con: el formulario, copias de los soportes exigidos que existan en `repositorio/soportes/`, `checklist.md` (soportes presentes / ausentes / vencidos según `vigencia_hasta`) y `borrador-correo.md`.
- Un soporte con `vigencia_hasta` anterior a la fecha de ejecución se marca **vencido** y bloquea el estado `listo_para_firma`.
- El agente termina con un resumen en el chat y una **pregunta explícita** de confirmación antes de proponer cualquier envío. En este reto, "enviar" solo escribe `out/<caso>/ENVIO-SIMULADO.md`.

### HU-5 · Manejo de errores
**Como** analista, **quiero** que el agente falle de forma clara, **para** no perder tiempo depurando.

Criterios de aceptación:
- Plantilla corrupta, caso inexistente o formato no soportado: mensaje claro, sin traza cruda, y el proceso continúa con lo que sí puede hacer (por ejemplo, el reporte de faltantes).
- Ninguna herramienta lanza excepción hacia el agente: cada herramienta devuelve `{ ok, data }` o `{ ok: false, error }`.

---

## 6. Arquitectura requerida

Construyes un agente conversacional de extremo a extremo. Tienes libertad de framework, pero no de forma: estos componentes y este contrato de herramientas son obligatorios, porque son lo que evaluamos.

### 6.1 Componentes

```
┌──────────────┐  HTTP / WS   ┌─────────────────────────────────────────┐
│  Front: chat │ ───────────▶ │  Backend                                │
│  - historial │ ◀─────────── │  - ciclo del agente (prompt → modelo →  │
│  - tool calls│              │    llamadas a herramientas → respuesta) │
│  - confirmar │              │  - herramientas tipadas (zod)           │
└──────────────┘              │  - adaptador de proveedor LLM           │
                              │  - sesiones en memoria o archivo        │
                              └───────┬─────────────────────┬───────────┘
                                      │                     │
                               fixtures/ (solo lectura)   out/ (escritura)
```

| Componente | Obligatorio | Detalle |
|---|---|---|
| **Front de chat** | Sí | Historial de la conversación, campo de entrada, indicador de "pensando". Debe **mostrar cada llamada a herramienta** (nombre, argumentos, resultado resumido) y **resaltar cuando el agente pide confirmación**. Streaming opcional. |
| **Backend** | Sí | Expone la API del chat. Ejecuta el ciclo del agente con tope de iteraciones. Mantiene la sesión (memoria o archivo). |
| **Herramientas** | Sí | Funciones tipadas con `zod`, separadas del servidor HTTP e importables desde `demo.ts`. Son la **única** fuente de valores que el agente puede afirmar. |
| **Adaptador LLM** | Sí | Una interfaz propia (`enviar(mensajes, herramientas) → respuesta`) con una implementación para el proveedor que elijas. Cambiar de proveedor no debe tocar el ciclo del agente. |
| **System prompt** | Sí | En un archivo Markdown aparte (`agent/prompt.md`), no embebido en código. |
| **Persistencia** | No | Memoria o archivos en `out/` bastan. Sin base de datos. |
| **Autenticación** | No | El link puede ser público. Si lo proteges, entrega la clave de acceso en el README. |

### 6.2 Contrato de herramientas

Cada herramienta es un objeto con tres miembros. El nombre que ve el modelo es `<archivo>_<export>`.

```ts
// src/tools/proveedor.ts
import { z } from "zod"

export const leer_solicitud = {
  description: "…una frase: es lo único que el modelo lee para decidir cuándo llamarla",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/")
  },
  async execute(args: { caso: string }, ctx: { directory: string; sessionId: string }) {
    // ctx.directory = raíz del proyecto; resuelve rutas desde aquí, nunca absolutas
    return JSON.stringify({ ok: true, data: { /* ... */ } })
  },
}
```

| Miembro | Regla |
|---|---|
| `description` | Una frase precisa. |
| `args` | Objeto de esquemas `zod` con `.describe()` en cada campo. El backend valida antes de ejecutar y devuelve el error al modelo si no cumple. |
| `execute(args, ctx)` | Devuelve **string** (JSON serializado) con `{ ok: true, data }` o `{ ok: false, error }`. **Nunca lanza.** |

Contrato mínimo de este reto:

| Herramienta | Entrada | Salida (`data`) | Prioridad |
|---|---|---|---|
| `proveedor_leer_solicitud` | `{ caso }` | `{ pais, cliente, formato: "xlsx" \| "pdf" \| "portal", campos[], soportes[] }` | P0 |
| `proveedor_mapear_campos` | `{ caso, campos[] }` | `{ llenos[], faltantes[], requiere_confirmacion[] }` | P0 |
| `proveedor_generar_formulario` | `{ caso, mapeo }` | `{ ruta, formato }` | P0 xlsx · P1 pdf · P2 portal |
| `proveedor_armar_paquete` | `{ caso }` | `{ ruta, listo_para_firma, checklist }` | P0 |
| `proveedor_simular_envio` | `{ caso, confirmado }` | `{ ruta }` o `{ ok: false, error: "requiere confirmación explícita" }` | P1 |

### 6.3 Reglas del ciclo del agente

| # | Regla |
|---|---|
| CA1 | Tope de iteraciones herramienta → modelo por turno (sugerido 25). Al alcanzarlo, el agente responde con lo que tiene y lo que falta. |
| CA2 | El modelo **no puede afirmar un valor** que no haya salido de una herramienta. El prompt lo prohíbe; el diseño lo hace innecesario. |
| CA3 | **Confirmación humana**: cuando una acción la requiere, el agente termina el turno con una pregunta explícita. Solo procede si el siguiente mensaje del usuario confirma. El front resalta ese estado. |
| CA4 | Toda llamada a herramienta queda en el historial visible del chat y en `out/log.jsonl`. |
| CA5 | Un error de herramienta o del proveedor LLM se muestra en el chat en lenguaje claro. La sesión no muere. |

### 6.4 API mínima

Diseño libre, pero documentado en el README. Referencia:

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation }` (o stream de eventos) |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión |
| `GET` | `/api/health` | `{ ok: true, provider, model }` sin exponer claves |

### 6.5 Estructura sugerida del repositorio

```
reto-01/
├── agent/
│   └── prompt.md                        # system prompt del agente
├── src/
│   ├── server.ts                        # API HTTP y ciclo del agente
│   ├── llm/
│   │   ├── adapter.ts                   # interfaz del proveedor
│   │   └── <proveedor>.ts               # implementación elegida
│   ├── tools/
│   │   └── proveedor.ts                 # herramientas (cada export → proveedor_<export>)
│   └── knowledge/
│       └── registro-proveedor.md  # conocimiento del proceso que el agente consulta
├── web/                                 # front de chat
├── fixtures/                            # entregados por Periferia (no modificar)
├── out/                                 # generado en ejecución
├── demo.ts                              # herramientas sin modelo
├── .env.example                         # variables requeridas, sin valores
├── package.json
├── README.md
└── SOLUCION.md
```

Separación que evaluamos: **comportamiento** en `agent/prompt.md`, **conocimiento** en `src/knowledge/`, **ejecución** en `src/tools/`. Un cambio de reglas de negocio no debería tocar el servidor.

### 6.6 `demo.ts` (verificación sin modelo)

Ejecuta todos los casos de `fixtures/reto-01/casos/` llamando directamente a las herramientas e imprime un resumen por caso. Debe correr sin clave de ningún proveedor:

```bash
bun install && bun run demo.ts
```

---

## 7. Requisitos funcionales detallados

### 7.1 Entrada: estructura de un caso

Cada caso vive en `fixtures/reto-01/casos/<caso>/`:

| Archivo | Contenido |
|---|---|
| `solicitud.json` | Correo normalizado: `{ id, de, asunto, fecha, pais, cliente, cuerpo, formato, adjuntos[] }`. |
| `plantilla-celdas.json` | Solo si `formato = xlsx`. Lista de `{ hoja, celda_etiqueta, etiqueta, celda_valor }`. |
| `plantilla-campos.json` | Solo si `formato = pdf`. Lista ordenada de `{ etiqueta, obligatorio }`. |
| `soportes-exigidos.json` | Lista de tipos de soporte que el cliente exige. |

### 7.2 Repositorio maestro

| Archivo | Contenido |
|---|---|
| `fixtures/reto-01/repositorio/maestro.json` | Datos de Periferia (ficticios): razón social, NIT, dirección, representante legal, banco, cuenta, contactos, CIIU, etc. Claves en `snake_case`. |
| `fixtures/reto-01/repositorio/soportes/index.json` | Lista de soportes con `tipo`, `archivo`, `vigencia_hasta`, `pais_emisor`. Los archivos son placeholders de texto. |
| `fixtures/reto-01/glosario-campos.json` | Sinónimos (etiquetas que usan los clientes) → clave del maestro. |

### 7.3 Reglas de negocio

| # | Regla |
|---|---|
| RN1 | El identificador tributario se traduce por país: CO → NIT, EC → RUC, PE → RUC, PA → RUC, HN → RTN. Periferia solo tiene NIT colombiano; para otros países el campo se llena con el NIT y se marca `requiere_confirmacion` con la nota "identificador extranjero". |
| RN2 | Datos bancarios se llenan solo si la plantilla los pide explícitamente. Nunca se incluyen en `borrador-correo.md`. |
| RN3 | Un soporte vencido bloquea `listo_para_firma`. Un soporte exigido ausente lo bloquea. Un campo `faltante` **no** lo bloquea, pero aparece en el checklist. |
| RN4 | El agente no ejecuta ninguna acción externa (envío, firma, carga a portal) sin una confirmación explícita del usuario en el turno inmediatamente anterior. |
| RN5 | Toda ejecución deja un registro en `out/<caso>/log.jsonl` con `{ ts, herramienta, ok, resumen }`. |

### 7.4 Diseño requerido (solo documentación) — portales web

En `SOLUCION.md` describe cómo abordarías el formato "portal web con usuario y contraseña":
- Estrategia de automatización (navegador controlado por el agente, RPA, extensión de navegador) y sus límites (CAPTCHA, MFA, cambios de layout).
- Dónde viven las credenciales (nunca en el repo, nunca en el prompt, nunca en logs) y quién las ingresa.
- Qué hace el agente y qué hace el humano. Mínimo: el ingreso de credenciales y el clic en "Enviar" son humanos.

---

## 8. Requisitos no funcionales

| Categoría | Requisito |
|---|---|
| Arranque | Un comando levanta front y backend en local (`bun run dev` o `docker compose up`). Menos de 2 minutos en máquina limpia con las variables de `.env.example`. |
| Determinismo | `demo.ts` produce el mismo resultado en ejecuciones consecutivas (salvo timestamps). `out/` se limpia al inicio. |
| Seguridad | Clave del modelo solo en variable de entorno del backend. Nunca en el front, el repositorio, los logs ni las respuestas de la API. Sin credenciales ni datos personales reales. Las herramientas no ejecutan comandos de shell. |
| Costo | Tope de iteraciones por turno y tope de tokens por sesión configurables. Un usuario no puede gastar tu clave sin límite. |
| Robustez | Errores tipados `{ ok: false, error }`. Timeout al proveedor LLM con mensaje claro. Un caso malo no impide el siguiente. |
| Legibilidad | TypeScript sin `any`, funciones cortas, nombres consistentes. |
| Dependencias | Las que necesites, justificadas en `SOLUCION.md`. `zod` obligatorio para los argumentos de herramientas. |

---

## 9. Entregable y documentación

### 9.1 `SOLUCION.md` — estructura obligatoria

1. **Problema en una frase** y a quién le duele.
2. **Arquitectura**: diagrama front → backend → herramientas → archivos, y dónde vive el prompt, el conocimiento y la ejecución.
3. **Ciclo del agente**: cómo implementaste el bucle, el tope de iteraciones y la confirmación humana.
4. **Elección del modelo**: proveedor, modelo, por qué, y costo estimado por caso procesado.
5. **Diseño del portal web** (sección 7.4).
6. **Decisiones y trade-offs**: mínimo 3, con la alternativa descartada y por qué.
7. **Supuestos** que tomaste al interpretar este PRD.
8. **Cobertura**: tabla de historias de usuario con estado (hecho / parcial / no hecho) y qué falta para producción.
9. **Uso de IA**: qué asistentes usaste para construir, para qué tareas, qué descartaste de lo que te propusieron y por qué.
10. **Riesgos** de llevar esto a producción y cómo los mitigarías.

### 9.2 `README.md`

Cómo levantar en local (un comando), variables de entorno requeridas, cómo correr `demo.ts`, el link de prueba y, si aplica, la clave de acceso al link.

### 9.3 Link para probar

URL pública donde el agente responde (Vercel, Render, Fly.io, Railway, Azure, un túnel estable, o el proveedor que prefieras). Debe estar activo durante la defensa. Si el despliegue no fue posible, se acepta correrlo en local durante la defensa con penalización de `-10`.

### 9.4 Bonus: módulo reutilizable (hasta +10)

Entrega además una carpeta `modulo/` con el agente empaquetado para integrarse a otras plataformas de agentes, sin depender de tu servidor:

```
modulo/
├── agent.md            # frontmatter: description, mode: primary, permission {edit: deny, bash: deny}; cuerpo: el system prompt
├── tools/proveedor.ts     # las mismas herramientas, importables sin el servidor
└── skill/registro-proveedor/SKILL.md   # frontmatter: name, description; cuerpo: el conocimiento del proceso
```

Se evalúa que las tres piezas sean las mismas que usa tu aplicación (no copias divergentes).

### 9.5 Forma de entrega

Repositorio Git con historial de commits, o `reto-01-<apellido>.zip`. Sin `node_modules/`, sin `out/`, sin `.env`.

---

## 10. Riesgos, supuestos y preguntas abiertas

| Tipo | Contenido |
|---|---|
| Supuesto | Los fixtures representan la variabilidad real de los clientes. En producción habrá plantillas peores. |
| Supuesto | El repositorio maestro está actualizado. En producción se necesita un dueño del dato. |
| Riesgo | El modelo puede "completar" un campo faltante con un valor plausible. Mitigación: las herramientas son la única fuente de valores; el prompt prohíbe valores fuera del mapeo. |
| Riesgo | Portales web con CAPTCHA o MFA. Mitigación: el humano opera el portal; el agente prepara los valores en un formato copiable. |
| Pregunta abierta | ¿La firma electrónica se integra en una fase posterior? Fuera de alcance de este reto. |

---

## 11. Prompt de ejemplo para la demo

En tu chat, sesión nueva:

```
Procesa el caso "ec-corp-andina". Dime qué campos quedaron llenos, cuáles
faltan, si el paquete está listo para firma y qué soportes debo actualizar.
No envíes nada todavía.
```

Resultado esperado: Resumen estructurado, llamadas a herramientas visibles en el chat, ruta de `out/ec-corp-andina/`, lista de faltantes, estado `listo_para_firma`, y una pregunta cerrando el turno. Un segundo mensaje "envía" debe producir solo `ENVIO-SIMULADO.md` tras confirmación explícita.
