import { randomUUID, timingSafeEqual } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { procesarTurno, type ConfigCiclo } from "./agent/ciclo"
import { cargarSistema } from "./agent/prompt"
import { AlmacenSesiones, IdSesionSchema } from "./agent/sesiones"
import { crearProveedor, leerConfig } from "./llm/provider"
import { listarCasos } from "./tools/lib/fixtures"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
if (existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env"))

const PUERTO = Number.parseInt(process.env.PORT ?? "3000", 10)
const CLAVE_ACCESO = process.env.ACCESS_KEY?.trim() || null
const MAX_MENSAJE = 4000
const DIR_WEB = path.join(ROOT, "web")
const DIR_OUT = path.join(ROOT, "out")

const config = leerConfig()
let casos = await listarCasos(ROOT)
const proveedor = crearProveedor(config, () => casos)
const sesiones = new AlmacenSesiones(path.join(DIR_OUT, "sesiones"))
const ocupadas = new Set<string>()

const ciclo: ConfigCiclo = {
  proveedor,
  sistema: await cargarSistema(ROOT, casos),
  directory: ROOT,
  maxIteraciones: Number.parseInt(process.env.MAX_ITERACIONES ?? "25", 10) || 25,
  maxTokensSesion: Number.parseInt(process.env.MAX_TOKENS_SESION ?? "300000", 10) || 300_000,
}

const ChatSchema = z.object({
  sessionId: IdSesionSchema.optional(),
  message: z.string().trim().min(1, "el mensaje está vacío").max(MAX_MENSAJE, `el mensaje supera ${MAX_MENSAJE} caracteres`),
})

const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

function json(res: ServerResponse, estado: number, cuerpo: unknown): void {
  res.writeHead(estado, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(cuerpo))
}

async function leerCuerpo(req: IncomingMessage, limite = 32_000): Promise<unknown> {
  let tam = 0
  const partes: Buffer[] = []
  for await (const parte of req) {
    const b = Buffer.isBuffer(parte) ? parte : Buffer.from(String(parte))
    tam += b.length
    if (tam > limite) throw new Error("cuerpo demasiado grande")
    partes.push(b)
  }
  return JSON.parse(Buffer.concat(partes).toString("utf8") || "{}")
}

function autorizado(req: IncomingMessage, url: URL): boolean {
  if (!CLAVE_ACCESO) return true
  const dada = req.headers["x-access-key"] ?? url.searchParams.get("key") ?? ""
  const a = Buffer.from(String(dada))
  const b = Buffer.from(CLAVE_ACCESO)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Sirve un archivo confinado a `base` (sin path traversal). */
async function servirArchivo(res: ServerResponse, base: string, relativa: string, descarga = false): Promise<void> {
  const destino = path.resolve(base, `.${path.sep}${decodeURIComponent(relativa)}`)
  if (!destino.startsWith(base + path.sep) && destino !== base) return json(res, 403, { error: "ruta no permitida" })
  try {
    const info = await stat(destino)
    const archivo = info.isDirectory() ? path.join(destino, "index.html") : destino
    const cuerpo = await readFile(archivo)
    const tipo = TIPOS[path.extname(archivo).toLowerCase()] ?? "application/octet-stream"
    res.writeHead(200, {
      "content-type": tipo,
      "cache-control": "no-store",
      ...(descarga && !tipo.startsWith("text/markdown") && !tipo.startsWith("text/plain") && tipo !== "application/pdf" ? { "content-disposition": `attachment; filename="${path.basename(archivo)}"` } : {}),
    })
    res.end(cuerpo)
  } catch {
    json(res, 404, { error: "no encontrado" })
  }
}

async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let cuerpo: unknown
  try {
    cuerpo = await leerCuerpo(req)
  } catch {
    return json(res, 400, { error: "El cuerpo debe ser JSON válido de menos de 32 KB." })
  }
  const p = ChatSchema.safeParse(cuerpo)
  if (!p.success) return json(res, 400, { error: `Petición inválida: ${p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` })

  const id = p.data.sessionId ?? randomUUID()
  if (ocupadas.has(id)) return json(res, 409, { error: "Esta sesión ya está procesando un mensaje; espera la respuesta." })
  ocupadas.add(id)
  try {
    casos = await listarCasos(ROOT)
    const sesion = await sesiones.obtenerOCrear(id)
    const r = await procesarTurno(sesion, p.data.message, ciclo)
    await sesiones.guardar(sesion)
    json(res, 200, r)
  } catch (e) {
    console.error("[chat] error:", e instanceof Error ? e.message : e)
    json(res, 500, { error: "Ocurrió un error interno procesando el mensaje. La sesión sigue disponible.", sessionId: id })
  } finally {
    ocupadas.delete(id)
  }
}

async function enrutar(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost")
  const ruta = url.pathname

  if (ruta === "/api/health" && req.method === "GET") {
    return json(res, 200, { ok: true, provider: proveedor.nombre, model: proveedor.modelo, modo: proveedor.nombre === "local" ? "determinista" : "llm", auth: CLAVE_ACCESO !== null })
  }
  if (ruta.startsWith("/api/") || ruta.startsWith("/out/")) {
    if (!autorizado(req, url)) return json(res, 401, { error: "Falta la clave de acceso (cabecera x-access-key)." })
  }
  if (ruta === "/api/chat" && req.method === "POST") return chat(req, res)
  if (ruta === "/api/casos" && req.method === "GET") return json(res, 200, { casos: await listarCasos(ROOT) })

  const sesion = ruta.match(/^\/api\/sessions\/([^/]+)$/)
  if (sesion && req.method === "GET") {
    const id = IdSesionSchema.safeParse(decodeURIComponent(sesion[1] ?? ""))
    if (!id.success) return json(res, 400, { error: "id de sesión inválido" })
    const s = await sesiones.obtener(id.data)
    if (!s) return json(res, 404, { error: "sesión no encontrada" })
    return json(res, 200, { id: s.id, creada: s.creada, turnos: s.turnos, tokens: s.tokens, needsConfirmation: s.confirmacionPendiente !== null, confirmacionPendiente: s.confirmacionPendiente })
  }
  if (ruta.startsWith("/out/") && req.method === "GET") {
    if (ruta.startsWith("/out/sesiones")) return json(res, 403, { error: "ruta no permitida" })
    return servirArchivo(res, DIR_OUT, ruta.slice("/out/".length), true)
  }
  if (ruta.startsWith("/api/")) return json(res, 404, { error: "ruta no encontrada" })
  if (req.method === "GET") return servirArchivo(res, DIR_WEB, ruta === "/" ? "index.html" : ruta.slice(1))
  json(res, 405, { error: "método no permitido" })
}

const servidor = createServer((req, res) => {
  enrutar(req, res).catch((e: unknown) => {
    console.error("[http] error:", e instanceof Error ? e.message : e)
    if (!res.headersSent) json(res, 500, { error: "error interno" })
  })
})

servidor.listen(PUERTO, () => {
  console.log(`Agente Registro como Proveedor en http://localhost:${PUERTO}`)
  console.log(`Proveedor: ${proveedor.nombre} · modelo: ${proveedor.modelo}${proveedor.nombre === "local" ? " (sin API key: modo determinista)" : " (con respaldo determinista)"}`)
  console.log(`Casos: ${casos.join(", ")} · tope ${ciclo.maxIteraciones} iteraciones/turno · ${ciclo.maxTokensSesion} tokens/sesión${CLAVE_ACCESO ? " · protegido con ACCESS_KEY" : ""}`)
})
