/**
 * Genera las piezas de modulo/ a partir de las fuentes que usa la aplicación, para que nunca diverjan:
 *   agent/prompt.md                    → modulo/agent.md (frontmatter + cuerpo)
 *   src/knowledge/registro-proveedor.md → modulo/skill/registro-proveedor/SKILL.md
 * modulo/tools/proveedor.ts es un re-export de src/tools/proveedor.ts y no se genera.
 *
 *   npm run modulo          # regenera
 *   npm run modulo:check    # falla si están desincronizados
 */
import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const FRONT_AGENTE = [
  "---",
  "description: Prepara el registro de Periferia IT Group como proveedor ante clientes; lee la solicitud, llena el formulario desde el maestro y arma el paquete para firma sin enviar nada sin confirmación.",
  "mode: primary",
  "permission:",
  "  edit: deny",
  "  bash: deny",
  "---",
  "",
].join("\n")

const FRONT_SKILL = [
  "---",
  "name: registro-proveedor",
  "description: Conocimiento del proceso de registro como proveedor de Periferia IT Group (flujo, estados de campo, reglas RN1-RN5, soportes y reparto agente/humano). Úsalo al procesar solicitudes de registro de clientes en CO, EC, PE, PA o HN.",
  "---",
  "",
].join("\n")

interface Pieza {
  fuente: string
  destino: string
  frontmatter: string
}

const PIEZAS: Pieza[] = [
  { fuente: "agent/prompt.md", destino: "modulo/agent.md", frontmatter: FRONT_AGENTE },
  { fuente: "src/knowledge/registro-proveedor.md", destino: "modulo/skill/registro-proveedor/SKILL.md", frontmatter: FRONT_SKILL },
]

const normalizarEol = (t: string) => t.replace(/\r\n/g, "\n")

async function esperado(directory: string, p: Pieza): Promise<string> {
  return p.frontmatter + normalizarEol(await readFile(path.join(directory, p.fuente), "utf8"))
}

export async function verificarModulo(directory: string): Promise<{ ok: boolean; diferencias: string[] }> {
  const diferencias: string[] = []
  for (const p of PIEZAS) {
    const actual = await readFile(path.join(directory, p.destino), "utf8").catch(() => null)
    if (actual === null) diferencias.push(`${p.destino} no existe`)
    else if (normalizarEol(actual) !== (await esperado(directory, p))) diferencias.push(`${p.destino} difiere de ${p.fuente}`)
  }
  const reexport = await readFile(path.join(directory, "modulo/tools/proveedor.ts"), "utf8").catch(() => "")
  if (!reexport.includes('from "../../src/tools/proveedor"')) diferencias.push("modulo/tools/proveedor.ts no re-exporta src/tools/proveedor.ts")
  return { ok: diferencias.length === 0, diferencias }
}

async function sincronizar(directory: string): Promise<void> {
  for (const p of PIEZAS) {
    const destino = path.join(directory, p.destino)
    await mkdir(path.dirname(destino), { recursive: true })
    await writeFile(destino, await esperado(directory, p), "utf8")
    console.log(`✓ ${p.destino} ← ${p.fuente}`)
  }
}

const esScript = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (esScript) {
  const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  if (process.argv.includes("--check")) {
    const r = await verificarModulo(directory)
    console.log(r.ok ? "✓ modulo/ sincronizado" : `✗ ${r.diferencias.join("\n✗ ")}`)
    if (!r.ok) process.exitCode = 1
  } else {
    await sincronizar(directory)
  }
}
