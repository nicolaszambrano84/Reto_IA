import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { DIR_OUT, existe, dirSalidaCaso } from "./fixtures"
import { ErrorHerramienta, type ContextoHerramienta } from "./tipos"

interface LineaLog {
  ts: string
  herramienta: string
  ok: boolean
  resumen: string
  caso?: string
  sessionId: string
}

/** RN5 / CA4: una línea por ejecución en out/log.jsonl y, si el caso existe, en out/<caso>/log.jsonl. */
export async function registrar(ctx: ContextoHerramienta, linea: LineaLog, casoValido: boolean): Promise<void> {
  try {
    const out = path.join(ctx.directory, DIR_OUT)
    await mkdir(out, { recursive: true })
    const json = `${JSON.stringify(linea)}\n`
    await appendFile(path.join(out, "log.jsonl"), json, "utf8")
    if (linea.caso && casoValido) {
      const dir = dirSalidaCaso(ctx.directory, linea.caso)
      await mkdir(dir, { recursive: true })
      await appendFile(path.join(dir, "log.jsonl"), json, "utf8")
    }
  } catch {
    // El registro nunca debe tumbar la herramienta.
  }
}

export interface Exito<T> {
  data: T
  resumen: string
}

/**
 * Ejecuta el cuerpo de una herramienta con el contrato del PRD:
 * valida argumentos con zod, nunca lanza, siempre devuelve `{ ok, data }` o `{ ok: false, error }` serializado
 * y deja registro RN5.
 */
export async function ejecutar<A extends z.ZodRawShape, T>(
  herramienta: string,
  esquema: A,
  argsCrudos: unknown,
  ctx: ContextoHerramienta,
  cuerpo: (args: z.infer<z.ZodObject<A>>) => Promise<Exito<T>>,
): Promise<string> {
  const ts = new Date().toISOString()
  const casoCrudo = typeof argsCrudos === "object" && argsCrudos !== null && "caso" in argsCrudos ? argsCrudos.caso : undefined
  const caso = typeof casoCrudo === "string" && /^[a-z0-9][a-z0-9-]{0,80}$/.test(casoCrudo) ? casoCrudo : undefined
  const casoValido = caso !== undefined && (await existe(path.join(ctx.directory, "fixtures", "reto-01", "casos", caso)))

  let respuesta: { ok: true; data: T } | { ok: false; error: string }
  let resumen: string
  const parsed = z.object(esquema).safeParse(argsCrudos)
  if (!parsed.success) {
    const error = `Argumentos inválidos para ${herramienta}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ")}`
    respuesta = { ok: false, error }
    resumen = error
  } else {
    try {
      const r = await cuerpo(parsed.data)
      respuesta = { ok: true, data: r.data }
      resumen = r.resumen
    } catch (e) {
      const error = e instanceof ErrorHerramienta ? e.message : `Error inesperado en ${herramienta}: ${e instanceof Error ? e.message : String(e)}`
      respuesta = { ok: false, error }
      resumen = error
    }
  }
  await registrar(ctx, { ts, herramienta, ok: respuesta.ok, resumen, caso, sessionId: ctx.sessionId }, casoValido)
  return JSON.stringify(respuesta)
}

/** Fecha de ejecución (YYYY-MM-DD, hora local). `FECHA_EJECUCION` permite fijarla para pruebas reproducibles. */
export function fechaEjecucion(): string {
  const fija = process.env.FECHA_EJECUCION
  if (fija && /^\d{4}-\d{2}-\d{2}$/.test(fija)) return fija
  return new Date().toLocaleDateString("sv-SE")
}
