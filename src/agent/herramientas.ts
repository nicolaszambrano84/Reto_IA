import { z } from "zod"
import type { DefinicionHerramienta } from "../llm/adapter"
import * as proveedor from "../tools/proveedor"
import { registrar } from "../tools/lib/ejecucion"
import type { ContextoHerramienta, Herramienta } from "../tools/lib/tipos"

export interface HerramientaRegistrada {
  definicion: DefinicionHerramienta
  ejecutar(args: unknown, ctx: ContextoHerramienta): Promise<string>
}

function jsonSchema(esquema: z.ZodObject): Record<string, unknown> {
  const { $schema: _omitido, ...resto } = z.toJSONSchema(esquema) as Record<string, unknown>
  return resto
}

/** Envuelve una herramienta: el backend valida con zod antes de ejecutar y devuelve el error al modelo. */
function registrarHerramienta<A extends z.ZodRawShape>(archivo: string, exportado: string, h: Herramienta<A>): HerramientaRegistrada {
  const nombre = `${archivo}_${exportado}`
  const esquema = z.object(h.args)
  return {
    definicion: { nombre, descripcion: h.description, parametros: jsonSchema(esquema) },
    async ejecutar(args, ctx) {
      const r = esquema.safeParse(args)
      if (r.success) return h.execute(r.data, ctx)
      const error = `Argumentos inválidos para ${nombre}: ${r.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ")}`
      await registrar(ctx, { ts: new Date().toISOString(), herramienta: nombre, ok: false, resumen: error, sessionId: ctx.sessionId }, false)
      return JSON.stringify({ ok: false, error })
    },
  }
}

// El tipo obliga a registrar cada export de src/tools/proveedor.ts: añadir una herramienta sin
// registrarla es un error de compilación.
const registro: { [K in keyof typeof proveedor]: HerramientaRegistrada } = {
  leer_solicitud: registrarHerramienta("proveedor", "leer_solicitud", proveedor.leer_solicitud),
  mapear_campos: registrarHerramienta("proveedor", "mapear_campos", proveedor.mapear_campos),
  generar_formulario: registrarHerramienta("proveedor", "generar_formulario", proveedor.generar_formulario),
  armar_paquete: registrarHerramienta("proveedor", "armar_paquete", proveedor.armar_paquete),
  simular_envio: registrarHerramienta("proveedor", "simular_envio", proveedor.simular_envio),
}

export const HERRAMIENTAS: ReadonlyMap<string, HerramientaRegistrada> = new Map(
  Object.values(registro).map((h) => [h.definicion.nombre, h]),
)

export const DEFINICIONES: DefinicionHerramienta[] = [...HERRAMIENTAS.values()].map((h) => h.definicion)

export const HERRAMIENTA_ENVIO = "proveedor_simular_envio"
export const HERRAMIENTA_PAQUETE = "proveedor_armar_paquete"
