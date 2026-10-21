import { argumentosDe, describirFallo, ErrorProveedor, sistemaDe, type DefinicionHerramienta, type Mensaje, type ProveedorLLM, type RespuestaModelo } from "./adapter"

type MensajeOpenAI =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string }

interface RespuestaOpenAI {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string }
}

function aMensajes(mensajes: Mensaje[]): MensajeOpenAI[] {
  const salida: MensajeOpenAI[] = [{ role: "system", content: sistemaDe(mensajes) }]
  for (const m of mensajes) {
    if (m.rol === "usuario") salida.push({ role: "user", content: m.contenido })
    else if (m.rol === "asistente") {
      salida.push({
        role: "assistant",
        content: m.contenido || null,
        ...(m.llamadas.length
          ? { tool_calls: m.llamadas.map((l) => ({ id: l.id, type: "function" as const, function: { name: l.nombre, arguments: JSON.stringify(l.argumentos) } })) }
          : {}),
      })
    } else if (m.rol === "herramienta") salida.push({ role: "tool", tool_call_id: m.idLlamada, content: m.contenido })
  }
  return salida
}

/** Chat Completions vía fetch nativo (sin SDK: una sola llamada HTTP). */
export class ProveedorOpenAI implements ProveedorLLM {
  readonly nombre = "openai"

  constructor(
    private readonly apiKey: string,
    readonly modelo: string,
    private readonly timeoutMs: number,
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {}

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaModelo> {
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: this.modelo,
          messages: aMensajes(mensajes),
          tools: herramientas.map((h) => ({ type: "function", function: { name: h.nombre, description: h.descripcion, parameters: h.parametros } })),
        }),
      })
      const json = (await res.json()) as RespuestaOpenAI
      if (!res.ok) throw new ErrorProveedor(`OpenAI respondió ${res.status}: ${json.error?.message ?? "error desconocido"}`)
      const msg = json.choices?.[0]?.message
      return {
        texto: msg?.content?.trim() ?? "",
        llamadas: (msg?.tool_calls ?? []).map((t) => ({ id: t.id, nombre: t.function.name, argumentos: argumentosDe(t.function.arguments) })),
        uso: { entrada: json.usage?.prompt_tokens ?? 0, salida: json.usage?.completion_tokens ?? 0 },
      }
    } catch (e) {
      throw describirFallo("OpenAI", e, this.timeoutMs)
    }
  }
}
