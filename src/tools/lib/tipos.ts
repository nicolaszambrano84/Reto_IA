import type { z } from "zod"

/** Contexto que el host (servidor, demo u otra plataforma de agentes) entrega a cada herramienta. */
export interface ContextoHerramienta {
  /** Raíz del proyecto. Todas las rutas se resuelven desde aquí. */
  directory: string
  sessionId: string
}

/** Contrato de la sección 6.2 del PRD. El nombre que ve el modelo es `proveedor_<export>`. */
export interface Herramienta<A extends z.ZodRawShape> {
  description: string
  args: A
  execute(args: z.infer<z.ZodObject<A>>, ctx: ContextoHerramienta): Promise<string>
}

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }

/** Error esperado (caso inexistente, plantilla corrupta…). Su mensaje se muestra tal cual al usuario. */
export class ErrorHerramienta extends Error {
  override name = "ErrorHerramienta"
}

export type Formato = "xlsx" | "pdf" | "portal"
export type EstadoCampo = "lleno" | "faltante" | "requiere_confirmacion"
