/**
 * Verificación sin modelo (PRD §6.6): limpia out/, ejecuta todos los casos de fixtures/reto-01/casos/
 * llamando directamente a las herramientas e imprime un resumen por caso.
 *
 *   npm run demo
 */
import { readdir, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as proveedor from "./src/tools/proveedor"
import { verificarModulo } from "./scripts/sync-modulo"

const directory = path.dirname(fileURLToPath(import.meta.url))
const ctx = { directory, sessionId: "demo" }

type Respuesta = { ok: true; data: Record<string, unknown> } | { ok: false; error: string }

function parse(texto: string): Respuesta {
  return JSON.parse(texto) as Respuesta
}

function lista(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function etiquetas(v: unknown, campo = "etiqueta"): string {
  const items = lista(v).map((x) => (typeof x === "object" && x !== null && campo in x ? String((x as Record<string, unknown>)[campo]) : String(x)))
  return items.length ? items.join(", ") : "—"
}

async function procesar(caso: string): Promise<boolean> {
  console.log(`\n━━━ ${caso} ${"━".repeat(Math.max(0, 60 - caso.length))}`)
  const leida = parse(await proveedor.leer_solicitud.execute({ caso }, ctx))
  if (!leida.ok) {
    console.log(`  ✗ leer_solicitud: ${leida.error}`)
    return false
  }
  const d = leida.data
  console.log(`  Cliente: ${String(d.cliente)} · país ${String(d.pais)} · formato ${String(d.formato)}`)
  console.log(`  Campos pedidos: ${lista(d.campos).length} · soportes exigidos: ${etiquetas(d.soportes, "tipo")}`)
  if (lista(d.requiere_confirmacion).length) console.log(`  Tributarios por confirmar: ${etiquetas(d.requiere_confirmacion)}`)

  const campos = lista(d.campos).map((c) => String((c as { etiqueta: string }).etiqueta))
  const mapeo = parse(await proveedor.mapear_campos.execute({ caso, campos }, ctx))
  if (mapeo.ok) {
    console.log(`  Llenos (${lista(mapeo.data.llenos).length}): ${etiquetas(mapeo.data.llenos)}`)
    console.log(`  Faltantes (${lista(mapeo.data.faltantes).length}): ${etiquetas(mapeo.data.faltantes)}`)
    console.log(`  Requiere confirmación (${lista(mapeo.data.requiere_confirmacion).length}): ${etiquetas(mapeo.data.requiere_confirmacion)}`)
  } else console.log(`  ✗ mapear_campos: ${mapeo.error}`)

  const form = parse(await proveedor.generar_formulario.execute({ caso, mapeo: mapeo.ok ? mapeo.data : undefined }, ctx))
  if (form.ok) console.log(`  Formulario: ${String(form.data.ruta)}${form.data.aviso ? `  ⚠ ${String(form.data.aviso)}` : ""}`)
  else console.log(`  ✗ generar_formulario: ${form.error}`)

  const paq = parse(await proveedor.armar_paquete.execute({ caso }, ctx))
  if (paq.ok) {
    const ch = paq.data.checklist as { soportes: Record<string, unknown>; bloqueos: string[] }
    console.log(`  Paquete: ${String(paq.data.ruta)} · listo_para_firma = ${String(paq.data.listo_para_firma)}`)
    console.log(`  Soportes presentes: ${etiquetas(ch.soportes.presentes, "tipo")} · vencidos: ${etiquetas(ch.soportes.vencidos, "tipo")} · ausentes: ${etiquetas(ch.soportes.ausentes, "tipo")}`)
  } else console.log(`  ✗ armar_paquete: ${paq.error}`)

  const sinConfirmar = parse(await proveedor.simular_envio.execute({ caso, confirmado: false }, ctx))
  console.log(`  simular_envio(confirmado=false) → ${sinConfirmar.ok ? "ok (¡inesperado!)" : sinConfirmar.error}`)
  const envio = parse(await proveedor.simular_envio.execute({ caso, confirmado: true }, ctx))
  console.log(`  simular_envio(confirmado=true)  → ${envio.ok ? String(envio.data.ruta) : envio.error}`)
  return leida.ok && mapeo.ok && form.ok && paq.ok && !sinConfirmar.ok && envio.ok
}

async function main(): Promise<void> {
  await rm(path.join(directory, "out"), { recursive: true, force: true })
  console.log("out/ limpio. Fecha de referencia para vigencias:", process.env.FECHA_EJECUCION ?? new Date().toLocaleDateString("sv-SE"))

  const casos = (await readdir(path.join(directory, "fixtures", "reto-01", "casos"), { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
  const resultados: Array<[string, boolean]> = []
  for (const caso of casos) resultados.push([caso, await procesar(caso)])

  console.log("\n━━━ Manejo de errores (HU-5) ━━━")
  const inexistente = parse(await proveedor.leer_solicitud.execute({ caso: "no-existe" }, ctx))
  console.log(`  Caso inexistente → ${inexistente.ok ? "ok (¡inesperado!)" : inexistente.error}`)
  const invalido = parse(await proveedor.leer_solicitud.execute({ caso: "../etc" }, ctx))
  console.log(`  Caso con ruta maliciosa → ${invalido.ok ? "ok (¡inesperado!)" : invalido.error}`)

  const modulo = await verificarModulo(directory)
  console.log(`\n━━━ Módulo reutilizable ━━━\n  ${modulo.ok ? "✓ modulo/ sincronizado con agent/prompt.md y src/knowledge/" : `✗ ${modulo.diferencias.join("; ")} (ejecuta npm run modulo)`}`)

  console.log("\n━━━ Resumen ━━━")
  for (const [caso, ok] of resultados) console.log(`  ${ok ? "✓" : "✗"} ${caso}`)
  console.log("  Logs: out/log.jsonl y out/<caso>/log.jsonl")
  if (resultados.some(([, ok]) => !ok) || inexistente.ok || invalido.ok) process.exitCode = 1
}

main().catch((e: unknown) => {
  console.error("La demo falló:", e instanceof Error ? e.message : e)
  process.exitCode = 1
})
