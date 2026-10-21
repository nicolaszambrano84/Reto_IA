import { randomUUID } from "node:crypto"
import { argumentosDe, describirFallo, ErrorProveedor, sistemaDe, type DefinicionHerramienta, type Mensaje, type ProveedorLLM, type RespuestaModelo } from "./adapter"

interface Parte {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { name: string; args?: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
}
interface Contenido {
  role: "user" | "model"
  parts: Parte[]
}
interface RespuestaGemini {
  candidates?: Array<{ content?: { parts?: Parte[] } }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  error?: { message?: string }
}

function esPartes(v: unknown): v is Parte[] {
  return Array.isArray(v) && v.every((p) => typeof p === "object" && p !== null)
}

function aContenidos(mensajes: Mensaje[]): Contenido[] {
  const salida: Contenido[] = []
  for (const m of mensajes) {
    if (m.rol === "usuario") salida.push({ role: "user", parts: [{ text: m.contenido }] })
    else if (m.rol === "asistente") {
      // Gemini exige devolver las partes originales (con thoughtSignature) en llamadas a funciones.
      const partes =
        m.crudo?.proveedor === "gemini" && esPartes(m.crudo.valor)
          ? m.crudo.valor
          : [...(m.contenido ? [{ text: m.contenido }] : []), ...m.llamadas.map((l) => ({ functionCall: { name: l.nombre, args: l.argumentos } }))]
      salida.push({ role: "model", parts: partes.length ? partes : [{ text: "…" }] })
    } else if (m.rol === "herramienta") {
      const parte: Parte = { functionResponse: { name: m.nombre, response: { resultado: argumentosDe(m.contenido) } } }
      const ultimo = salida.at(-1)
      if (ultimo?.role === "user" && ultimo.parts.every((p) => p.functionResponse)) ultimo.parts.push(parte)
      else salida.push({ role: "user", parts: [parte] })
    }
  }
  return salida
}

/** Gemini generateContent vía fetch nativo. */
export class ProveedorGemini implements ProveedorLLM {
  readonly nombre = "gemini"

  constructor(
    private readonly apiKey: string,
    readonly modelo: string,
    private readonly timeoutMs: number,
  ) {}

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaModelo> {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.modelo)}:generateContent`
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: sistemaDe(mensajes) }] },
          contents: aContenidos(mensajes),
          tools: [{ functionDeclarations: herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, parametersJsonSchema: h.parametros })) }],
        }),
      })
      const json = (await res.json()) as RespuestaGemini
      if (!res.ok) throw new ErrorProveedor(`Gemini respondió ${res.status}: ${json.error?.message ?? "error desconocido"}`)
      const partes = json.candidates?.[0]?.content?.parts ?? []
      return {
        texto: partes.filter((p) => p.text && !p.thought).map((p) => p.text).join("\n").trim(),
        llamadas: partes.flatMap((p) => (p.functionCall ? [{ id: randomUUID(), nombre: p.functionCall.name, argumentos: p.functionCall.args ?? {} }] : [])),
        uso: { entrada: json.usageMetadata?.promptTokenCount ?? 0, salida: json.usageMetadata?.candidatesTokenCount ?? 0 },
        crudo: { proveedor: "gemini", valor: partes },
      }
    } catch (e) {
      throw describirFallo("Gemini", e, this.timeoutMs)
    }
  }
}
