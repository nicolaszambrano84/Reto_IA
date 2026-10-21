/**
 * Pruebas de comportamiento sin red ni API key:  npm test
 * Usan una copia temporal de fixtures/ para simular plantillas dañadas sin tocar los originales.
 */
import assert from "node:assert/strict"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { procesarTurno, type ConfigCiclo } from "../src/agent/ciclo"
import type { Sesion } from "../src/agent/sesiones"
import { ErrorProveedor, type Mensaje, type ProveedorLLM, type RespuestaModelo } from "../src/llm/adapter"
import { ProveedorLocal } from "../src/llm/local"
import { ProveedorConRespaldo } from "../src/llm/provider"
import * as proveedor from "../src/tools/proveedor"

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CASOS = ["co-industrias-delta", "ec-corp-andina", "hn-agroexport-sula", "pa-logistica-istmo"]

function sesion(id: string): Sesion {
  return { id, creada: "", mensajes: [], turnos: [], tokens: { entrada: 0, salida: 0 }, confirmacionPendiente: null }
}

/** Modelo falso que siempre intenta enviar con confirmado=true (simula un LLM desobediente). */
class ModeloImpaciente implements ProveedorLLM {
  readonly nombre = "falso"
  readonly modelo = "impaciente"
  async enviar(mensajes: Mensaje[]): Promise<RespuestaModelo> {
    const ultimo = mensajes.at(-1)
    if (ultimo?.rol === "herramienta") return { texto: "Hecho.", llamadas: [], uso: { entrada: 10, salida: 5 } }
    return { texto: "", llamadas: [{ id: "x1", nombre: "proveedor_simular_envio", argumentos: { caso: "co-industrias-delta", confirmado: true } }], uso: { entrada: 10, salida: 5 } }
  }
}

class ModeloEnBucle implements ProveedorLLM {
  readonly nombre = "falso"
  readonly modelo = "bucle"
  async enviar(): Promise<RespuestaModelo> {
    return { texto: "", llamadas: [{ id: crypto.randomUUID(), nombre: "proveedor_leer_solicitud", argumentos: { caso: "co-industrias-delta" } }], uso: { entrada: 1, salida: 1 } }
  }
}

class ModeloCaido implements ProveedorLLM {
  readonly nombre = "caido"
  readonly modelo = "x"
  async enviar(): Promise<RespuestaModelo> {
    throw new ErrorProveedor("El proveedor caido no respondió en 45 s.")
  }
}

function ciclo(p: ProveedorLLM, directory: string, maxIteraciones = 25): ConfigCiclo {
  return { proveedor: p, sistema: "prueba", directory, maxIteraciones, maxTokensSesion: 1_000_000 }
}

const pruebas: Array<[string, (dir: string) => Promise<void>]> = [
  [
    "RN4: el servidor bloquea un envío que el modelo intenta sin confirmación previa",
    async (dir) => {
      await proveedor.armar_paquete.execute({ caso: "co-industrias-delta" }, { directory: dir, sessionId: "t" })
      const s = sesion("gate")
      const r = await procesarTurno(s, "sí, envía", ciclo(new ModeloImpaciente(), dir))
      assert.equal(r.toolCalls[0]?.bloqueadaPorConfirmacion, true)
      assert.equal(r.toolCalls[0]?.ok, false)
      assert.equal(r.toolCalls[0]?.resultado, "requiere confirmación explícita")
      assert.equal(r.needsConfirmation, true)
      assert.match(r.reply, /\?/)
      // Turno siguiente: ahora sí hay ventana de confirmación.
      const r2 = await procesarTurno(s, "sí, envía", ciclo(new ModeloImpaciente(), dir))
      assert.equal(r2.toolCalls[0]?.ok, true)
      await readFile(path.join(dir, "out/co-industrias-delta/ENVIO-SIMULADO.md"), "utf8")
    },
  ],
  [
    "Flujo §11 en modo determinista: resume, pregunta y luego simula el envío",
    async (dir) => {
      const s = sesion("demo11")
      const local = new ProveedorLocal(() => CASOS)
      const r1 = await procesarTurno(s, 'Procesa el caso "ec-corp-andina". Dime qué campos quedaron llenos, cuáles faltan, si el paquete está listo para firma y qué soportes debo actualizar. No envíes nada todavía.', ciclo(local, dir))
      assert.deepEqual(r1.toolCalls.map((t) => t.nombre), ["proveedor_leer_solicitud", "proveedor_mapear_campos", "proveedor_generar_formulario", "proveedor_armar_paquete"])
      assert.equal(r1.needsConfirmation, true)
      assert.match(r1.reply, /Listo para firma: NO/)
      assert.match(r1.reply, /Número de contribuyente especial/)
      const r2 = await procesarTurno(s, "envía", ciclo(local, dir))
      assert.equal(r2.toolCalls.length, 1)
      assert.equal(r2.toolCalls[0]?.nombre, "proveedor_simular_envio")
      assert.equal(r2.toolCalls[0]?.ok, true)
      assert.equal(r2.needsConfirmation, false)
    },
  ],
  [
    "CA1: el tope de iteraciones corta el bucle y responde con lo hecho",
    async (dir) => {
      const r = await procesarTurno(sesion("tope"), "procesa", ciclo(new ModeloEnBucle(), dir, 3))
      assert.equal(r.toolCalls.length, 3)
      assert.match(r.reply, /tope de 3 iteraciones/)
    },
  ],
  [
    "CA5: si el proveedor cae, responde el respaldo determinista con aviso y la sesión sigue",
    async (dir) => {
      const p = new ProveedorConRespaldo(new ModeloCaido(), new ProveedorLocal(() => CASOS))
      const r = await procesarTurno(sesion("caida"), "Procesa el caso hn-agroexport-sula", ciclo(p, dir))
      assert.equal(r.toolCalls.length, 4)
      assert.ok(r.avisos.some((a) => a.includes("no respondió")))
    },
  ],
  [
    "HU-5: plantilla corrupta → error claro y el paquete igual se arma con los soportes",
    async (dir) => {
      await writeFile(path.join(dir, "fixtures/reto-01/casos/co-industrias-delta/plantilla-celdas.json"), "{ esto no es json", "utf8")
      const ctx = { directory: dir, sessionId: "t" }
      const leida = JSON.parse(await proveedor.leer_solicitud.execute({ caso: "co-industrias-delta" }, ctx))
      assert.equal(leida.ok, true)
      assert.match(leida.data.advertencias[0], /corrupto/)
      const form = JSON.parse(await proveedor.generar_formulario.execute({ caso: "co-industrias-delta" }, ctx))
      assert.equal(form.ok, false)
      assert.doesNotMatch(form.error, /at |Error:/)
      await rm(path.join(dir, "out/co-industrias-delta"), { recursive: true, force: true })
      const paq = JSON.parse(await proveedor.armar_paquete.execute({ caso: "co-industrias-delta" }, ctx))
      assert.equal(paq.ok, true)
      assert.equal(paq.data.listo_para_firma, false)
      assert.ok(paq.data.checklist.bloqueos.includes("el formulario no pudo generarse"))
    },
  ],
  [
    "RN2: ningún borrador de correo contiene datos bancarios; el modelo ve la cuenta enmascarada",
    async (dir) => {
      const ctx = { directory: dir, sessionId: "t" }
      for (const caso of ["ec-corp-andina", "pa-logistica-istmo"]) {
        await proveedor.armar_paquete.execute({ caso }, ctx)
        const correo = await readFile(path.join(dir, `out/${caso}/paquete/borrador-correo.md`), "utf8")
        for (const dato of ["03100012345", "COLOCOBM", "Bancolombia"]) assert.ok(!correo.includes(dato), `${caso} contiene ${dato}`)
      }
      const m = JSON.parse(await proveedor.mapear_campos.execute({ caso: "ec-corp-andina" }, ctx))
      const cuenta = m.data.llenos.find((c: { etiqueta: string }) => c.etiqueta === "Número de cuenta")
      assert.equal(cuenta.valor, "*******2345")
    },
  ],
  [
    "RN3: con FECHA_EJECUCION anterior a los vencimientos, co-industrias-delta queda listo para firma",
    async (dir) => {
      process.env.FECHA_EJECUCION = "2026-08-30"
      try {
        const r = JSON.parse(await proveedor.armar_paquete.execute({ caso: "co-industrias-delta" }, { directory: dir, sessionId: "t" }))
        assert.equal(r.data.listo_para_firma, true)
      } finally {
        delete process.env.FECHA_EJECUCION
      }
    },
  ],
]

async function main(): Promise<void> {
  let fallas = 0
  for (const [nombre, prueba] of pruebas) {
    const dir = await mkdtemp(path.join(tmpdir(), "reto01-"))
    await cp(path.join(RAIZ, "fixtures"), path.join(dir, "fixtures"), { recursive: true })
    try {
      await prueba(dir)
      console.log(`✓ ${nombre}`)
    } catch (e) {
      fallas++
      console.log(`✗ ${nombre}\n   ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  console.log(`\n${pruebas.length - fallas}/${pruebas.length} pruebas pasaron`)
  if (fallas) process.exitCode = 1
}

await main()
