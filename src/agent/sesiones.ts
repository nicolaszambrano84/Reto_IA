import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import type { Mensaje } from "../llm/adapter"

export interface LlamadaVisible {
  id: string
  nombre: string
  argumentos: Record<string, unknown>
  ok: boolean
  /** Resultado completo de la herramienta (`data` o `error`). */
  resultado: unknown
  duracionMs: number
  /** La compuerta RN4 cambió `confirmado` a false porque no hubo confirmación en el turno anterior. */
  bloqueadaPorConfirmacion?: boolean
}

export interface Turno {
  rol: "usuario" | "asistente"
  contenido: string
  ts: string
  llamadas?: LlamadaVisible[]
  needsConfirmation?: boolean
  avisos?: string[]
  proveedor?: string
}

export interface Sesion {
  id: string
  creada: string
  mensajes: Mensaje[]
  turnos: Turno[]
  tokens: { entrada: number; salida: number }
  /** Caso cuya acción externa espera confirmación en el próximo mensaje del usuario (RN4). */
  confirmacionPendiente: { caso: string } | null
}

export const IdSesionSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

const SesionSchema = z.object({
  id: z.string(),
  creada: z.string(),
  mensajes: z.array(z.custom<Mensaje>((v) => typeof v === "object" && v !== null && "rol" in v)),
  turnos: z.array(z.custom<Turno>((v) => typeof v === "object" && v !== null && "rol" in v)),
  tokens: z.object({ entrada: z.number(), salida: z.number() }),
  confirmacionPendiente: z.object({ caso: z.string() }).nullable(),
})

/** Sesiones en memoria con copia en out/sesiones/ para sobrevivir reinicios (sin base de datos). */
export class AlmacenSesiones {
  private readonly memoria = new Map<string, Sesion>()

  constructor(private readonly dir: string) {}

  private ruta(id: string): string {
    return path.join(this.dir, `${id}.json`)
  }

  async obtener(id: string): Promise<Sesion | null> {
    const enMemoria = this.memoria.get(id)
    if (enMemoria) return enMemoria
    try {
      const r = SesionSchema.safeParse(JSON.parse(await readFile(this.ruta(id), "utf8")))
      if (!r.success) return null
      this.memoria.set(id, r.data)
      return r.data
    } catch {
      return null
    }
  }

  async obtenerOCrear(id: string): Promise<Sesion> {
    const existente = await this.obtener(id)
    if (existente) return existente
    const nueva: Sesion = { id, creada: new Date().toISOString(), mensajes: [], turnos: [], tokens: { entrada: 0, salida: 0 }, confirmacionPendiente: null }
    this.memoria.set(id, nueva)
    return nueva
  }

  async guardar(s: Sesion): Promise<void> {
    this.memoria.set(s.id, s)
    try {
      await mkdir(this.dir, { recursive: true })
      await writeFile(this.ruta(s.id), JSON.stringify(s), "utf8")
    } catch {
      // La memoria basta; el archivo es solo una copia.
    }
  }
}
