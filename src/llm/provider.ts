import { ErrorProveedor, type DefinicionHerramienta, type Mensaje, type ProveedorLLM, type RespuestaModelo } from "./adapter"
import { ProveedorAnthropic } from "./anthropic"
import { ProveedorGemini } from "./gemini"
import { ProveedorLocal } from "./local"
import { ProveedorOpenAI } from "./openai"

export type NombreProveedor = "anthropic" | "openai" | "gemini" | "local"

export interface ConfigLLM {
  proveedor: NombreProveedor
  modelo: string
  apiKey: string | null
  timeoutMs: number
  esfuerzo: "low" | "medium" | "high" | "xhigh" | "max"
  baseUrlOpenAI?: string
}

const MODELO_POR_DEFECTO: Record<NombreProveedor, string> = {
  anthropic: "claude-opus-5-5",
  openai: "gpt-4.1-mini",
  gemini: "gemini-2.5-flash",
  local: "determinista-v1",
}

const VARIABLE_CLAVE: Record<Exclude<NombreProveedor, "local">, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
}

const VARIABLE_MODELO: Record<Exclude<NombreProveedor, "local">, string> = {
  anthropic: "ANTHROPIC_MODEL",
  openai: "OPENAI_MODEL",
  gemini: "GEMINI_MODEL",
}

const ORDEN_AUTO: Array<Exclude<NombreProveedor, "local">> = ["anthropic", "openai", "gemini"]

function entero(v: string | undefined, porDefecto: number): number {
  const n = Number.parseInt(v ?? "", 10)
  return Number.isFinite(n) && n > 0 ? n : porDefecto
}

/** Proveedor al que pertenece un nombre de modelo, para no mandar p. ej. un modelo Claude a Gemini. */
function proveedorDelModelo(modelo: string): Exclude<NombreProveedor, "local"> {
  if (modelo.startsWith("claude")) return "anthropic"
  if (modelo.startsWith("gemini")) return "gemini"
  return "openai"
}

/** Modelo: `<PROVEEDOR>_MODEL`, luego `LLM_MODEL` si corresponde a ese proveedor, luego el de por defecto. */
function elegirModelo(env: NodeJS.ProcessEnv, p: Exclude<NombreProveedor, "local">): string {
  const especifico = env[VARIABLE_MODELO[p]]?.trim()
  if (especifico) return especifico
  const generico = env.LLM_MODEL?.trim()
  if (generico && proveedorDelModelo(generico) === p) return generico
  return MODELO_POR_DEFECTO[p]
}

/**
 * Lee la configuración de variables de entorno. Usa el proveedor pedido en `LLM_PROVIDER` si tiene
 * clave; si no (o con `auto`), el primero que tenga clave en el orden anthropic → openai → gemini.
 * Sin ninguna clave, o con `LLM_PROVIDER=local`, queda el modo determinista.
 */
export function leerConfig(env: NodeJS.ProcessEnv = process.env): ConfigLLM {
  const pedido = (env.LLM_PROVIDER ?? "auto").trim().toLowerCase()
  const tieneClave = (p: Exclude<NombreProveedor, "local">) => (env[VARIABLE_CLAVE[p]] ?? "").trim() !== ""
  const preferido = ORDEN_AUTO.find((p) => p === pedido)
  const elegido = pedido === "local" ? undefined : preferido && tieneClave(preferido) ? preferido : ORDEN_AUTO.find(tieneClave)
  const proveedor: NombreProveedor = elegido ?? "local"
  const esfuerzo = env.LLM_EFFORT
  return {
    proveedor,
    modelo: elegido ? elegirModelo(env, elegido) : MODELO_POR_DEFECTO.local,
    apiKey: elegido ? (env[VARIABLE_CLAVE[elegido]] ?? "").trim() : null,
    timeoutMs: entero(env.LLM_TIMEOUT_MS, 45_000),
    esfuerzo: esfuerzo === "medium" || esfuerzo === "high" || esfuerzo === "xhigh" || esfuerzo === "max" ? esfuerzo : "low",
    baseUrlOpenAI: env.OPENAI_BASE_URL?.trim() || undefined,
  }
}

function crearRemoto(c: ConfigLLM, apiKey: string): ProveedorLLM {
  if (c.proveedor === "anthropic") return new ProveedorAnthropic(apiKey, c.modelo, c.timeoutMs, c.esfuerzo)
  if (c.proveedor === "openai") return new ProveedorOpenAI(apiKey, c.modelo, c.timeoutMs, c.baseUrlOpenAI)
  return new ProveedorGemini(apiKey, c.modelo, c.timeoutMs)
}

/**
 * Envuelve el proveedor remoto: si falla (red, timeout, 5xx, cuota), responde el modo determinista
 * y deja un aviso visible. Tras un fallo, se usa el respaldo durante `pausaMs` para no esperar
 * un timeout en cada iteración del ciclo.
 */
export class ProveedorConRespaldo implements ProveedorLLM {
  private fallaHasta = 0

  constructor(
    private readonly principal: ProveedorLLM,
    private readonly respaldo: ProveedorLLM,
    private readonly pausaMs = 60_000,
  ) {}

  get nombre(): string {
    return this.principal.nombre
  }
  get modelo(): string {
    return this.principal.modelo
  }

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaModelo> {
    if (Date.now() < this.fallaHasta) {
      return { ...(await this.respaldo.enviar(mensajes, herramientas)), aviso: `El proveedor ${this.principal.nombre} falló hace poco; respondo en modo determinista.` }
    }
    try {
      return await this.principal.enviar(mensajes, herramientas)
    } catch (e) {
      const motivo = e instanceof ErrorProveedor ? e.message : `Falló el proveedor ${this.principal.nombre}.`
      this.fallaHasta = Date.now() + this.pausaMs
      return { ...(await this.respaldo.enviar(mensajes, herramientas)), aviso: `${motivo} Continúo en modo determinista con las mismas herramientas.` }
    }
  }
}

export function crearProveedor(config: ConfigLLM, casos: () => string[]): ProveedorLLM {
  const local = new ProveedorLocal(casos)
  if (config.proveedor === "local" || !config.apiKey) return local
  return new ProveedorConRespaldo(crearRemoto(config, config.apiKey), local)
}
