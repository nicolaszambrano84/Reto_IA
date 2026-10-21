import type { CampoSolicitado, Maestro, ValorJson } from "./fixtures"
import { reglas } from "./fixtures"
import type { EstadoCampo } from "./tipos"

export interface CampoMapeado {
  etiqueta: string
  estado: EstadoCampo
  /** Ruta del dato en el maestro (`representante_legal.nombre`), o null si no hay fuente. */
  ruta: string | null
  /** Valor real del maestro. Solo se usa para escribir archivos; nunca se inventa. */
  valor: string | null
  confianza: number
  metodo: "glosario" | "glosario_normalizado" | "clave_maestro" | "aproximado" | "sin_fuente"
  nota?: string
  obligatorio?: boolean
  sensible?: boolean
}

export interface Mapeo {
  pais: string
  campos: CampoMapeado[]
}

const PALABRAS_VACIAS = new Set(["de", "del", "la", "el", "los", "las", "y", "o", "en", "a"])

export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function fichas(texto: string): Set<string> {
  return new Set(normalizar(texto).split(" ").filter((t) => t && !PALABRAS_VACIAS.has(t)))
}

function similitud(a: string, b: string): number {
  const fa = fichas(a)
  const fb = fichas(b)
  const comunes = [...fa].filter((t) => fb.has(t)).length
  const union = new Set([...fa, ...fb]).size
  return union === 0 ? 0 : comunes / union
}

/** Busca una ruta del maestro por camino con puntos. */
export function valorEnRuta(maestro: Maestro, ruta: string): ValorJson | undefined {
  let actual: ValorJson | undefined = maestro
  for (const parte of ruta.split(".")) {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return undefined
    actual = actual[parte]
  }
  return actual
}

function aTexto(valor: ValorJson | undefined): string | null {
  if (valor === undefined || valor === null || valor === "") return null
  if (typeof valor === "boolean") return valor ? "Sí" : "No"
  if (Array.isArray(valor)) return valor.map((v) => aTexto(v) ?? "").filter(Boolean).join(", ") || null
  if (typeof valor === "object") return null
  return String(valor)
}

interface Resolucion {
  ruta: string
  confianza: number
  metodo: CampoMapeado["metodo"]
}

/** Resuelve una etiqueta del cliente a una clave del maestro: glosario exacto → normalizado → clave → aproximado. */
export function resolverRuta(etiqueta: string, glosario: Record<string, string>, maestro: Maestro): Resolucion | null {
  const exacta = glosario[etiqueta]
  if (exacta) return { ruta: exacta, confianza: 1, metodo: "glosario" }

  const norm = normalizar(etiqueta)
  const porNormalizada = Object.entries(glosario).find(([k]) => normalizar(k) === norm)
  if (porNormalizada) return { ruta: porNormalizada[1], confianza: 0.95, metodo: "glosario_normalizado" }

  const clave = norm.replace(/ /g, "_")
  if (clave in maestro) return { ruta: clave, confianza: 0.85, metodo: "clave_maestro" }

  let mejor: { ruta: string; s: number } | null = null
  for (const [sinonimo, ruta] of Object.entries(glosario)) {
    const s = similitud(etiqueta, sinonimo)
    if (s >= 0.5 && (!mejor || s > mejor.s)) mejor = { ruta, s }
  }
  // Una coincidencia aproximada nunca alcanza el umbral: siempre pasa por confirmación humana.
  if (mejor) return { ruta: mejor.ruta, confianza: Math.round(mejor.s * 0.75 * 100) / 100, metodo: "aproximado" }
  return null
}

export function identificadorDelPais(pais: string): string | null {
  return reglas.identificador_tributario_por_pais[pais] ?? null
}

function esEtiquetaAmbigua(etiqueta: string): boolean {
  return reglas.etiquetas_tributarias_ambiguas.some((a) => normalizar(a) === normalizar(etiqueta))
}

/** RN1: el identificador tributario depende del país del cliente. */
function notaTributaria(etiqueta: string, pais: string, valor: string): string | null {
  const equivalente = identificadorDelPais(pais)
  const origen = identificadorDelPais(reglas.pais_origen_maestro) ?? "NIT"
  if (pais !== reglas.pais_origen_maestro) {
    return `${reglas.nota_identificador_extranjero}: el cliente (${pais}) pide ${equivalente ?? "un identificador local"}; Periferia solo tiene ${origen} colombiano (${valor}). Confirmar si el cliente lo acepta.`
  }
  if (esEtiquetaAmbigua(etiqueta)) return `etiqueta ambigua; el equivalente en ${pais} es ${equivalente ?? origen}.`
  if (normalizar(etiqueta) !== normalizar(origen)) return `el cliente pide "${etiqueta}" pero en ${pais} el identificador es ${origen}.`
  return null
}

/** Para ingresos y similares, anota moneda y año si el maestro los tiene junto al valor. */
function notaContexto(maestro: Maestro, ruta: string): string | undefined {
  if (!ruta.endsWith(".valor")) return undefined
  const padre = valorEnRuta(maestro, ruta.slice(0, -".valor".length))
  if (!padre || typeof padre !== "object" || Array.isArray(padre)) return undefined
  const partes = [aTexto(padre.moneda), aTexto(padre.ano) && `año ${aTexto(padre.ano)}`].filter(Boolean)
  return partes.length ? partes.join(", ") : undefined
}

export function mapearCampo(campo: CampoSolicitado, pais: string, glosario: Record<string, string>, maestro: Maestro): CampoMapeado {
  const base = { etiqueta: campo.etiqueta, obligatorio: campo.obligatorio }
  const res = resolverRuta(campo.etiqueta, glosario, maestro)
  if (!res) {
    return { ...base, estado: "faltante", ruta: null, valor: null, confianza: 0, metodo: "sin_fuente", nota: "no existe en el glosario ni en el maestro" }
  }
  const valor = aTexto(valorEnRuta(maestro, res.ruta))
  if (valor === null) {
    return { ...base, estado: "faltante", ruta: null, valor: null, confianza: 0, metodo: "sin_fuente", nota: `la clave "${res.ruta}" no tiene valor en el maestro` }
  }
  const sensible = res.ruta.startsWith(reglas.prefijo_datos_bancarios)
  const mapeado: CampoMapeado = { ...base, estado: "lleno", ruta: res.ruta, valor, confianza: res.confianza, metodo: res.metodo, sensible: sensible || undefined }

  const notaPais = res.ruta === reglas.clave_identificador_tributario ? notaTributaria(campo.etiqueta, pais, valor) : null
  if (notaPais) return { ...mapeado, estado: "requiere_confirmacion", nota: notaPais }
  if (res.confianza < reglas.umbral_confianza) {
    return { ...mapeado, estado: "requiere_confirmacion", nota: `mapeo aproximado (confianza ${res.confianza}) a "${res.ruta}"; validar que corresponde` }
  }
  return { ...mapeado, nota: notaContexto(maestro, res.ruta) }
}

export function mapearCampos(campos: CampoSolicitado[], pais: string, glosario: Record<string, string>, maestro: Maestro): Mapeo {
  return { pais, campos: campos.map((c) => mapearCampo(c, pais, glosario, maestro)) }
}

/** Enmascara datos bancarios para lo que ve el modelo: el valor real solo va al formulario (RN2). */
export function enmascarar(valor: string): string {
  return valor.length <= 4 ? "****" : `${"*".repeat(valor.length - 4)}${valor.slice(-4)}`
}

export function valorVisible(c: CampoMapeado): string | null {
  if (c.valor === null) return null
  return c.sensible && /\d{5,}/.test(c.valor) ? enmascarar(c.valor) : c.valor
}

/** Vista del mapeo con la forma del contrato: { llenos, faltantes, requiere_confirmacion }. */
export function resumenMapeo(m: Mapeo) {
  const visibles = m.campos.map((c) => ({ ...c, valor: valorVisible(c) }))
  return {
    llenos: visibles
      .filter((c) => c.estado === "lleno")
      .map((c) => ({ etiqueta: c.etiqueta, ruta: c.ruta, valor: c.valor, confianza: c.confianza, ...(c.nota ? { nota: c.nota } : {}), ...(c.sensible ? { sensible: true } : {}) })),
    faltantes: visibles
      .filter((c) => c.estado === "faltante")
      .map((c) => ({ etiqueta: c.etiqueta, motivo: c.nota ?? "sin fuente", ...(c.obligatorio !== undefined ? { obligatorio: c.obligatorio } : {}) })),
    requiere_confirmacion: visibles
      .filter((c) => c.estado === "requiere_confirmacion")
      .map((c) => ({ etiqueta: c.etiqueta, ruta: c.ruta, valor_propuesto: c.valor, confianza: c.confianza, nota: c.nota ?? "" })),
  }
}
