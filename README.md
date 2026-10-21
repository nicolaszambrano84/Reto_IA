# Reto 01 — Agente conversacional "Registro como Proveedor"

Agente que lee la solicitud de registro de un cliente, llena el formulario (Excel o PDF) desde el
repositorio maestro de Periferia, arma el paquete de soportes para la firma del representante legal y
**pide confirmación explícita** antes de simular cualquier envío.

- Planteamiento, arquitectura y decisiones: [SOLUCION.md](SOLUCION.md)
- Enunciado original: [PRD.md](PRD.md)

## Requisitos

- Node.js **20.12 o superior** (probado con Node 24) y npm.
- Opcional: una API key de Anthropic, OpenAI o Gemini. **Sin clave también funciona**: el agente
  arranca en modo determinista y ejecuta las mismas herramientas reales.

## Levantar en local (un comando)

```bash
npm install
npm run dev          # http://localhost:3000  (front + backend, recarga al guardar)
```

`npm start` hace lo mismo sin recarga automática. Para usar un LLM:

```bash
cp .env.example .env # y completa UNA de: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY
npm run dev
```

El servidor imprime el proveedor y el modelo activos. También puedes verlos en `GET /api/health`.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor con recarga (`tsx watch src/server.ts`). |
| `npm start` | Servidor sin recarga. |
| `npm run demo` | **Verificación sin modelo**: limpia `out/`, procesa todos los casos llamando directo a las herramientas e imprime un resumen por caso. No necesita clave. |
| `npm test` | Pruebas de comportamiento: compuerta de confirmación, tope de iteraciones, caída del proveedor, plantilla corrupta, RN2 y RN3. |
| `npm run typecheck` | `tsc --noEmit` (TypeScript estricto, sin `any`). |
| `npm run modulo` | Regenera `modulo/agent.md` y `modulo/skill/.../SKILL.md` desde sus fuentes. `npm run modulo:check` verifica que estén sincronizados. |

## Variables de entorno

Todas son opcionales; ver [.env.example](.env.example).

| Variable | Por defecto | Uso |
|---|---|---|
| `LLM_PROVIDER` | `auto` | `auto` (el primero con clave: anthropic → openai → gemini), `anthropic`, `openai`, `gemini` o `local`. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | — | Clave del proveedor. Solo se lee en el backend; nunca va al front, a los logs ni a las respuestas. |
| `LLM_MODEL` | `claude-opus-5-5` · `gpt-4.1-mini` · `gemini-2.5-flash` | Modelo del proveedor elegido. |
| `LLM_EFFORT` | `low` | Esfuerzo de razonamiento (solo Anthropic). |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Endpoint compatible con OpenAI (Azure, proxy). |
| `LLM_TIMEOUT_MS` | `45000` | Timeout por llamada al proveedor. Si se excede, responde el modo determinista con un aviso. |
| `MAX_ITERACIONES` | `25` | Tope de iteraciones modelo → herramientas por turno (CA1). |
| `MAX_TOKENS_SESION` | `300000` | Tope de tokens por sesión (costo). |
| `PORT` | `3000` | Puerto HTTP. |
| `ACCESS_KEY` | — | Si se define, `/api/*` y `/out/*` exigen la cabecera `x-access-key`; el front la pide una vez. |
| `FECHA_EJECUCION` | hoy | Fecha `YYYY-MM-DD` para evaluar vigencias (útil para pruebas reproducibles). |

## Probar el agente

1. Abre `http://localhost:3000`.
2. Pulsa **▶ Prompt demo (§11)**, que envía:
   > Procesa el caso "ec-corp-andina". Dime qué campos quedaron llenos, cuáles faltan, si el paquete
   > está listo para firma y qué soportes debo actualizar. No envíes nada todavía.
3. Verás las 4 llamadas a herramientas (despliega cada una para ver argumentos y resultado), el
   resumen y el recuadro naranja de **confirmación pendiente**.
4. Responde **"envía"** (o pulsa *Sí, envía*): solo entonces se escribe `out/ec-corp-andina/ENVIO-SIMULADO.md`.

Las rutas `out/...` del chat son enlaces a los archivos generados. Con la fecha de hoy (2026-10-20),
ningún caso queda listo para firma: la Cámara de Comercio venció el 2026-09-30. Es el resultado
correcto de RN3.

## Link de prueba

> **URL:** _completar_ · **Clave de acceso:** _completar_ (el chat la pide una vez y la recuerda)
>
> El plan gratuito de Render se duerme tras 15 minutos sin uso: la primera visita tarda 30–60 s en despertar.

### Desplegar en Render

El repositorio incluye `Dockerfile` y `render.yaml` (blueprint).

1. En [dashboard.render.com](https://dashboard.render.com): **New → Blueprint** y conecta el repositorio de GitHub.
2. Render lee `render.yaml` y pide los dos secretos:
   - `ANTHROPIC_API_KEY`: tu clave de Anthropic.
   - `ACCESS_KEY`: la clave de acceso al link, que se entrega a los evaluadores.
3. **Apply**. Cuando el deploy termine, `https://<servicio>.onrender.com/api/health` debe responder
   `{"ok":true,"provider":"anthropic",...}`.

Render asigna `PORT` solo. Cada `git push` a `main` vuelve a desplegar. Las claves viven solo en
Render, nunca en el repositorio.

**Plan B (túnel):** `npm start` en local y `cloudflared tunnel --url http://localhost:3000`.

Con Docker en local:

```bash
docker build -t reto01 . && docker run -p 3000:3000 -e ANTHROPIC_API_KEY=... -e ACCESS_KEY=... reto01
```

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation, avisos[], provider, model, tokens }`. Sin `sessionId`, se crea una sesión. |
| `GET` | `/api/sessions/:id` | Historial completo: turnos con sus llamadas a herramientas, tokens y si hay confirmación pendiente. |
| `GET` | `/api/health` | `{ ok: true, provider, model, modo, auth }`, sin exponer claves. |
| `GET` | `/api/casos` | Casos disponibles en `fixtures/reto-01/casos/`. |
| `GET` | `/out/<ruta>` | Descarga de archivos generados (excepto sesiones). |

Cada elemento de `toolCalls` tiene la forma `{ id, nombre, argumentos, ok, resultado, duracionMs, bloqueadaPorConfirmacion? }`.

```bash
curl -s localhost:3000/api/chat -H 'content-type: application/json' \
  -d '{"sessionId":"demo","message":"Procesa el caso co-industrias-delta"}'
```

## Estructura

```
agent/prompt.md                 comportamiento del agente (system prompt)
src/knowledge/                  conocimiento: registro-proveedor.md + reglas.json (RN1, RN2, umbral…)
src/tools/proveedor.ts          las 5 herramientas (contrato §6.2); lógica en src/tools/lib/
src/llm/adapter.ts              interfaz enviar(mensajes, herramientas)
src/llm/provider.ts             fábrica + respaldo determinista; anthropic.ts, openai.ts, gemini.ts, local.ts
src/agent/                      ciclo del agente, compuerta de confirmación, sesiones, registro de herramientas
src/server.ts                   HTTP nativo (node:http) + estáticos de web/
web/index.html                  chat
demo.ts                         verificación sin modelo
modulo/                         bonus: agente empaquetado (agent.md, tools/, skill/)
fixtures/                       entregados por Periferia (solo lectura)
out/                            generado en ejecución (ignorado por git)
```

Salida por caso en `out/<caso>/`: `formulario.xlsx` / `formulario.pdf` / `valores-portal.md`,
`mapeo.json`, `log.jsonl`, `paquete/` (formulario, `soportes/`, `checklist.md`, `borrador-correo.md`)
y, tras confirmar, `ENVIO-SIMULADO.md`. El log global está en `out/log.jsonl`.

## Módulo reutilizable (bonus)

`modulo/` empaqueta el agente para otras plataformas sin depender del servidor:

- `modulo/agent.md`: frontmatter (`description`, `mode: primary`, `permission: { edit: deny, bash: deny }`) + el cuerpo de `agent/prompt.md`.
- `modulo/tools/proveedor.ts`: `export * from "../../src/tools/proveedor"`, las mismas herramientas sin copia.
- `modulo/skill/registro-proveedor/SKILL.md`: frontmatter (`name`, `description`) + el contenido de `src/knowledge/registro-proveedor.md`.

Las dos piezas Markdown se generan con `npm run modulo`, y `npm run demo` verifica que no hayan divergido.
