import Anthropic from "@anthropic-ai/sdk"
import { describirFallo, sistemaDe, type DefinicionHerramienta, type Mensaje, type ProveedorLLM, type RespuestaModelo } from "./adapter"

type Esfuerzo = "low" | "medium" | "high" | "xhigh" | "max"

function esBloques(v: unknown): v is Anthropic.Beta.BetaContentBlockParam[] {
  return Array.isArray(v) && v.every((b) => typeof b === "object" && b !== null && "type" in b)
}

/** Convierte el historial propio al formato de Messages API; agrupa resultados de herramientas en un solo turno. */
function aMensajes(mensajes: Mensaje[]): Anthropic.Beta.BetaMessageParam[] {
  const salida: Anthropic.Beta.BetaMessageParam[] = []
  for (const m of mensajes) {
    if (m.rol === "sistema") continue
    if (m.rol === "usuario") salida.push({ role: "user", content: m.contenido })
    else if (m.rol === "asistente") {
      // Los bloques originales (incluido thinking) se devuelven sin cambios.
      if (m.crudo?.proveedor === "anthropic" && esBloques(m.crudo.valor)) {
        salida.push({ role: "assistant", content: m.crudo.valor })
        continue
      }
      const bloques: Anthropic.Beta.BetaContentBlockParam[] = []
      if (m.contenido) bloques.push({ type: "text", text: m.contenido })
      for (const l of m.llamadas) bloques.push({ type: "tool_use", id: l.id, name: l.nombre, input: l.argumentos })
      salida.push({ role: "assistant", content: bloques.length ? bloques : "…" })
    } else {
      const resultado: Anthropic.Beta.BetaToolResultBlockParam = { type: "tool_result", tool_use_id: m.idLlamada, content: m.contenido }
      const ultimo = salida.at(-1)
      if (ultimo?.role === "user" && Array.isArray(ultimo.content) && ultimo.content.every((b) => b.type === "tool_result")) {
        ultimo.content.push(resultado)
      } else salida.push({ role: "user", content: [resultado] })
    }
  }
  return salida
}

export class ProveedorAnthropic implements ProveedorLLM {
  readonly nombre = "anthropic"
  private readonly cliente: Anthropic

  constructor(
    apiKey: string,
    readonly modelo: string,
    private readonly timeoutMs: number,
    private readonly esfuerzo: Esfuerzo,
  ) {
    this.cliente = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 })
  }

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaModelo> {
    try {
      const r = await this.cliente.beta.messages.create({
        model: this.modelo,
        max_tokens: 16000,
        system: [{ type: "text", text: sistemaDe(mensajes), cache_control: { type: "ephemeral" } }],
        tools: herramientas.map((h) => ({
          name: h.nombre,
          description: h.descripcion,
          input_schema: { ...h.parametros, type: "object" },
        })),
        messages: aMensajes(mensajes),
        output_config: { effort: this.esfuerzo },
        // Si el modelo declina por política, el servidor reintenta con un modelo de respaldo.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      })
      if (r.stop_reason === "refusal") {
        return { texto: "El modelo declinó responder esta solicitud. Reformúlala o procesa el caso con la demo sin modelo.", llamadas: [], uso: { entrada: r.usage.input_tokens, salida: r.usage.output_tokens } }
      }
      const texto = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim()
      const llamadas = r.content.flatMap((b) =>
        b.type === "tool_use"
          ? [{ id: b.id, nombre: b.name, argumentos: typeof b.input === "object" && b.input !== null ? (b.input as Record<string, unknown>) : {} }]
          : [],
      )
      return {
        texto,
        llamadas,
        uso: { entrada: r.usage.input_tokens + (r.usage.cache_read_input_tokens ?? 0), salida: r.usage.output_tokens },
        crudo: { proveedor: "anthropic", valor: r.content },
      }
    } catch (e) {
      throw describirFallo("Anthropic", e, this.timeoutMs)
    }
  }
}
