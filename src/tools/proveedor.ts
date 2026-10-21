/**
 * Herramientas del agente "Registro como Proveedor" (contrato de la sección 6.2 del PRD).
 * Cada export es una herramienta; el modelo la ve como `proveedor_<export>`.
 * Este archivo solo exporta herramientas para que `modulo/tools/proveedor.ts` lo re-exporte tal cual.
 */
import { copyFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { CasoSchema, camposDePlantilla, cargarCaso, cargarMaestro, dirSalidaCaso, relativa } from "./lib/fixtures"
import { ejecutar, fechaEjecucion } from "./lib/ejecucion"
import {
  ambiguosTributarios,
  calcularMapeo,
  formularioExistente,
  generarFormulario,
  leerEstadoPaquete,
  rutaEstadoPaquete,
  type EstadoPaquete,
} from "./lib/flujo"
import { identificadorDelPais, resumenMapeo } from "./lib/mapeo"
import { bloqueos, borradorCorreoMd, checklistMd, copiarSoportes, limpiarPaquete, nombreSoporte, revisarSoportes } from "./lib/paquete"
import { ErrorHerramienta, type Herramienta } from "./lib/tipos"

const argsLeer = { caso: CasoSchema }

export const leer_solicitud: Herramienta<typeof argsLeer> = {
  description:
    "Lee la solicitud de un caso (correo, plantilla y soportes exigidos) y devuelve país, cliente, formato de salida, campos pedidos, soportes y campos tributarios que requieren confirmación.",
  args: argsLeer,
  execute: (args, ctx) =>
    ejecutar("proveedor_leer_solicitud", argsLeer, args, ctx, async ({ caso }) => {
      const c = await cargarCaso(ctx.directory, caso)
      const campos = camposDePlantilla(c.plantilla)
      const requiere_confirmacion = c.plantilla ? await ambiguosTributarios(ctx.directory, c) : []
      const data = {
        caso,
        pais: c.solicitud.pais,
        cliente: c.solicitud.cliente,
        formato: c.solicitud.formato,
        asunto: c.solicitud.asunto,
        remitente: c.solicitud.de,
        fecha: c.solicitud.fecha,
        identificador_tributario_pais: identificadorDelPais(c.solicitud.pais),
        plantilla: c.plantilla?.archivo ?? null,
        campos,
        soportes: c.soportesExigidos.map((tipo) => ({ tipo, nombre: nombreSoporte(tipo) })),
        requiere_confirmacion,
        advertencias: c.errorPlantilla ? [c.errorPlantilla] : [],
      }
      const aviso = c.errorPlantilla ? ` · AVISO: ${c.errorPlantilla}` : ""
      return {
        data,
        resumen: `${caso}: ${c.solicitud.cliente} (${c.solicitud.pais}), formato ${c.solicitud.formato}, ${campos.length} campos, ${c.soportesExigidos.length} soportes, ${requiere_confirmacion.length} por confirmar${aviso}`,
      }
    }),
}

const argsMapear = {
  caso: CasoSchema,
  campos: z
    .array(z.string().min(1))
    .optional()
    .describe("Etiquetas de los campos a mapear, tal como las devolvió proveedor_leer_solicitud. Si se omite, se usan todos los de la plantilla."),
}

export const mapear_campos: Herramienta<typeof argsMapear> = {
  description:
    "Cruza cada campo solicitado con el glosario y el repositorio maestro y lo clasifica en llenos (con ruta del dato), faltantes (sin fuente, nunca inventados) o requiere_confirmacion.",
  args: argsMapear,
  execute: (args, ctx) =>
    ejecutar("proveedor_mapear_campos", argsMapear, args, ctx, async ({ caso, campos }) => {
      const c = await cargarCaso(ctx.directory, caso)
      if (!c.plantilla && !campos?.length) {
        throw new ErrorHerramienta(`No hay campos que mapear en "${caso}": ${c.errorPlantilla ?? "la plantilla no está disponible"}`)
      }
      const mapeo = await calcularMapeo(ctx.directory, c, campos)
      const r = resumenMapeo(mapeo)
      return {
        data: { caso, pais: mapeo.pais, ...r },
        resumen: `${caso}: ${r.llenos.length} llenos, ${r.faltantes.length} faltantes, ${r.requiere_confirmacion.length} por confirmar`,
      }
    }),
}

const EntradaMapeo = z.looseObject({ etiqueta: z.string(), ruta: z.string().nullable().optional() })
const argsGenerar = {
  caso: CasoSchema,
  mapeo: z
    .looseObject({
      llenos: z.array(EntradaMapeo).optional(),
      faltantes: z.array(EntradaMapeo).optional(),
      requiere_confirmacion: z.array(EntradaMapeo).optional(),
    })
    .optional()
    .describe("Resultado de proveedor_mapear_campos. Los valores se vuelven a leer del maestro; si se omite, se calcula el mapeo."),
}

export const generar_formulario: Herramienta<typeof argsGenerar> = {
  description:
    "Genera el formulario lleno en el formato del cliente (out/<caso>/formulario.xlsx o formulario.pdf); para portales web responde 'formato no soportado' y deja valores-portal.md listo para copiar.",
  args: argsGenerar,
  execute: (args, ctx) =>
    ejecutar("proveedor_generar_formulario", argsGenerar, args, ctx, async ({ caso, mapeo: recibido }) => {
      const c = await cargarCaso(ctx.directory, caso)
      // Los valores salen siempre del maestro (CA2): el mapeo recibido solo se contrasta.
      const mapeo = await calcularMapeo(ctx.directory, c)
      const advertencias: string[] = []
      if (recibido) {
        const rutas = new Map(mapeo.campos.map((m) => [m.etiqueta, m.ruta]))
        for (const e of [...(recibido.llenos ?? []), ...(recibido.requiere_confirmacion ?? [])]) {
          if (e.ruta !== undefined && rutas.has(e.etiqueta) && rutas.get(e.etiqueta) !== e.ruta) {
            advertencias.push(`"${e.etiqueta}": se ignoró la ruta recibida (${e.ruta ?? "null"}); se usó ${rutas.get(e.etiqueta) ?? "ninguna"} según el glosario.`)
          }
        }
      }
      const g = await generarFormulario(ctx.directory, c, mapeo)
      return {
        data: { ...g, ...(advertencias.length ? { advertencias } : {}) },
        resumen: `${caso}: ${g.soportado ? `formulario ${g.formato}` : "formato no soportado (portal)"} en ${g.ruta}; ${g.llenos}/${g.campos} llenos`,
      }
    }),
}

const argsPaquete = { caso: CasoSchema }

export const armar_paquete: Herramienta<typeof argsPaquete> = {
  description:
    "Arma out/<caso>/paquete/ con el formulario, copias de los soportes exigidos, checklist.md (presentes, ausentes, vencidos y campos faltantes) y borrador-correo.md sin datos bancarios, e indica si está listo_para_firma.",
  args: argsPaquete,
  execute: (args, ctx) =>
    ejecutar("proveedor_armar_paquete", argsPaquete, args, ctx, async ({ caso }) => {
      const c = await cargarCaso(ctx.directory, caso)
      const hoy = fechaEjecucion()
      const dirPaquete = path.join(dirSalidaCaso(ctx.directory, caso), "paquete")
      const formulario = await formularioExistente(ctx.directory, c)
      const mapeo = c.plantilla ? await calcularMapeo(ctx.directory, c) : null
      await limpiarPaquete(dirPaquete)

      let formularioEnPaquete: string | null = null
      if (formulario) {
        formularioEnPaquete = path.basename(formulario.ruta)
        await copyFile(formulario.ruta, path.join(dirPaquete, formularioEnPaquete))
      }
      const rev = await revisarSoportes(ctx.directory, c.soportesExigidos, hoy)
      const copiados = await copiarSoportes(ctx.directory, rev, dirPaquete)
      const lista = bloqueos(rev, formulario !== null)
      const listo = lista.length === 0
      const datos = { caso: c, hoy, formulario: formularioEnPaquete, rev, mapeo, listo, bloqueos: lista }

      await writeFile(path.join(dirPaquete, "checklist.md"), checklistMd(datos), "utf8")
      const adjuntos = [
        ...(formularioEnPaquete && c.solicitud.formato !== "portal" ? [`Formulario diligenciado y firmado (${formularioEnPaquete})`] : []),
        // Un soporte vencido no se adjunta: queda como pendiente en la nota interna.
        ...rev.presentes.map((s) => s.nombre),
      ]
      const correo = borradorCorreoMd(datos, await cargarMaestro(ctx.directory), adjuntos)
      await writeFile(path.join(dirPaquete, "borrador-correo.md"), correo.texto, "utf8")

      const estado: EstadoPaquete = {
        caso,
        ruta: relativa(ctx.directory, dirPaquete),
        listo_para_firma: listo,
        bloqueos: lista,
        destinatario: c.solicitud.de,
        asunto: `RE: ${c.solicitud.asunto}`,
        adjuntos,
        fecha_revision: hoy,
      }
      await writeFile(rutaEstadoPaquete(ctx.directory, caso), JSON.stringify(estado, null, 2), "utf8")

      const faltantes = mapeo?.campos.filter((m) => m.estado === "faltante").map((m) => m.etiqueta) ?? []
      const porConfirmar = mapeo?.campos.filter((m) => m.estado === "requiere_confirmacion").map((m) => m.etiqueta) ?? []
      return {
        data: {
          ruta: estado.ruta,
          listo_para_firma: listo,
          checklist: {
            fecha_referencia: hoy,
            formulario: formularioEnPaquete,
            soportes: { presentes: rev.presentes, vencidos: rev.vencidos, ausentes: rev.ausentes, por_vencer: rev.por_vencer },
            campos_faltantes: faltantes,
            campos_por_confirmar: porConfirmar,
            bloqueos: lista,
          },
          archivos: [formularioEnPaquete, ...copiados, "checklist.md", "borrador-correo.md"].filter((a): a is string => a !== null),
          ...(formulario?.generadoAhora ? { nota: "El formulario no existía y se generó automáticamente." } : {}),
        },
        resumen: `${caso}: paquete en ${estado.ruta}; listo_para_firma=${listo}; ${rev.vencidos.length} vencidos, ${rev.ausentes.length} ausentes, ${faltantes.length} campos faltantes${correo.omitidos ? `; ${correo.omitidos} datos bancarios omitidos del correo` : ""}`,
      }
    }),
}

const argsEnvio = {
  caso: CasoSchema,
  confirmado: z
    .boolean()
    .describe("true solo si el usuario confirmó explícitamente el envío en su último mensaje; en cualquier otro caso false."),
}

export const simular_envio: Herramienta<typeof argsEnvio> = {
  description:
    "Simula el envío del paquete al cliente escribiendo out/<caso>/ENVIO-SIMULADO.md; exige confirmado=true, que solo procede tras una confirmación explícita del usuario.",
  args: argsEnvio,
  execute: (args, ctx) =>
    ejecutar("proveedor_simular_envio", argsEnvio, args, ctx, async ({ caso, confirmado }) => {
      if (!confirmado) throw new ErrorHerramienta("requiere confirmación explícita")
      await cargarCaso(ctx.directory, caso)
      const estado = await leerEstadoPaquete(ctx.directory, caso)
      if (!estado) throw new ErrorHerramienta(`No hay paquete armado para "${caso}". Ejecuta proveedor_armar_paquete antes de simular el envío.`)
      const destino = path.join(dirSalidaCaso(ctx.directory, caso), "ENVIO-SIMULADO.md")
      const ts = new Date().toISOString()
      const md = [
        `# Envío simulado — ${caso}`,
        "",
        "> SIMULACIÓN. No se envió ningún correo ni se cargó nada a ningún portal.",
        "",
        `- Fecha: ${ts}`,
        `- Confirmado por el usuario en la sesión \`${ctx.sessionId}\``,
        `- Para: ${estado.destinatario}`,
        `- Asunto: ${estado.asunto}`,
        `- Paquete: ${estado.ruta}/`,
        `- Listo para firma al momento del envío: ${estado.listo_para_firma ? "sí" : "NO"}`,
        "",
        "## Adjuntos",
        "",
        ...estado.adjuntos.map((a) => `- ${a}`),
        ...(estado.bloqueos.length ? ["", "## Advertencia: se simuló con bloqueos pendientes", "", ...estado.bloqueos.map((b) => `- ${b}`)] : []),
        "",
      ].join("\n")
      await writeFile(destino, md, "utf8")
      return {
        data: { ruta: relativa(ctx.directory, destino), listo_para_firma: estado.listo_para_firma, bloqueos_pendientes: estado.bloqueos },
        resumen: `${caso}: envío simulado en ${relativa(ctx.directory, destino)}${estado.listo_para_firma ? "" : " (con bloqueos pendientes)"}`,
      }
    }),
}
