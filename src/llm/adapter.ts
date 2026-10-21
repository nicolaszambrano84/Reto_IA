/**
 * Interfaz propia del proveedor de lenguaje (PRD §6.1). El ciclo del agente solo conoce estos tipos:
 * cambiar de proveedor no toca el ciclo.
 */

export interface LlamadaHerramienta {
  id: string
  nombre: string
  argumentos: Record<string, unknown>
}

/** Contenido opaco que un proveedor necesita recibir de vuelta tal cual (bloques de thinking, firmas…). */
export interface ContenidoCrudo {
  proveedor: string
  valor: unknown
}

export type Mensaje =
  | { rol: "sistema"; contenido: string }
  | { rol: "usuario"; contenido: string }
  | { rol: "asistente"; contenido: string; llamadas: LlamadaHerramienta[]; crudo?: ContenidoCrudo }
  | { rol: "herramienta"; idLlamada: string; nombre: string; contenido: string }

export interface DefinicionHerramienta {
  nombre: string
  descripcion: string
  /** JSON Schema del objeto de argumentos (derivado de los esquemas zod). */
  parametros: Record<string, unknown>
}

export interface RespuestaModelo {
  texto: string
  llamadas: LlamadaHerramienta[]
  uso: { entrada: number; salida: number }
  crudo?: ContenidoCrudo
  /** Aviso para el usuario (p. ej. se usó el modo determinista porque el proveedor falló). */
  aviso?: string
}

export interface ProveedorLLM {
  readonly nombre: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaModelo>
}

/** Error del proveedor con un mensaje apto para mostrar en el chat (sin claves ni trazas). */
export class ErrorProveedor extends Error {
  override name = "ErrorProveedor"
}

export function sistemaDe(mensajes: Mensaje[]): string {
  return mensajes
    .filter((m): m is Extract<Mensaje, { rol: "sistema" }> => m.rol === "sistema")
    .map((m) => m.contenido)
    .join("\n\n")
}

export function argumentosDe(texto: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(texto || "{}")
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Traduce fallos de red/HTTP a un mensaje claro. Nunca incluye la clave. */
export function describirFallo(proveedor: string, e: unknown, timeoutMs: number): ErrorProveedor {
  if (e instanceof ErrorProveedor) return e
  const nombre = e instanceof Error ? e.name : ""
  if (nombre === "TimeoutError" || nombre === "AbortError" || /timed? ?out/i.test(String(e))) {
    return new ErrorProveedor(`El proveedor ${proveedor} no respondió en ${Math.round(timeoutMs / 1000)} s.`)
  }
  const msg = e instanceof Error ? e.message : String(e)
  return new ErrorProveedor(`Falló la llamada a ${proveedor}: ${msg.replace(/(sk|key|AIza)[-_A-Za-z0-9]{8,}/g, "[oculto]").slice(0, 300)}`)
}
