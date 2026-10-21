import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import {
  camposDePlantilla,
  cargarGlosario,
  cargarMaestro,
  dirSalidaCaso,
  existe,
  relativa,
  reglas,
  type CampoSolicitado,
  type CasoCargado,
} from "./fixtures"
import { asegurarDir, generarPdf, generarValoresPortal, generarXlsx } from "./formularios"
import { identificadorDelPais, mapearCampos, normalizar, resolverRuta, type Mapeo } from "./mapeo"
import { ErrorHerramienta, type Formato } from "./tipos"

export const ARCHIVO_FORMULARIO: Record<Formato, string> = {
  xlsx: "formulario.xlsx",
  pdf: "formulario.pdf",
  portal: "valores-portal.md",
}

/** HU-1: campos tributarios que la analista debe confirmar, con el equivalente del país. */
export async function ambiguosTributarios(directory: string, caso: CasoCargado) {
  const [glosario, maestro] = await Promise.all([cargarGlosario(directory), cargarMaestro(directory)])
  const pais = caso.solicitud.pais
  const equivalente = identificadorDelPais(pais)
  const ambiguas = new Set(reglas.etiquetas_tributarias_ambiguas.map(normalizar))
  return camposDePlantilla(caso.plantilla)
    .filter((c) => resolverRuta(c.etiqueta, glosario, maestro)?.ruta === reglas.clave_identificador_tributario)
    .flatMap((c) => {
      const generica = ambiguas.has(normalizar(c.etiqueta))
      const extranjero = pais !== reglas.pais_origen_maestro
      const distinto = equivalente !== null && normalizar(c.etiqueta) !== normalizar(equivalente)
      if (!generica && !extranjero && !distinto) return []
      const motivo = generica
        ? "etiqueta genérica de identificación tributaria"
        : extranjero
          ? `${reglas.nota_identificador_extranjero}: Periferia solo tiene NIT colombiano`
          : `la plantilla pide ${c.etiqueta} pero en ${pais} corresponde ${equivalente}`
      return [{ etiqueta: c.etiqueta, motivo, equivalente_pais: equivalente ?? "desconocido para este país" }]
    })
}

function rutaMapeo(directory: string, caso: string): string {
  return path.join(dirSalidaCaso(directory, caso), "mapeo.json")
}

/** Calcula el mapeo desde la plantilla (o una lista de etiquetas) y lo guarda para trazabilidad. */
export async function calcularMapeo(directory: string, caso: CasoCargado, etiquetas?: string[]): Promise<Mapeo> {
  const [glosario, maestro] = await Promise.all([cargarGlosario(directory), cargarMaestro(directory)])
  const dePlantilla = camposDePlantilla(caso.plantilla)
  const campos: CampoSolicitado[] = etiquetas?.length
    ? etiquetas.map((e) => dePlantilla.find((c) => c.etiqueta === e) ?? { etiqueta: e })
    : dePlantilla
  const mapeo = mapearCampos(campos, caso.solicitud.pais, glosario, maestro)
  const destino = rutaMapeo(directory, caso.caso)
  await mkdir(path.dirname(destino), { recursive: true })
  await writeFile(destino, JSON.stringify(mapeo, null, 2), "utf8")
  return mapeo
}

export interface FormularioGenerado {
  ruta: string
  formato: Formato
  soportado: boolean
  campos: number
  llenos: number
  faltantes: string[]
  por_confirmar: string[]
  aviso?: string
}

function etiquetasEnOrden(caso: CasoCargado): string[] {
  return camposDePlantilla(caso.plantilla).map((c) => c.etiqueta)
}

/** HU-3: genera el formulario en el formato del cliente a partir del mapeo calculado desde el maestro. */
export async function generarFormulario(directory: string, caso: CasoCargado, mapeo: Mapeo): Promise<FormularioGenerado> {
  if (!caso.plantilla) {
    throw new ErrorHerramienta(`No se puede generar el formulario de "${caso.caso}": ${caso.errorPlantilla ?? "no hay plantilla"}`)
  }
  const formato = caso.solicitud.formato
  const destino = path.join(dirSalidaCaso(directory, caso.caso), ARCHIVO_FORMULARIO[formato])
  await asegurarDir(destino)
  const etiquetas = etiquetasEnOrden(caso)
  if (formato === "xlsx") {
    if (caso.plantilla.tipo !== "celdas") throw new ErrorHerramienta("El formato xlsx requiere plantilla-celdas.json.")
    await generarXlsx(caso, caso.plantilla.celdas, mapeo, destino)
  } else if (formato === "pdf") {
    await generarPdf(caso, etiquetas, mapeo, destino)
  } else {
    await generarValoresPortal(caso, etiquetas, mapeo, destino)
  }
  const del = (estado: string) => mapeo.campos.filter((c) => c.estado === estado).map((c) => c.etiqueta)
  return {
    ruta: relativa(directory, destino),
    formato,
    soportado: formato !== "portal",
    campos: etiquetas.length,
    llenos: del("lleno").length,
    faltantes: del("faltante"),
    por_confirmar: del("requiere_confirmacion"),
    ...(formato === "portal"
      ? { aviso: "formato no soportado: portal web con usuario y contraseña. Se generaron los valores listos para copiar; el ingreso de credenciales y el envío los hace una persona." }
      : {}),
  }
}

/** Devuelve el formulario ya generado o lo genera si aún no existe. */
export async function formularioExistente(directory: string, caso: CasoCargado): Promise<{ ruta: string; generadoAhora: boolean } | null> {
  const destino = path.join(dirSalidaCaso(directory, caso.caso), ARCHIVO_FORMULARIO[caso.solicitud.formato])
  if (await existe(destino)) return { ruta: destino, generadoAhora: false }
  if (!caso.plantilla) return null
  const g = await generarFormulario(directory, caso, await calcularMapeo(directory, caso))
  return { ruta: path.join(directory, g.ruta), generadoAhora: true }
}

const EstadoPaqueteSchema = z.object({
  caso: z.string(),
  ruta: z.string(),
  listo_para_firma: z.boolean(),
  bloqueos: z.array(z.string()),
  destinatario: z.string(),
  asunto: z.string(),
  adjuntos: z.array(z.string()),
  fecha_revision: z.string(),
})
export type EstadoPaquete = z.infer<typeof EstadoPaqueteSchema>

export function rutaEstadoPaquete(directory: string, caso: string): string {
  return path.join(dirSalidaCaso(directory, caso), "paquete", "estado.json")
}

export async function leerEstadoPaquete(directory: string, caso: string): Promise<EstadoPaquete | null> {
  try {
    const r = EstadoPaqueteSchema.safeParse(JSON.parse(await readFile(rutaEstadoPaquete(directory, caso), "utf8")))
    return r.success ? r.data : null
  } catch {
    return null
  }
}
