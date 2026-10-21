import { copyFile, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { cargarIndiceSoportes, existe, reglas, rutaSoporte, type CasoCargado, type Maestro, type Soporte } from "./fixtures"
import { valorEnRuta, type CampoMapeado, type Mapeo } from "./mapeo"

export interface SoportePresente {
  tipo: string
  nombre: string
  archivo: string
  vigencia_hasta: string | null
}
export interface SoporteVencido extends SoportePresente {
  dias_vencido: number
}
export interface SoporteAusente {
  tipo: string
  nombre: string
  motivo: string
}

export interface RevisionSoportes {
  presentes: SoportePresente[]
  vencidos: SoporteVencido[]
  ausentes: SoporteAusente[]
  por_vencer: SoportePresente[]
}

function dias(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000)
}

export function nombreSoporte(tipo: string): string {
  return reglas.nombres_soportes[tipo] ?? tipo
}

/** RN3: clasifica cada soporte exigido como presente, vencido (vigencia_hasta < hoy) o ausente. */
export async function revisarSoportes(directory: string, exigidos: string[], hoy: string): Promise<RevisionSoportes> {
  const indice = await cargarIndiceSoportes(directory)
  const r: RevisionSoportes = { presentes: [], vencidos: [], ausentes: [], por_vencer: [] }
  for (const tipo of exigidos) {
    const s: Soporte | undefined = indice.find((x) => x.tipo === tipo)
    const nombre = nombreSoporte(tipo)
    if (!s) {
      r.ausentes.push({ tipo, nombre, motivo: "no existe en el repositorio de soportes" })
      continue
    }
    if (!(await existe(rutaSoporte(directory, s.archivo)))) {
      r.ausentes.push({ tipo, nombre, motivo: `el índice apunta a ${s.archivo} pero el archivo no está` })
      continue
    }
    const item = { tipo, nombre, archivo: s.archivo, vigencia_hasta: s.vigencia_hasta }
    if (s.vigencia_hasta && s.vigencia_hasta < hoy) r.vencidos.push({ ...item, dias_vencido: dias(s.vigencia_hasta, hoy) })
    else {
      r.presentes.push(item)
      if (s.vigencia_hasta && dias(hoy, s.vigencia_hasta) <= 15) r.por_vencer.push(item)
    }
  }
  return r
}

/** Copia al paquete los soportes que existen (incluidos los vencidos, marcados en el checklist). */
export async function copiarSoportes(directory: string, rev: RevisionSoportes, dirPaquete: string): Promise<string[]> {
  const dirSoportes = path.join(dirPaquete, "soportes")
  await mkdir(dirSoportes, { recursive: true })
  const copiados: string[] = []
  for (const s of [...rev.presentes, ...rev.vencidos]) {
    await copyFile(rutaSoporte(directory, s.archivo), path.join(dirSoportes, path.basename(s.archivo)))
    copiados.push(`soportes/${path.basename(s.archivo)}`)
  }
  return copiados
}

export async function limpiarPaquete(dirPaquete: string): Promise<void> {
  await rm(dirPaquete, { recursive: true, force: true })
  await mkdir(dirPaquete, { recursive: true })
}

export function bloqueos(rev: RevisionSoportes, formularioOk: boolean): string[] {
  return [
    ...(formularioOk ? [] : ["el formulario no pudo generarse"]),
    ...rev.vencidos.map((s) => `soporte vencido: ${s.nombre} (venció el ${s.vigencia_hasta})`),
    ...rev.ausentes.map((s) => `soporte ausente: ${s.nombre} (${s.motivo})`),
  ]
}

function casilla(marcado: boolean): string {
  return marcado ? "[x]" : "[ ]"
}

interface DatosChecklist {
  caso: CasoCargado
  hoy: string
  formulario: string | null
  rev: RevisionSoportes
  mapeo: Mapeo | null
  listo: boolean
  bloqueos: string[]
}

export function checklistMd(d: DatosChecklist): string {
  const faltantes = d.mapeo?.campos.filter((c) => c.estado === "faltante") ?? []
  const confirmar = d.mapeo?.campos.filter((c) => c.estado === "requiere_confirmacion") ?? []
  const s = d.caso.solicitud
  return [
    `# Checklist — ${s.cliente}`,
    "",
    `- Caso: \`${d.caso.caso}\` · país ${s.pais} · formato ${s.formato}`,
    `- Fecha de revisión: ${d.hoy}`,
    `- **Listo para firma: ${d.listo ? "SÍ" : "NO"}**`,
    ...(d.bloqueos.length ? ["", "## Bloqueos", "", ...d.bloqueos.map((b) => `- ${b}`)] : []),
    "",
    "## Formulario",
    "",
    `- ${casilla(d.formulario !== null)} ${d.formulario ?? "no generado"}`,
    "",
    "## Soportes exigidos",
    "",
    "| Estado | Soporte | Archivo | Vigencia hasta |",
    "|---|---|---|---|",
    ...d.rev.presentes.map((x) => `| PRESENTE | ${x.nombre} | ${x.archivo} | ${x.vigencia_hasta ?? "no aplica"} |`),
    ...d.rev.vencidos.map((x) => `| **VENCIDO** (hace ${x.dias_vencido} días) | ${x.nombre} | ${x.archivo} | ${x.vigencia_hasta} |`),
    ...d.rev.ausentes.map((x) => `| **AUSENTE** | ${x.nombre} | — | ${x.motivo} |`),
    ...(d.rev.por_vencer.length ? ["", ...d.rev.por_vencer.map((x) => `> Atención: ${x.nombre} vence el ${x.vigencia_hasta}.`)] : []),
    "",
    "## Campos faltantes (no bloquean la firma; completar a mano)",
    "",
    ...(faltantes.length ? faltantes.map((c) => `- [ ] ${c.etiqueta}${c.obligatorio ? " (obligatorio)" : ""} — ${c.nota ?? "sin fuente"}`) : ["- Ninguno"]),
    "",
    "## Campos que requieren confirmación",
    "",
    ...(confirmar.length ? confirmar.map((c) => `- [ ] ${c.etiqueta} — ${c.nota ?? ""}`) : ["- Ninguno"]),
    "",
    "## Cierre humano",
    "",
    "- [ ] Revisar el formulario y completar faltantes",
    "- [ ] Firma del representante legal",
    "- [ ] Confirmar el envío en el chat (solo se simula)",
    "",
  ].join("\n")
}

/** Valores bancarios que nunca pueden aparecer en el borrador de correo (RN2). */
function valoresBancarios(maestro: Maestro): string[] {
  const banco = valorEnRuta(maestro, reglas.prefijo_datos_bancarios.replace(/\.$/, ""))
  if (!banco || typeof banco !== "object" || Array.isArray(banco)) return []
  const razon = valorEnRuta(maestro, "razon_social")
  return Object.values(banco)
    .filter((v): v is string => typeof v === "string" && v.length >= 4 && v !== razon)
    .sort((a, b) => b.length - a.length)
}

/** Elimina cualquier dato bancario que se haya colado en el texto. Devuelve cuántos se quitaron. */
export function sinDatosBancarios(texto: string, maestro: Maestro): { texto: string; omitidos: number } {
  let omitidos = 0
  let limpio = texto
  for (const v of valoresBancarios(maestro)) {
    if (limpio.includes(v)) {
      omitidos++
      limpio = limpio.split(v).join("[dato bancario omitido]")
    }
  }
  return { texto: limpio, omitidos }
}

function texto(maestro: Maestro, ruta: string): string {
  const v = valorEnRuta(maestro, ruta)
  return typeof v === "string" || typeof v === "number" ? String(v) : ""
}

export function borradorCorreoMd(d: DatosChecklist, maestro: Maestro, adjuntos: string[]): { texto: string; omitidos: number } {
  const s = d.caso.solicitud
  const pendientes = [
    ...d.bloqueos,
    ...(d.mapeo?.campos.filter((c: CampoMapeado) => c.estado !== "lleno").map((c) => `${c.estado === "faltante" ? "completar" : "confirmar"}: ${c.etiqueta}`) ?? []),
  ]
  const md = [
    `# Borrador de correo — ${s.cliente}`,
    "",
    "> NOTA INTERNA (borrar antes de enviar). Este borrador no incluye datos bancarios por política (RN2);",
    "> viajan solo en el formulario y en la certificación bancaria adjunta.",
    ...(pendientes.length ? [">", "> Pendientes antes de enviar:", ...pendientes.map((p) => `> - ${p}`)] : []),
    "",
    "---",
    "",
    `**Para:** ${s.de}`,
    `**Asunto:** RE: ${s.asunto}`,
    "",
    "Buen día,",
    "",
    `En respuesta a su solicitud del ${s.fecha}, remitimos la documentación de ${texto(maestro, "razon_social")} para el registro como proveedor de ${s.cliente.replace(/\.$/, "")}.`,
    "",
    "Adjuntos:",
    "",
    ...adjuntos.map((a) => `- ${a}`),
    "",
    "Quedamos atentos a cualquier información adicional.",
    "",
    "Cordialmente,",
    "",
    texto(maestro, "contacto_financiero.nombre"),
    texto(maestro, "contacto_financiero.cargo"),
    `${texto(maestro, "razon_social")} · ${texto(maestro, "contacto_financiero.email")} · ${texto(maestro, "contacto_financiero.telefono")}`,
    "",
  ].join("\n")
  return sinDatosBancarios(md, maestro)
}
