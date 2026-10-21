import { randomUUID } from "node:crypto"
import type { DefinicionHerramienta, LlamadaHerramienta, Mensaje, ProveedorLLM, RespuestaModelo } from "./adapter"

/**
 * Proveedor determinista: implementa la misma interfaz que un LLM, pero decide con reglas.
 * Se usa cuando no hay API key o el proveedor remoto falla. Ejecuta las herramientas reales a través
 * del mismo ciclo del agente y solo redacta con datos que vienen de sus resultados.
 */

type Resultado = { ok: true; data: Record<string, unknown> } | { ok: false; error: string }
interface Ejecutada {
  argumentos: Record<string, unknown>
  resultado: Resultado
}

const PAISES: Record<string, string[]> = {
  co: ["colombia", "colombiano"],
  ec: ["ecuador", "ecuatoriano"],
  pe: ["peru", "peruano"],
  pa: ["panama", "panameno"],
  hn: ["honduras", "hondureno"],
}

function norm(t: string): string {
  return t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function parse(texto: string): Resultado {
  try {
    const v: unknown = JSON.parse(texto)
    if (typeof v === "object" && v !== null && "ok" in v) {
      if (v.ok === true && "data" in v && typeof v.data === "object" && v.data !== null) return { ok: true, data: v.data as Record<string, unknown> }
      if ("error" in v) return { ok: false, error: String(v.error) }
    }
  } catch {
    // cae al error genérico
  }
  return { ok: false, error: "respuesta de herramienta ilegible" }
}

function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null) : []
}

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : ""
}

export const PREGUNTA_CONFIRMACION = (caso: string) =>
  `¿Confirmas que simule el envío del paquete de \`${caso}\`? Responde «sí, envía» para continuar o dime qué quieres corregir.`

export function esConfirmacion(texto: string): boolean {
  const t = ` ${norm(texto)} `
  if (/ no | todavia | aun no | espera | cancela /.test(t)) return false
  return / (si|confirmo|confirmado|adelante|procede|dale|hazlo|de acuerdo|ok|okay|envia|envialo|enviar|enviarlo|simula) /.test(t)
}

export class ProveedorLocal implements ProveedorLLM {
  readonly nombre = "local"
  readonly modelo = "determinista-v1"

  constructor(private readonly casos: () => string[]) {}

  async enviar(mensajes: Mensaje[], _herramientas: DefinicionHerramienta[]): Promise<RespuestaModelo> {
    const iUsuario = mensajes.map((m) => m.rol).lastIndexOf("usuario")
    const usuario = mensajes[iUsuario]
    const texto = usuario && usuario.rol === "usuario" ? usuario.contenido : ""
    const hechas = this.ejecutadasEnTurno(mensajes.slice(iUsuario + 1))
    const caso = this.detectarCaso(texto) ?? this.casoEnContexto(mensajes.slice(0, iUsuario))
    const t = norm(texto)
    const pideProcesar = /\b(procesa|procesar|analiza|revisa|prepara|llena|genera|arma|estado|faltan?|listo)\b/.test(t) || this.detectarCaso(texto) !== null
    const confirma = esConfirmacion(texto) && !/\bno envies\b/.test(t)

    if (confirma && !pideProcesar && caso) return this.flujoEnvio(caso, hechas)
    if (caso && (pideProcesar || confirma)) return this.flujoProceso(caso, hechas, /\bno envie?s?\b|\bno (lo )?envies\b|\bno enviar\b/.test(t))
    return this.responder(this.ayuda())
  }

  private ejecutadasEnTurno(turno: Mensaje[]): Map<string, Ejecutada> {
    const llamadas = new Map<string, LlamadaHerramienta>()
    const hechas = new Map<string, Ejecutada>()
    for (const m of turno) {
      if (m.rol === "asistente") m.llamadas.forEach((l) => llamadas.set(l.id, l))
      if (m.rol === "herramienta") {
        const l = llamadas.get(m.idLlamada)
        hechas.set(m.nombre, { argumentos: l?.argumentos ?? {}, resultado: parse(m.contenido) })
      }
    }
    return hechas
  }

  private detectarCaso(texto: string): string | null {
    const t = ` ${norm(texto)} `
    const casos = this.casos()
    const exacto = casos.find((c) => t.includes(` ${norm(c)} `))
    if (exacto) return exacto
    let mejor: { caso: string; puntos: number } | null = null
    for (const c of casos) {
      const [pais = "", ...resto] = norm(c).split(" ")
      const puntos = resto.filter((p) => p.length > 3 && t.includes(` ${p} `)).length * 2 + ((PAISES[pais] ?? []).some((n) => t.includes(` ${n} `)) ? 1 : 0)
      if (puntos > 0 && (!mejor || puntos > mejor.puntos)) mejor = { caso: c, puntos }
    }
    return mejor?.caso ?? null
  }

  private casoEnContexto(previos: Mensaje[]): string | null {
    for (let i = previos.length - 1; i >= 0; i--) {
      const m = previos[i]
      if (m?.rol === "asistente") {
        const c = m.llamadas.map((l) => str(l.argumentos.caso)).find(Boolean)
        if (c) return c
      }
      if (m?.rol === "usuario") {
        const c = this.detectarCaso(m.contenido)
        if (c) return c
      }
    }
    return null
  }

  private llamar(nombre: string, argumentos: Record<string, unknown>, texto = ""): RespuestaModelo {
    return { texto, llamadas: [{ id: `local-${randomUUID()}`, nombre, argumentos }], uso: { entrada: 0, salida: 0 } }
  }

  private responder(texto: string): RespuestaModelo {
    return { texto, llamadas: [], uso: { entrada: 0, salida: 0 } }
  }

  private flujoProceso(caso: string, hechas: Map<string, Ejecutada>, noEnviar: boolean): RespuestaModelo {
    const leida = hechas.get("proveedor_leer_solicitud")
    if (!leida) return this.llamar("proveedor_leer_solicitud", { caso })
    if (!leida.resultado.ok) return this.responder(`No pude leer la solicitud: ${leida.resultado.error}`)

    const mapeo = hechas.get("proveedor_mapear_campos")
    if (!mapeo) {
      const campos = arr(leida.resultado.data.campos).map((c) => str(c.etiqueta)).filter(Boolean)
      return this.llamar("proveedor_mapear_campos", campos.length ? { caso, campos } : { caso })
    }
    if (!hechas.has("proveedor_generar_formulario")) {
      return this.llamar("proveedor_generar_formulario", mapeo.resultado.ok ? { caso, mapeo: mapeo.resultado.data } : { caso })
    }
    if (!hechas.has("proveedor_armar_paquete")) return this.llamar("proveedor_armar_paquete", { caso })
    return this.responder(this.resumenCaso(caso, hechas, noEnviar))
  }

  private flujoEnvio(caso: string, hechas: Map<string, Ejecutada>): RespuestaModelo {
    const envio = hechas.get("proveedor_simular_envio")
    if (!envio) return this.llamar("proveedor_simular_envio", { caso, confirmado: true })
    if (envio.resultado.ok) {
      const d = envio.resultado.data
      const bloqueos = Array.isArray(d.bloqueos_pendientes) ? d.bloqueos_pendientes.map(str) : []
      return this.responder(
        [
          `Listo. Simulé el envío del paquete de \`${caso}\`: quedó registrado en \`${str(d.ruta)}\`.`,
          "No se envió ningún correo real; la firma y el envío definitivo siguen siendo decisión humana.",
          ...(bloqueos.length ? ["", "**Ojo:** se simuló con bloqueos pendientes:", ...bloqueos.map((b) => `- ${b}`)] : []),
        ].join("\n"),
      )
    }
    if (envio.resultado.error === "requiere confirmación explícita") {
      return this.responder(`Para simular el envío necesito una confirmación explícita después de revisar el paquete.\n\n${PREGUNTA_CONFIRMACION(caso)}`)
    }
    return this.responder(`No pude simular el envío: ${envio.resultado.error}`)
  }

  private resumenCaso(caso: string, hechas: Map<string, Ejecutada>, noEnviar: boolean): string {
    const leida = hechas.get("proveedor_leer_solicitud")?.resultado
    const mapeo = hechas.get("proveedor_mapear_campos")?.resultado
    const form = hechas.get("proveedor_generar_formulario")?.resultado
    const paq = hechas.get("proveedor_armar_paquete")?.resultado
    const l = leida?.ok ? leida.data : {}
    const lineas: string[] = [
      `### Caso \`${caso}\` — ${str(l.cliente)} (${str(l.pais)}) · formato **${str(l.formato)}**`,
      "",
      `Archivos en \`out/${caso}/\`.`,
    ]
    const advertencias = Array.isArray(l.advertencias) ? l.advertencias.map(str).filter(Boolean) : []
    if (advertencias.length) lineas.push("", ...advertencias.map((a) => `> ⚠ ${a}`))

    if (form?.ok) {
      lineas.push(`- Formulario: \`${str(form.data.ruta)}\``)
      if (form.data.aviso) lineas.push(`- ⚠ ${str(form.data.aviso)}`)
    } else if (form) lineas.push(`- ⚠ El formulario no se generó: ${form.error}`)
    if (paq?.ok) lineas.push(`- Paquete para firma: \`${str(paq.data.ruta)}/\` (checklist.md, borrador-correo.md y soportes)`)

    if (mapeo?.ok) {
      const llenos = arr(mapeo.data.llenos)
      const faltantes = arr(mapeo.data.faltantes)
      const confirmar = arr(mapeo.data.requiere_confirmacion)
      lineas.push("", `**Campos llenos (${llenos.length}):** ${llenos.map((c) => str(c.etiqueta)).join(", ") || "ninguno"}.`)
      lineas.push(
        "",
        `**Faltantes (${faltantes.length}):**${faltantes.length ? "" : " ninguno."}`,
        ...faltantes.map((c) => `- ${str(c.etiqueta)}${c.obligatorio === true ? " (obligatorio)" : ""} — ${str(c.motivo)}`),
      )
      if (faltantes.length) lineas.push("  _No bloquean la firma, pero hay que completarlos a mano._")
      lineas.push("", `**Requieren confirmación (${confirmar.length}):**${confirmar.length ? "" : " ninguno."}`, ...confirmar.map((c) => `- ${str(c.etiqueta)} — ${str(c.nota)}`))
    } else if (mapeo) lineas.push("", `⚠ No pude mapear los campos: ${mapeo.error}`)

    if (paq?.ok) {
      const ch = (paq.data.checklist ?? {}) as Record<string, unknown>
      const sop = (ch.soportes ?? {}) as Record<string, unknown>
      const vencidos = arr(sop.vencidos)
      const ausentes = arr(sop.ausentes)
      const presentes = arr(sop.presentes)
      lineas.push("", "**Soportes:**")
      lineas.push(`- Vigentes: ${presentes.map((s) => str(s.nombre)).join(", ") || "ninguno"}`)
      if (vencidos.length) lineas.push(...vencidos.map((s) => `- **Vencido — actualizar:** ${str(s.nombre)} (venció el ${str(s.vigencia_hasta)})`))
      if (ausentes.length) lineas.push(...ausentes.map((s) => `- **Ausente — conseguir:** ${str(s.nombre)} (${str(s.motivo)})`))
      const listo = paq.data.listo_para_firma === true
      lineas.push("", `**Listo para firma: ${listo ? "SÍ" : "NO"}**${listo ? "" : ` — ${(Array.isArray(ch.bloqueos) ? ch.bloqueos.map(str) : []).join("; ")}`}`)
    } else if (paq) lineas.push("", `⚠ No pude armar el paquete: ${paq.error}`)

    lineas.push("", noEnviar ? "No envié nada, como pediste." : "No he enviado nada.")
    if (paq?.ok) lineas.push("", PREGUNTA_CONFIRMACION(caso))
    return lineas.join("\n")
  }

  private ayuda(): string {
    const casos = this.casos()
    return [
      "Puedo preparar el registro de Periferia como proveedor: leo la solicitud, lleno el formulario desde el maestro y armo el paquete para firma.",
      "",
      `Casos disponibles: ${casos.map((c) => `\`${c}\``).join(", ")}.`,
      "",
      'Prueba: "Procesa el caso ec-corp-andina".',
    ].join("\n")
  }
}
