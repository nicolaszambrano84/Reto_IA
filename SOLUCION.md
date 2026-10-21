# SOLUCIÓN — Reto 01 · Agente "Registro como Proveedor"

## 1. Problema en una frase

La analista administrativa de Periferia transcribe a mano, entre 8 y 12 veces al mes, los mismos datos
de la empresa en formularios de proveedor distintos (Excel, PDF, portales) y arma a mano el paquete de
soportes. Eso le cuesta días de respuesta y abre la puerta a errores en datos sensibles (NIT, cuenta
bancaria). El costo lo pagan **la analista**, que hoy es un punto único de conocimiento; **el área
comercial y financiera**, porque el registro retrasa la facturación; y **el representante legal**, que
firma lo que le llega.

## 2. Arquitectura

```
┌──────────────────────┐   HTTP (JSON)   ┌──────────────────────────────────────────────────────────┐
│ web/index.html       │ ──────────────▶ │ src/server.ts  (node:http, Node 20+, tsx)                │
│ - historial          │  POST /api/chat │  ├─ src/agent/ciclo.ts   bucle · tope 25 · compuerta RN4 │
│ - tarjetas de tools  │ ◀────────────── │  ├─ src/agent/sesiones.ts memoria + out/sesiones/*.json  │
│   (args + resultado) │  reply,         │  ├─ src/agent/herramientas.ts  zod → JSON Schema,       │
│ - banda "confirmar"  │  toolCalls,     │  │                            valida antes de ejecutar  │
│ - botones rápidos    │  needsConfirm.  │  └─ src/llm/adapter.ts  enviar(mensajes, herramientas)   │
└──────────────────────┘                 │        ├─ anthropic.ts (SDK oficial)                     │
                                         │        ├─ openai.ts · gemini.ts (fetch nativo)           │
                                         │        └─ local.ts  (determinista, respaldo)             │
                                         └───────────────┬──────────────────────────────────────────┘
                                                         │ import directo (también demo.ts y modulo/)
                                         ┌───────────────▼──────────────────────────────────────────┐
                                         │ src/tools/proveedor.ts   5 herramientas, contrato §6.2   │
                                         │   lib/fixtures · mapeo · formularios · paquete · ejecucion│
                                         └───────┬──────────────────────────────────┬───────────────┘
                                                 │ solo lectura                     │ escritura
                                         fixtures/reto-01/                  out/<caso>/… + out/log.jsonl
```

**Separación prompt / conocimiento / ejecución:**

| Capa | Dónde | Qué contiene | Cambia cuando… |
|---|---|---|---|
| Comportamiento | `agent/prompt.md` | Tono, orden del flujo, qué puede afirmar, formato de respuesta, regla de confirmación. | Cambia cómo debe hablar o actuar el agente. |
| Conocimiento | `src/knowledge/registro-proveedor.md` + `src/knowledge/reglas.json` | Proceso, estados de campo, RN1–RN5, soportes. `reglas.json` tiene los parámetros que ejecutan las herramientas: identificador por país, etiquetas ambiguas, prefijo bancario, umbral de confianza, nombres de soportes. | Cambia una regla de negocio. **No se toca el servidor**, y un país nuevo es una línea en `reglas.json`. |
| Ejecución | `src/tools/` | Lectura de fixtures, mapeo, generación xlsx/pdf/portal, paquete, logs. Única fuente de valores. | Cambia un formato de salida o una fuente de datos. |

El system prompt se arma en tiempo de ejecución como `prompt.md` + `registro-proveedor.md` + la lista
de casos (`src/agent/prompt.ts`). Todo corre sobre Node.js 20+ con `tsx`, sin paso de compilación;
`tsc --noEmit` valida tipos estrictos (`strict`, `noUncheckedIndexedAccess`, sin `any`).

**Dependencias y por qué:** `zod` (obligatorio, y además da el JSON Schema con `z.toJSONSchema`),
`exceljs` (escribir celdas exactas por hoja, con notas y relleno), `pdf-lib` (PDF puro en JS, sin
binarios nativos), `@anthropic-ai/sdk` (cliente oficial, con tipos y reintentos), `tsx` y `typescript`.
OpenAI y Gemini van por `fetch` nativo: es una sola llamada HTTP por proveedor y no justifica dos SDKs
más. El servidor usa `node:http`, porque cinco rutas no requieren Express.

## 3. Ciclo del agente

`procesarTurno` en `src/agent/ciclo.ts`:

1. Se toma la **ventana de confirmación** del turno anterior (`sesion.confirmacionPendiente`) y se
   limpia. Así la confirmación vale para un solo mensaje, como exige RN4 ("turno inmediatamente
   anterior").
2. Se agrega el mensaje del usuario y comienza el bucle `modelo → herramientas`:
   - Antes de cada iteración se comprueban el **tope de iteraciones** (`MAX_ITERACIONES`, 25) y el
     **tope de tokens de la sesión** (`MAX_TOKENS_SESION`).
   - `proveedor.enviar([sistema, ...historial], definiciones)`. Si la respuesta no trae llamadas, ese
     texto es la respuesta final.
   - Cada llamada pasa por la **compuerta RN4**: si es `proveedor_simular_envio` con `confirmado: true`
     y no hubo pregunta de confirmación para ese caso en el turno anterior, o el mensaje actual no
     confirma, el servidor **reescribe `confirmado` a `false`**. La herramienta devuelve
     `requiere confirmación explícita` y la tarjeta del chat se marca "bloqueada: sin confirmación".
     La regla no depende de que el modelo obedezca el prompt.
   - Se valida con zod (`src/agent/herramientas.ts`), se ejecuta y se agrega el resultado al historial.
3. Si se armó un paquete o se bloqueó un envío, queda una **confirmación pendiente**. El servidor
   garantiza que el turno termine con una pregunta (la agrega si el modelo no la hizo) y responde
   `needsConfirmation: true`. El front lo resalta con borde naranja y botones *Sí, envía* / *No*.
4. Al alcanzar el tope, el agente responde con lo que hizo, lo que falló y cómo continuar (CA1).
5. Errores del proveedor (timeout, 5xx, cuota) llegan como `ErrorProveedor` con mensaje legible. El
   envoltorio `ProveedorConRespaldo` cambia al modo determinista durante 60 s y deja un aviso visible
   en el chat. La sesión nunca muere (CA5).

Las herramientas nunca lanzan: `ejecutar()` (`src/tools/lib/ejecucion.ts`) valida los argumentos,
captura cualquier excepción, devuelve siempre `{ ok, data }` o `{ ok: false, error }` serializado y
escribe la línea de log en `out/log.jsonl` y en `out/<caso>/log.jsonl` (RN5, CA4).

**Modo determinista** (`src/llm/local.ts`): implementa la misma interfaz `ProveedorLLM`. Detecta el caso
por nombre, palabras clave o país, sigue el flujo leer → mapear → generar → armar leyendo los
resultados reales del turno, y redacta el resumen **solo** con datos de esos resultados. Sirve como
respaldo sin clave o sin red, y como prueba de que el ciclo no depende del proveedor.

## 4. Elección del modelo y costo

**El agente no depende de un proveedor.** Acepta Anthropic, OpenAI (ChatGPT) o Google Gemini detrás de
la misma interfaz `enviar(mensajes, herramientas)`. Elegir uno es solo configuración: basta con definir
**una** de `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` o `GEMINI_API_KEY`, y opcionalmente el modelo de ese
proveedor (`ANTHROPIC_MODEL`, `OPENAI_MODEL`, `GEMINI_MODEL`). Con `LLM_PROVIDER=auto` se usa el
primero con clave (anthropic → openai → gemini). Si se pide un proveedor sin clave, se usa otro que sí
la tenga, y un modelo de otro proveedor se ignora. Sin ninguna clave, el agente responde en modo
determinista con las mismas herramientas.

| Proveedor | Modelo por defecto | Implementación | Notas |
|---|---|---|---|
| Anthropic | `claude-opus-5-5`, `effort: low` | SDK oficial `@anthropic-ai/sdk` | Prompt caching del system prompt; `fallbacks: "default"` ante una negativa por política; devuelve los bloques de *thinking* sin cambios entre iteraciones. |
| OpenAI (ChatGPT) | `gpt-4.1-mini` | `fetch` a Chat Completions | `OPENAI_BASE_URL` permite Azure OpenAI o un proxy corporativo. |
| Google Gemini | `gemini-2.5-flash` | `fetch` a `generateContent` | Tiene plan gratuito; devuelve las `thoughtSignature` que exige en llamadas a funciones. |

**Recomendación para producción: Anthropic (`claude-opus-5-5`, `effort: low`)**, por tres razones:
(a) la tarea premia la obediencia estricta a reglas ("no inventes", "no envíes sin confirmar") más que la
creatividad; (b) el uso de herramientas en varios pasos es confiable; (c) con 8–12 casos al mes, el
costo es irrelevante frente a una hora de trabajo humano. `effort: low` basta porque el flujo es lineal
y el razonamiento pesado lo hacen las herramientas. Para priorizar costo cero en pruebas, Gemini Flash
con plan gratuito es la alternativa.

**Estado del despliegue de prueba:** hoy el link corre **sin clave de LLM**, es decir, en modo
determinista. Activar cualquier proveedor es agregar su clave en las variables de entorno de Render,
que reinicia el servicio solo; no requiere cambios de código.

**Costo estimado por caso** (prompt §11 + "envía"; estimación por tamaño de los mensajes, no medida
con facturación real):

| Concepto | Tokens aprox. |
|---|---|
| System prompt + conocimiento + 5 definiciones de herramientas | ~3.500 por llamada |
| Resultados de herramientas acumulados (leer ~1,5k, mapear ~1,5k, generar ~0,3k, paquete ~1,2k) | crece hasta ~4.500 |
| 5 llamadas al modelo en el turno 1 + 2 en el turno 2 | **~42.000 de entrada**, **~3.000 de salida** (incluye thinking en `low`) |

| Modelo | Precio (entrada / salida por MTok) | Costo por caso sin caché | Con caché del prefijo |
|---|---|---|---|
| `claude-opus-5-5` | US$ 4 / 20 | ≈ US$ 0,23 | ≈ US$ 0,10 |
| `claude-sonnet-5-5` | US$ 2 / 10 | ≈ US$ 0,11 | ≈ US$ 0,05 |
| `claude-haiku-5-5` | US$ 0,10 / 0,50 | ≈ US$ 0,006 | < US$ 0,005 |

Con 12 casos al mes, Opus cuesta menos de **US$ 3/mes**. El peor caso está acotado por
`MAX_TOKENS_SESION` (300k tokens ≈ US$ 1,2 de entrada en Opus). Si el volumen creciera 100×, se
cambia a Sonnet o Haiku con `LLM_MODEL`, previa medición con los mismos casos.

## 5. Diseño del portal web (sección 7.4)

**Estado actual:** para `formato: portal`, `generar_formulario` responde *formato no soportado* y
produce `out/<caso>/valores-portal.md`: una tabla campo → valor → estado, la URL del portal tomada del
correo, los soportes a cargar y una advertencia de que el archivo contiene datos bancarios.

**Estrategia propuesta (fase 2): asistente de llenado con el humano al mando.**

| Opción | Ventaja | Límite | Decisión |
|---|---|---|---|
| Navegador controlado por el agente (Playwright/CDP en servidor) | Automatiza el 100% del tecleo. | El agente tendría que manejar credenciales y sesión; CAPTCHA y MFA lo frenan; cada cambio de layout rompe selectores; es difícil de auditar. | Descartada como modo principal. |
| RPA clásico (UiPath / Power Automate) | Maduro y con grabador. | Licencias; un flujo por portal; frágil ante cambios; la misma exposición de credenciales. | Descartada para 8–12 casos/mes. |
| **Extensión de navegador "relleno asistido"** | Corre en la sesión que **la analista ya abrió**: ella ingresa usuario, contraseña, MFA y CAPTCHA. La extensión consulta al backend los valores del caso y los propone campo por campo, con resaltado de faltantes y por confirmar. | Requiere un perfil de mapeo por portal (selectores ↔ etiquetas), tolerante a cambios mediante coincidencia por `label`/`aria-label` con el mismo glosario. | **Elegida.** |

**Credenciales:** nunca en el repositorio, el prompt, los logs ni el backend del agente. Las recibe el
representante legal por un canal aparte (como dice el correo del caso PA) y se guardan en el gestor
corporativo de contraseñas (p. ej. 1Password o Bitwarden Business, o Azure Key Vault si hubiera que
compartirlas entre personas), con acceso nominal. La extensión **no lee ni guarda** campos de tipo
password. El agente nunca recibe esas credenciales, así que no puede filtrarlas.

**Reparto de tareas:**

| Agente | Humano |
|---|---|
| Prepara los valores desde el maestro (`valores-portal.md` / API). | Abre el portal e **ingresa credenciales, MFA y CAPTCHA**. |
| Rellena campos en el formulario abierto, sin enviar. | Revisa cada campo, completa faltantes y confirma los marcados. |
| Señala soportes a cargar y su vigencia. | Carga los archivos y **hace clic en "Enviar"**. |
| Registra en `log.jsonl` qué propuso y cuándo. | Confirma en el chat que se envió, para cerrar el caso. |

**Límites asumidos:** si el portal cambia de layout, el relleno degrada con elegancia: lo que no
encuentra lo deja para copiar a mano. CAPTCHA y MFA nunca se automatizan.

## 6. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | `generar_formulario` **vuelve a calcular** el mapeo desde el maestro y solo contrasta el `mapeo` recibido del modelo (reporta diferencias en `advertencias`). | Escribir en el archivo los valores que el modelo pasa en `mapeo`. | CA2: el modelo podría alterar o "completar" un valor en tránsito. Así el argumento cumple el contrato, pero la fuente de verdad sigue siendo el maestro. |
| 2 | La confirmación RN4 se **impone en el servidor** (compuerta con ventana de un turno) además del prompt. | Confiar en que el modelo ponga `confirmado: true` solo cuando corresponde. | Una acción externa no puede depender de la obediencia de un LLM. Hay una prueba con un modelo falso "desobediente" (`npm test`). |
| 3 | Los datos bancarios llegan **enmascarados** al modelo (`*******2345`), y el borrador de correo pasa por un filtro que elimina cualquier valor de `banco.*`. | Enviar el valor completo al modelo y confiar en el prompt. | RN2 en dos capas: lo que el modelo no ve, no lo puede repetir; y el filtro protege el borrador aunque una plantilla futura incluya esos datos. |
| 4 | **Modo determinista** detrás de la misma interfaz `ProveedorLLM`. | Fallar con "configure una API key" o tener una ruta de código aparte para la demo. | El link sigue respondiendo sin clave o con el proveedor caído (CA5), y demuestra que el ciclo no depende del proveedor. Costo: la comprensión de lenguaje del modo local es limitada (palabras clave). |
| 5 | PDF **generado** con `pdf-lib`, no AcroForm rellenado. | Rellenar el PDF original del cliente. | El fixture no trae el PDF, solo `plantilla-campos.json`, y el PRD acepta un PDF generado. Rellenar AcroForms es una extensión directa con el mismo `pdf-lib`. |
| 6 | Sesiones en memoria con copia JSON en `out/sesiones/`. | Base de datos (SQLite o Redis). | No-objetivo del PRD; sobrevive a reinicios sin infraestructura. |
| 7 | Un soporte **vencido se copia al paquete** pero **no se lista como adjunto** en el borrador de correo. | No copiarlo, o adjuntarlo igual. | La analista lo tiene a mano para renovarlo, pero el borrador no invita a enviar un documento vencido. |

## 7. Supuestos

1. **Fecha de ejecución = fecha del sistema** (o `FECHA_EJECUCION`). Con hoy (2026-10-20), la Cámara de
   Comercio (vence 2026-09-30) y los parafiscales (2026-08-31) están vencidos, así que **ningún caso
   está listo para firma**. Es el comportamiento que pide RN3. Con `FECHA_EJECUCION=2026-08-30`,
   `co-industrias-delta` sí queda listo (cubierto en `npm test`).
2. Para `xlsx`, el formulario se **crea** con las hojas y celdas de `plantilla-celdas.json`, porque el
   `.xlsx` original no viene en los fixtures. Con el archivo real, `exceljs` lo abriría y escribiría
   en las mismas celdas.
3. "Identificación tributaria" y "Número de identificación fiscal" son etiquetas **ambiguas**. RN1
   también aplica cuando la etiqueta es explícita (RUC o RTN) pero el país no es CO. En CO con
   etiqueta "NIT" el campo queda `lleno`.
4. Mapeo: glosario exacto → confianza 1,0; glosario normalizado (tildes, mayúsculas) → 0,95; nombre
   de clave del maestro → 0,85; coincidencia aproximada por palabras → siempre < 0,8, es decir,
   `requiere_confirmacion`. Sin coincidencia → `faltante`.
5. "Correo electrónico" se llena con el **contacto comercial** (así lo define el glosario), no con el
   del representante legal.
6. El "envío" se puede simular aunque el paquete **no** esté listo para firma, si el usuario lo
   confirma. El PRD espera que "envía" produzca `ENVIO-SIMULADO.md` en `ec-corp-andina`, que no está
   listo. El archivo deja constancia de los bloqueos pendientes.
7. En portal no hay formulario que firmar. Igual se arma el paquete con `valores-portal.md` y los
   soportes que se cargarán.
8. Los soportes emitidos en CO se aceptan como equivalentes para clientes extranjeros, salvo que el
   tipo exigido no exista en el repositorio (`certificado_cumplimiento_tributario` en EC queda
   **ausente**).

## 8. Cobertura

| HU | Estado | Evidencia | Qué falta para producción |
|---|---|---|---|
| HU-1 Leer la solicitud | **Hecho** | `leer_solicitud`: país, cliente, formato, campos (con hoja/celda u obligatoriedad), soportes y `requiere_confirmacion` tributario con el equivalente del país. | Ingesta real del correo (Graph API o IMAP) y extracción de plantillas desde adjuntos `.xlsx` y `.pdf`. |
| HU-2 Mapear al maestro | **Hecho** | Tres estados, `ruta` del dato, confianza, sinónimos del glosario y RN1. Nunca inventa: sin fuente → `faltante`. | Dueño del dato para el maestro, histórico de vigencias y glosario editable por la analista. |
| HU-3 Formulario | **Hecho** (P0 xlsx, P1 pdf) / **Diseñado** (P2 portal) | Celdas exactas con notas en faltantes y por confirmar; PDF con todos los campos en orden y línea de firma; `valores-portal.md`. | Rellenar el `.xlsx` y el AcroForm originales del cliente; extensión de portal (§5). |
| HU-4 Paquete | **Hecho** | `paquete/` con formulario, soportes, `checklist.md` (presentes, ausentes, vencidos, faltantes, por confirmar) y `borrador-correo.md` sin datos bancarios; `listo_para_firma`; pregunta final y `ENVIO-SIMULADO.md` solo tras confirmar. | Firma electrónica hecha por el representante legal con su propia credencial, nunca por el agente (ver Anexo A); envío real con aprobación. |
| HU-5 Errores | **Hecho** | Caso inexistente, nombre malicioso (`../`), plantilla corrupta (el paquete se arma igual), proveedor caído o con timeout, herramienta desconocida y argumentos inválidos. Nada lanza; todo llega como `{ ok: false, error }` legible. | Alertas (Sentry u OpenTelemetry) y reintentos con *backoff* configurables. |

Reglas transversales: CA1 (tope 25) ✔ · CA2 (valores solo de herramientas, re-cálculo y
enmascarado) ✔ · CA3 (pregunta y banda de confirmación) ✔ · CA4 (tarjetas en el chat + logs) ✔ ·
CA5 (errores claros, sesión viva) ✔ · RN1–RN5 ✔. Bonus `modulo/` ✔ (sincronía verificada por
`npm run demo` y `npm run modulo:check`).

## 9. Uso de IA

| Asistente | Para qué | Qué se descartó y por qué |
|---|---|---|
| **Claude Code** | Lectura del PRD y de los fixtures; diseño de la arquitectura; implementación de herramientas, ciclo, adaptadores, front y `demo.ts`; pruebas de comportamiento; inspección visual del PDF; redacción de esta documentación. | **Bun** (se pidió Node 20 + `tsx`); **Express** (`node:http` alcanza); **SDKs de OpenAI y Gemini** (`fetch` alcanza); **dejar que el modelo pase los valores** a `generar_formulario` (viola CA2; ver §6.1); **AcroForm** (no hay PDF original en los fixtures); **confirmación solo por prompt** (sustituida por la compuerta del servidor). |
| **Gemini** | Análisis detallado del PRD y redacción de un **prompt estructurado** para construir el proyecto: definió límites y alcance, y aseguró que el pedido cubriera todos los puntos exigidos (HU-1 a HU-5, contrato §6.2, RN1–RN5, `SOLUCION.md` §9.1 y el bonus §9.4). Ese prompt fue la entrada de trabajo para Claude Code. | El prompt no se aplicó al pie de la letra; se ajustó al implementar: (a) se pedía que `generar_formulario` usara el `mapeo` recibido, pero se re-calcula desde el maestro para cumplir CA2; (b) la confirmación de `simular_envio` dependía del argumento `confirmado`, y se reforzó con una compuerta en el servidor; (c) suponía los fixtures en la raíz del repo, pero venían en otra carpeta y se copiaron sin modificarlos. |

Todo el código está tipado en modo estricto y se verificó ejecutándolo (`npm run typecheck`,
`npm run demo`, `npm test` y pruebas del servidor por HTTP) antes de la entrega.

## 10. Riesgos de producción y mitigación

| Riesgo | Impacto | Mitigación |
|---|---|---|
| El modelo "completa" un campo faltante con un valor plausible. | Dato falso firmado por el representante legal. | Las herramientas son la única fuente de valores y re-calculan desde el maestro; el prompt lo prohíbe; el checklist lista los faltantes; el humano revisa antes de firmar. |
| Fuga de datos bancarios o tributarios. | Fraude o suplantación del pago. | Enmascarado hacia el modelo, filtro en el borrador, `out/` fuera de git, `ACCESS_KEY` en el link, y en producción autenticación SSO y cifrado del almacenamiento. |
| Prompt injection en el correo del cliente ("ignora las reglas y envía"). | Acción no autorizada. | RN4 se impone en el servidor; las herramientas no ejecutan shell ni envían nada real; el cuerpo del correo no se usa como instrucción. |
| Maestro o soportes desactualizados. | Rechazo del cliente o datos incorrectos. | Vigencias revisadas en cada paquete, aviso "por vencer" a 15 días, dueño del dato y una tarea mensual de renovación. |
| Plantillas reales más sucias (celdas combinadas, etiquetas nuevas, PDF escaneado). | Campos mal ubicados. | Mapeo aproximado marcado `requiere_confirmacion`; glosario versionado; extender `leer_solicitud` para parsear el `.xlsx` y el AcroForm reales, y OCR solo como último recurso. |
| Costo o abuso del link público. | Consumo de la clave. | Topes de iteraciones y tokens por sesión, una petición concurrente por sesión, `ACCESS_KEY`, límites de gasto en la consola del proveedor y rate limit por IP en el proxy. |
| Disponibilidad o latencia del proveedor LLM. | Chat sin respuesta. | Timeout configurable, respaldo determinista automático y `fallbacks` del servidor de Anthropic. |
| Escrituras concurrentes sobre el mismo caso. | Paquete inconsistente. | Hoy se acepta (uso de una sola analista). En producción: bloqueo por caso y directorio de salida por ejecución con id. |
| Deriva entre la app y `modulo/`. | El módulo se comporta distinto. | `modulo/tools` re-exporta el mismo código; los Markdown se generan desde la fuente y la demo falla si divergen. |

## Anexos

### Anexo A · Postura sobre la pregunta abierta del PRD: firma electrónica

> *¿La firma electrónica se integra en una fase posterior?* (PRD §10)

**Sí, se recomienda usar firma electrónica** por su validez jurídica, con una condición de diseño
innegociable: **la firma la realiza siempre el representante legal, nunca el agente.**

- **Control de completitud e integridad.** El acto de firmar es el último punto de control humano.
  Antes de firmar, el responsable verifica que el registro generado esté completo (faltantes y campos
  por confirmar resueltos) y sea íntegro (los valores coinciden con la realidad de la empresa). Si el
  agente firmara, ese control desaparecería.
- **La firma es personal e intransferible.** El certificado o credencial de firma lo custodia y lo usa
  únicamente su titular. No se entrega a un proceso automatizado: un proceso así guarda o puede acceder
  a la credencial, y esa superficie de ataque la podría aprovechar un tercero para firmar en nombre de
  la empresa.

**Cómo encaja en el flujo (fase posterior):**

| Paso | Responsable |
|---|---|
| Preparar el formulario, el paquete y el checklist (`listo_para_firma`). | Agente |
| Revisar el paquete y resolver faltantes y campos por confirmar. | Analista |
| Abrir el documento en la plataforma de firma electrónica y **firmar con su propia credencial**. | Representante legal |
| Registrar en el caso que el documento volvió firmado (sin acceso a la credencial). | Agente |

El agente nunca recibe, almacena ni usa credenciales, certificados ni PIN de firma, igual que con las
credenciales de portales (§5).

### Anexo B · Autenticación de usuarios en producción

La autenticación de usuarios es un **no-objetivo** de este reto (PRD §3.2). El link de prueba solo
admite una clave de acceso compartida opcional (`ACCESS_KEY`). **En producción, el agente debe tener un
mecanismo de autenticación**, y lo más adecuado es integrarlo con un **proveedor de identidad (IdP)
externo**, como **Microsoft Entra ID**:

- **Gestión centralizada y ciclo de vida de los usuarios.** Las altas, bajas y cambios de rol se hacen
  en el directorio corporativo. Si una persona sale de la empresa, pierde el acceso al agente
  automáticamente, sin cuentas locales huérfanas.
- **MFA y acceso condicional.** El IdP aplica autenticación multifactor y políticas de acceso
  condicional (dispositivo, ubicación, riesgo de la sesión). Así se controla quién accede a los
  agentes y para qué los usa, sin implementar esa lógica en la aplicación.
- **Autorización por roles.** Los grupos del directorio se traducen en permisos dentro del agente. Por
  ejemplo, solo la analista administrativa puede procesar casos y confirmar envíos simulados; otros
  perfiles solo consultan.
- **Trazabilidad por persona.** El identificador del usuario autenticado reemplaza al `sessionId`
  anónimo en `out/log.jsonl` y en `ENVIO-SIMULADO.md`. Cada confirmación queda atribuida a una
  persona concreta (refuerza RN4 y RN5).

**Integración propuesta:** OpenID Connect (Authorization Code + PKCE) entre el front y Entra ID. El
backend valida el token (firma, emisor, audiencia, expiración) en cada llamada a `/api/*` y `/out/*`,
en lugar de la `ACCESS_KEY` actual. El ciclo del agente y las herramientas no cambian: solo se agrega
una capa de autenticación delante del servidor.
