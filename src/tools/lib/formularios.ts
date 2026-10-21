import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import ExcelJS from "exceljs"
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import type { CasoCargado, Celda } from "./fixtures"
import type { CampoMapeado, Mapeo } from "./mapeo"

const COLOR_FALTANTE = "FFFFF2CC"
const COLOR_CONFIRMAR = "FFFCE4D6"

function porEtiqueta(mapeo: Mapeo): Map<string, CampoMapeado> {
  return new Map(mapeo.campos.map((c) => [c.etiqueta, c]))
}

function marcar(celda: ExcelJS.Cell, color: string, nota: string): void {
  celda.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } }
  celda.note = nota
}

function escribirCelda(ws: ExcelJS.Worksheet, c: Celda, campo: CampoMapeado | undefined): void {
  const etiqueta = ws.getCell(c.celda_etiqueta)
  etiqueta.value = c.etiqueta
  etiqueta.font = { bold: true }
  const valor = ws.getCell(c.celda_valor)
  if (!campo || campo.estado === "faltante") {
    valor.value = null
    marcar(valor, COLOR_FALTANTE, `FALTANTE: ${campo?.nota ?? "sin fuente en el maestro"}. Completar manualmente.`)
    return
  }
  valor.value = campo.valor
  if (campo.estado === "requiere_confirmacion") marcar(valor, COLOR_CONFIRMAR, `REQUIERE CONFIRMACIÓN: ${campo.nota ?? ""}`)
  else if (campo.nota) valor.note = campo.nota
}

function ajustarAnchos(ws: ExcelJS.Worksheet): void {
  ws.columns.forEach((col) => {
    let max = 10
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      max = Math.max(max, String(cell.value ?? "").length + 2)
    })
    col.width = Math.min(max, 70)
  })
}

/** P0: escribe cada etiqueta y valor exactamente en la hoja y celda que indica la plantilla. */
export async function generarXlsx(caso: CasoCargado, celdas: Celda[], mapeo: Mapeo, destino: string): Promise<void> {
  const libro = new ExcelJS.Workbook()
  libro.creator = "Agente Registro como Proveedor"
  libro.created = new Date(`${caso.solicitud.fecha}T00:00:00Z`)
  const campos = porEtiqueta(mapeo)
  for (const c of celdas) {
    const ws = libro.getWorksheet(c.hoja) ?? libro.addWorksheet(c.hoja)
    escribirCelda(ws, c, campos.get(c.etiqueta))
  }
  libro.worksheets.forEach(ajustarAnchos)
  await libro.xlsx.writeFile(destino)
}

/** Helvetica estándar usa WinAnsi: se sustituye lo que no puede codificar. */
function paraPdf(texto: string): string {
  return texto
    .replace(/[→⇒]/g, "->")
    .replace(/[≥]/g, ">=")
    .replace(/[≤]/g, "<=")
    .replace(/[^\x20-\x7E\xA0-\xFF•–—“”‘’€]/g, "?")
}

function partirLineas(texto: string, fuente: PDFFont, tam: number, ancho: number): string[] {
  const lineas: string[] = []
  let actual = ""
  for (const palabra of paraPdf(texto).split(/\s+/)) {
    const prueba = actual ? `${actual} ${palabra}` : palabra
    if (fuente.widthOfTextAtSize(prueba, tam) <= ancho || !actual) actual = prueba
    else {
      lineas.push(actual)
      actual = palabra
    }
  }
  if (actual) lineas.push(actual)
  return lineas.length ? lineas : [""]
}

interface Lienzo {
  doc: PDFDocument
  pagina: PDFPage
  y: number
  normal: PDFFont
  negrita: PDFFont
}

const MARGEN = 50
const ALTO_PAGINA = 842
const ANCHO_PAGINA = 595

function asegurarEspacio(l: Lienzo, alto: number): void {
  if (l.y - alto >= MARGEN) return
  l.pagina = l.doc.addPage([ANCHO_PAGINA, ALTO_PAGINA])
  l.y = ALTO_PAGINA - MARGEN
}

function texto(l: Lienzo, t: string, x: number, tam: number, fuente: PDFFont, color = rgb(0, 0, 0)): void {
  l.pagina.drawText(paraPdf(t), { x, y: l.y, size: tam, font: fuente, color })
}

function filaCampo(l: Lienzo, indice: number, campo: CampoMapeado): void {
  const tam = 10
  const xValor = 250
  const anchoValor = ANCHO_PAGINA - MARGEN - xValor
  const etiqueta = partirLineas(`${indice}. ${campo.etiqueta}${campo.obligatorio ? " *" : ""}`, l.negrita, tam, xValor - MARGEN - 10)
  const valor = campo.estado === "faltante" ? ["[FALTANTE: completar manualmente]"] : partirLineas(campo.valor ?? "", l.normal, tam, anchoValor)
  const nota = campo.estado === "requiere_confirmacion" ? partirLineas(`Por confirmar: ${campo.nota ?? ""}`, l.normal, 8, anchoValor) : []
  const alto = Math.max(etiqueta.length, valor.length) * 13 + nota.length * 10 + 10
  asegurarEspacio(l, alto)
  const inicio = l.y
  etiqueta.forEach((linea, i) => {
    l.y = inicio - i * 13
    texto(l, linea, MARGEN, tam, l.negrita)
  })
  const colorValor = campo.estado === "faltante" ? rgb(0.75, 0.1, 0.1) : rgb(0, 0, 0)
  valor.forEach((linea, i) => {
    l.y = inicio - i * 13
    texto(l, linea, xValor, tam, l.normal, colorValor)
  })
  let y = inicio - valor.length * 13
  nota.forEach((linea) => {
    l.y = y
    texto(l, linea, xValor, 8, l.normal, rgb(0.8, 0.4, 0))
    y -= 10
  })
  l.y = Math.min(inicio - etiqueta.length * 13, y) - 10
  l.pagina.drawLine({ start: { x: MARGEN, y: l.y + 13 }, end: { x: ANCHO_PAGINA - MARGEN, y: l.y + 13 }, thickness: 0.3, color: rgb(0.8, 0.8, 0.8) })
}

/** P1: PDF generado que reproduce todos los campos, con etiqueta y valor, en el orden de la plantilla. */
export async function generarPdf(caso: CasoCargado, etiquetas: string[], mapeo: Mapeo, destino: string): Promise<void> {
  const doc = await PDFDocument.create()
  doc.setTitle(`Registro de proveedor - ${caso.solicitud.cliente}`)
  doc.setCreator("Agente Registro como Proveedor")
  const fechaDoc = new Date(`${caso.solicitud.fecha}T00:00:00Z`)
  doc.setCreationDate(fechaDoc)
  doc.setModificationDate(fechaDoc)
  const l: Lienzo = {
    doc,
    pagina: doc.addPage([ANCHO_PAGINA, ALTO_PAGINA]),
    y: ALTO_PAGINA - MARGEN,
    normal: await doc.embedFont(StandardFonts.Helvetica),
    negrita: await doc.embedFont(StandardFonts.HelveticaBold),
  }
  texto(l, "Formulario de registro de proveedor", MARGEN, 16, l.negrita)
  l.y -= 20
  texto(l, `Cliente: ${caso.solicitud.cliente} (${caso.solicitud.pais})  ·  Solicitud: ${caso.solicitud.id} del ${caso.solicitud.fecha}`, MARGEN, 9, l.normal)
  l.y -= 12
  texto(l, `Adjunto original: ${caso.solicitud.adjuntos.join(", ") || "—"}  ·  * = obligatorio`, MARGEN, 9, l.normal, rgb(0.4, 0.4, 0.4))
  l.y -= 28
  const campos = porEtiqueta(mapeo)
  etiquetas.forEach((et, i) => {
    const campo = campos.get(et) ?? { etiqueta: et, estado: "faltante", ruta: null, valor: null, confianza: 0, metodo: "sin_fuente" }
    filaCampo(l, i + 1, campo)
  })
  asegurarEspacio(l, 80)
  l.y -= 40
  l.pagina.drawLine({ start: { x: MARGEN, y: l.y }, end: { x: MARGEN + 220, y: l.y }, thickness: 0.8 })
  l.y -= 12
  texto(l, "Firma del representante legal", MARGEN, 9, l.normal)
  await writeFile(destino, await doc.save({ useObjectStreams: false }))
}

function celdaMd(t: string | null): string {
  return (t ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")
}

/** P2: el portal no se automatiza; se dejan los valores listos para copiar (ver SOLUCION.md §5). */
export async function generarValoresPortal(caso: CasoCargado, etiquetas: string[], mapeo: Mapeo, destino: string): Promise<void> {
  const campos = porEtiqueta(mapeo)
  const url = caso.solicitud.cuerpo.match(/https?:\/\/[^\s)]+/)?.[0]?.replace(/[.,;]$/, "")
  const filas = etiquetas.map((et) => {
    const c = campos.get(et)
    const estado = !c || c.estado === "faltante" ? "FALTANTE" : c.estado === "requiere_confirmacion" ? `POR CONFIRMAR: ${c.nota ?? ""}` : "ok"
    return `| ${celdaMd(et)} | ${c?.estado === "faltante" ? "" : celdaMd(c?.valor ?? "")} | ${celdaMd(estado)} |`
  })
  const md = [
    `# Valores para el portal — ${caso.solicitud.cliente}`,
    "",
    `> **Formato no soportado para automatización**: portal web con usuario y contraseña.`,
    `> El agente no opera portales. Una persona ingresa con sus credenciales, copia estos valores y hace clic en "Enviar".`,
    "",
    `- Portal: ${url ?? "(no indicado en la solicitud)"}`,
    `- Solicitud: ${caso.solicitud.id} (${caso.solicitud.fecha}) · país ${caso.solicitud.pais}`,
    `- Credenciales: las tiene el representante legal (llegaron por otro canal). **No** se guardan aquí.`,
    "",
    "| Campo del portal | Valor a copiar | Estado |",
    "|---|---|---|",
    ...filas,
    "",
    "## Soportes a cargar en el portal",
    "",
    ...caso.soportesExigidos.map((s) => `- ${s}`),
    "",
    "> Este archivo contiene datos bancarios. Úsalo solo para diligenciar el portal; no lo reenvíes por correo.",
    "",
  ].join("\n")
  await writeFile(destino, md, "utf8")
}

export async function asegurarDir(ruta: string): Promise<void> {
  await mkdir(path.dirname(ruta), { recursive: true })
}
