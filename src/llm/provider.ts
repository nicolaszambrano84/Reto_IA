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

function entero(v: string | undefined, porDefecto: number): number {
  const n = Number.parseInt(v ?? "", 10)
  return Number.isFinite(n) && n > 0 ? n : porDefecto
}

/** Lee la configuración de variables de entorno. `LLM_PROVIDER=auto` elige el primero con clave. */
export function leerConfig(env: NodeJS.ProcessEnv = process.env): ConfigLLM {
  const pedido = (env.LLM_PROVIDER ?? "auto").toLowerCase()
  const candidatos: Array<Exclude<NombreProveedor, "local">> =
    pedido === "anthropic" || pedido === "openai" || pedido === "gemini" ? [pedido] : ["anthropic", "openai", "gemini"]
  const elegido = pedido === "local" ? undefined : candidatos.find((p) => (env[VARIABLE_CLAVE[p]] ?? "").trim() !== "")
  const proveedor: NombreProveedor = elegido ?? "local"
  const esfuerzo = env.LLM_EFFORT
  return {
    proveedor,
    modelo: (proveedor !== "local" && env.LLM_MODEL?.trim()) || MODELO_POR_DEFECTO[proveedor],
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
