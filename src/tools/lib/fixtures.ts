import { readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { ErrorHerramienta } from "./tipos"
import reglasJson from "../../knowledge/reglas.json"

export const DIR_FIXTURES = path.join("fixtures", "reto-01")
export const DIR_OUT = "out"

const ReglasSchema = z.object({
  pais_origen_maestro: z.string(),
  identificador_tributario_por_pais: z.record(z.string(), z.string()),
  clave_identificador_tributario: z.string(),
  etiquetas_tributarias_ambiguas: z.array(z.string()),
  prefijo_datos_bancarios: z.string(),
  umbral_confianza: z.number(),
  nota_identificador_extranjero: z.string(),
  formatos_soportados: z.array(z.string()),
  nombres_soportes: z.record(z.string(), z.string()),
})
export type Reglas = z.infer<typeof ReglasSchema>
export const reglas: Reglas = ReglasSchema.parse(reglasJson)

export const CasoSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,80}$/, "el nombre del caso solo admite minúsculas, números y guiones")
  .describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/, p. ej. 'ec-corp-andina'")

const SolicitudSchema = z.object({
  id: z.string(),
  de: z.string(),
  para: z.string().optional(),
  asunto: z.string(),
  fecha: z.string(),
  pais: z.string(),
  cliente: z.string(),
  formato: z.enum(["xlsx", "pdf", "portal"]),
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
})
export type Solicitud = z.infer<typeof SolicitudSchema>

const CeldaSchema = z.object({
  hoja: z.string().min(1),
  celda_etiqueta: z.string().regex(/^[A-Z]{1,3}[1-9]\d*$/, "celda inválida"),
  etiqueta: z.string().min(1),
  celda_valor: z.string().regex(/^[A-Z]{1,3}[1-9]\d*$/, "celda inválida"),
})
export type Celda = z.infer<typeof CeldaSchema>

const CampoPdfSchema = z.object({ etiqueta: z.string().min(1), obligatorio: z.boolean() })
export type CampoPdf = z.infer<typeof CampoPdfSchema>

const SoporteSchema = z.object({
  tipo: z.string(),
  archivo: z.string(),
  vigencia_hasta: z.string().nullable(),
  pais_emisor: z.string(),
  descripcion: z.string(),
})
export type Soporte = z.infer<typeof SoporteSchema>

export type ValorJson = string | number | boolean | null | ValorJson[] | { [k: string]: ValorJson }
const ValorJsonSchema: z.ZodType<ValorJson> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(ValorJsonSchema), z.record(z.string(), ValorJsonSchema)]),
)
const MaestroSchema = z.record(z.string(), ValorJsonSchema)
export type Maestro = z.infer<typeof MaestroSchema>

export type Plantilla =
  | { tipo: "celdas"; archivo: string; celdas: Celda[] }
  | { tipo: "campos"; archivo: string; campos: CampoPdf[] }

/** Campo solicitado por la plantilla, normalizado para ambos tipos de plantilla. */
export interface CampoSolicitado {
  etiqueta: string
  obligatorio?: boolean
  hoja?: string
  celda_etiqueta?: string
  celda_valor?: string
}

export interface CasoCargado {
  caso: string
  solicitud: Solicitud
  plantilla: Plantilla | null
  /** Motivo por el que no hay plantilla utilizable (corrupta, ausente…). */
  errorPlantilla: string | null
  soportesExigidos: string[]
}

async function existe(ruta: string): Promise<boolean> {
  try {
    await stat(ruta)
    return true
  } catch {
    return false
  }
}

/** Lee y valida un JSON. Traduce cada fallo a un mensaje claro, sin trazas. */
export async function leerJson<T>(ruta: string, schema: z.ZodType<T>, descripcion: string): Promise<T> {
  let texto: string
  try {
    texto = await readFile(ruta, "utf8")
  } catch {
    throw new ErrorHerramienta(`No se encontró ${descripcion}.`)
  }
  let crudo: unknown
  try {
    crudo = JSON.parse(texto)
  } catch {
    throw new ErrorHerramienta(`${descripcion} está corrupto: no es un JSON válido.`)
  }
  const r = schema.safeParse(crudo)
  if (!r.success) {
    const detalle = r.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`)
      .join("; ")
    throw new ErrorHerramienta(`${descripcion} no tiene la estructura esperada (${detalle}).`)
  }
  return r.data
}

export async function listarCasos(directory: string): Promise<string[]> {
  try {
    const entradas = await readdir(path.join(directory, DIR_FIXTURES, "casos"), { withFileTypes: true })
    return entradas.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    return []
  }
}

export async function dirCaso(directory: string, caso: string): Promise<string> {
  const dir = path.join(directory, DIR_FIXTURES, "casos", caso)
  if (!(await existe(dir))) {
    const disponibles = await listarCasos(directory)
    throw new ErrorHerramienta(`El caso "${caso}" no existe. Casos disponibles: ${disponibles.join(", ") || "ninguno"}.`)
  }
  return dir
}

async function cargarPlantilla(dir: string, formato: Solicitud["formato"]): Promise<Plantilla> {
  const rutaCeldas = path.join(dir, "plantilla-celdas.json")
  const rutaCampos = path.join(dir, "plantilla-campos.json")
  const usarCeldas = formato === "xlsx" || (formato === "portal" && !(await existe(rutaCampos)) && (await existe(rutaCeldas)))
  if (usarCeldas) {
    const celdas = await leerJson(rutaCeldas, z.array(CeldaSchema).min(1), "La plantilla de celdas (plantilla-celdas.json)")
    return { tipo: "celdas", archivo: "plantilla-celdas.json", celdas }
  }
  const campos = await leerJson(rutaCampos, z.array(CampoPdfSchema).min(1), "La plantilla de campos (plantilla-campos.json)")
  return { tipo: "campos", archivo: "plantilla-campos.json", campos }
}

/** Carga un caso completo. La solicitud es obligatoria; una plantilla dañada no impide seguir. */
export async function cargarCaso(directory: string, caso: string): Promise<CasoCargado> {
  const dir = await dirCaso(directory, caso)
  const solicitud = await leerJson(path.join(dir, "solicitud.json"), SolicitudSchema, "La solicitud (solicitud.json)")
  let plantilla: Plantilla | null = null
  let errorPlantilla: string | null = null
  try {
    plantilla = await cargarPlantilla(dir, solicitud.formato)
  } catch (e) {
    errorPlantilla = e instanceof ErrorHerramienta ? e.message : "No se pudo leer la plantilla."
  }
  let soportesExigidos: string[] = []
  try {
    soportesExigidos = await leerJson(path.join(dir, "soportes-exigidos.json"), z.array(z.string()), "La lista de soportes exigidos (soportes-exigidos.json)")
  } catch (e) {
    errorPlantilla = [errorPlantilla, e instanceof Error ? e.message : ""].filter(Boolean).join(" ")
  }
  return { caso, solicitud, plantilla, errorPlantilla, soportesExigidos }
}

export function camposDePlantilla(plantilla: Plantilla | null): CampoSolicitado[] {
  if (!plantilla) return []
  if (plantilla.tipo === "campos") return plantilla.campos.map((c) => ({ etiqueta: c.etiqueta, obligatorio: c.obligatorio }))
  return plantilla.celdas.map((c) => ({ etiqueta: c.etiqueta, hoja: c.hoja, celda_etiqueta: c.celda_etiqueta, celda_valor: c.celda_valor }))
}

export function cargarGlosario(directory: string): Promise<Record<string, string>> {
  return leerJson(path.join(directory, DIR_FIXTURES, "glosario-campos.json"), z.record(z.string(), z.string()), "El glosario de campos")
}

export function cargarMaestro(directory: string): Promise<Maestro> {
  return leerJson(path.join(directory, DIR_FIXTURES, "repositorio", "maestro.json"), MaestroSchema, "El repositorio maestro")
}

export function cargarIndiceSoportes(directory: string): Promise<Soporte[]> {
  return leerJson(path.join(directory, DIR_FIXTURES, "repositorio", "soportes", "index.json"), z.array(SoporteSchema), "El índice de soportes")
}

export function rutaSoporte(directory: string, archivo: string): string {
  return path.join(directory, DIR_FIXTURES, "repositorio", "soportes", path.basename(archivo))
}

export function dirSalidaCaso(directory: string, caso: string): string {
  return path.join(directory, DIR_OUT, caso)
}

/** Ruta relativa a la raíz, con "/" para que sea igual en Windows y Linux. */
export function relativa(directory: string, ruta: string): string {
  return path.relative(directory, ruta).split(path.sep).join("/")
}

export { existe }
