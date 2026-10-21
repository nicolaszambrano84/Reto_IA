import { ErrorProveedor, type LlamadaHerramienta, type ProveedorLLM } from "../llm/adapter"
import { esConfirmacion, PREGUNTA_CONFIRMACION } from "../llm/local"
import { DEFINICIONES, HERRAMIENTA_ENVIO, HERRAMIENTA_PAQUETE, HERRAMIENTAS } from "./herramientas"
import type { LlamadaVisible, Sesion } from "./sesiones"

export interface ConfigCiclo {
  proveedor: ProveedorLLM
  sistema: string
  directory: string
  /** CA1: tope de iteraciones modelo → herramientas por turno. */
  maxIteraciones: number
  /** Tope de tokens (entrada + salida) por sesión, para que nadie gaste la clave sin límite. */
  maxTokensSesion: number
}

export interface RespuestaTurno {
  sessionId: string
  reply: string
  toolCalls: LlamadaVisible[]
  needsConfirmation: boolean
  avisos: string[]
  provider: string
  model: string
  tokens: { entrada: number; salida: number }
}

function parseResultado(texto: string): { ok: boolean; valor: unknown } {
  try {
    const v: unknown = JSON.parse(texto)
    if (typeof v === "object" && v !== null && "ok" in v) {
      return { ok: v.ok === true, valor: v.ok === true && "data" in v ? v.data : "error" in v ? v.error : v }
    }
  } catch {
    // resultado no JSON: se muestra tal cual
  }
  return { ok: false, valor: texto }
}

/**
 * RN4 en el servidor, no solo en el prompt: `simular_envio` con confirmado=true solo pasa si
 * en el turno anterior se pidió confirmación para ese caso y el mensaje actual la da.
 */
function aplicarCompuerta(l: LlamadaHerramienta, ventana: Sesion["confirmacionPendiente"], confirmaAhora: boolean): { args: Record<string, unknown>; bloqueada: boolean } {
  if (l.nombre !== HERRAMIENTA_ENVIO || l.argumentos.confirmado !== true) return { args: l.argumentos, bloqueada: false }
  const permitido = ventana !== null && ventana.caso === l.argumentos.caso && confirmaAhora
  return permitido ? { args: l.argumentos, bloqueada: false } : { args: { ...l.argumentos, confirmado: false }, bloqueada: true }
}

function resumenTope(llamadas: LlamadaVisible[], max: number): string {
  const hechas = [...new Set(llamadas.filter((l) => l.ok).map((l) => l.nombre))]
  const fallidas = [...new Set(llamadas.filter((l) => !l.ok).map((l) => l.nombre))]
  return [
    `Alcancé el tope de ${max} iteraciones en este turno y me detuve.`,
    `Hecho: ${hechas.join(", ") || "nada"}.`,
    ...(fallidas.length ? [`Con error: ${fallidas.join(", ")}.`] : []),
    "Pídeme continuar si quieres que siga desde aquí.",
  ].join("\n")
}

/** Ejecuta un turno completo: mensaje del usuario → (modelo → herramientas)* → respuesta. */
export async function procesarTurno(sesion: Sesion, mensaje: string, cfg: ConfigCiclo): Promise<RespuestaTurno> {
  const ventana = sesion.confirmacionPendiente
  sesion.confirmacionPendiente = null
  const confirmaAhora = esConfirmacion(mensaje)
  const ahora = () => new Date().toISOString()

  sesion.mensajes.push({ rol: "usuario", contenido: mensaje })
  sesion.turnos.push({ rol: "usuario", contenido: mensaje, ts: ahora() })

  const llamadas: LlamadaVisible[] = []
  const avisos: string[] = []
  let pendiente: Sesion["confirmacionPendiente"] = null
  let reply = ""
  let iteraciones = 0

  while (true) {
    const gastados = sesion.tokens.entrada + sesion.tokens.salida
    if (gastados >= cfg.maxTokensSesion) {
      reply = `Esta sesión alcanzó el tope de ${cfg.maxTokensSesion.toLocaleString("es-CO")} tokens. Abre una sesión nueva para continuar.`
      break
    }
    if (iteraciones >= cfg.maxIteraciones) {
      reply = resumenTope(llamadas, cfg.maxIteraciones)
      break
    }
    iteraciones++

    let r
    try {
      r = await cfg.proveedor.enviar([{ rol: "sistema", contenido: cfg.sistema }, ...sesion.mensajes], DEFINICIONES)
    } catch (e) {
      // CA5: el error se muestra claro y la sesión sigue viva.
      reply = e instanceof ErrorProveedor ? `No pude completar la respuesta: ${e.message}` : "No pude completar la respuesta por un error inesperado del proveedor."
      break
    }
    // Basta con el primer aviso del turno (p. ej. el motivo de la caída del proveedor).
    if (r.aviso && avisos.length === 0) avisos.push(r.aviso)
    sesion.tokens.entrada += r.uso.entrada
    sesion.tokens.salida += r.uso.salida
    sesion.mensajes.push({ rol: "asistente", contenido: r.texto, llamadas: r.llamadas, crudo: r.crudo })

    if (r.llamadas.length === 0) {
      reply = r.texto
      break
    }

    for (const l of r.llamadas) {
      const inicio = Date.now()
      const { args, bloqueada } = aplicarCompuerta(l, ventana, confirmaAhora)
      const h = HERRAMIENTAS.get(l.nombre)
      const salida = h
        ? await h.ejecutar(args, { directory: cfg.directory, sessionId: sesion.id })
        : JSON.stringify({ ok: false, error: `La herramienta "${l.nombre}" no existe. Disponibles: ${[...HERRAMIENTAS.keys()].join(", ")}.` })
      sesion.mensajes.push({ rol: "herramienta", idLlamada: l.id, nombre: l.nombre, contenido: salida })
      const res = parseResultado(salida)
      llamadas.push({ id: l.id, nombre: l.nombre, argumentos: args, ok: res.ok, resultado: res.valor, duracionMs: Date.now() - inicio, ...(bloqueada ? { bloqueadaPorConfirmacion: true } : {}) })

      const caso = typeof args.caso === "string" ? args.caso : null
      if (caso && l.nombre === HERRAMIENTA_PAQUETE && res.ok) pendiente = { caso }
      if (caso && l.nombre === HERRAMIENTA_ENVIO) pendiente = res.ok ? null : bloqueada || args.confirmado === false ? { caso } : pendiente
    }
  }

  // CA3: si hay una acción esperando confirmación, el turno termina con una pregunta explícita.
  if (pendiente && !reply.trim().split("\n").slice(-3).join(" ").includes("?")) {
    reply = `${reply.trim()}\n\n${PREGUNTA_CONFIRMACION(pendiente.caso)}`
  }
  sesion.confirmacionPendiente = pendiente
  const respuesta = reply.trim() || "(sin respuesta del modelo)"
  sesion.turnos.push({ rol: "asistente", contenido: respuesta, ts: ahora(), llamadas, needsConfirmation: pendiente !== null, avisos, proveedor: cfg.proveedor.nombre })

  return {
    sessionId: sesion.id,
    reply: respuesta,
    toolCalls: llamadas,
    needsConfirmation: pendiente !== null,
    avisos,
    provider: cfg.proveedor.nombre,
    model: cfg.proveedor.modelo,
    tokens: { ...sesion.tokens },
  }
}
