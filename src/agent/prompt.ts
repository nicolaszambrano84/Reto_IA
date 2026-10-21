import { readFile } from "node:fs/promises"
import path from "node:path"

/**
 * System prompt = comportamiento (agent/prompt.md) + conocimiento (src/knowledge/registro-proveedor.md).
 * Cambiar reglas o tono no toca el código: se editan esos Markdown.
 */
export async function cargarSistema(directory: string, casos: string[]): Promise<string> {
  const [comportamiento, conocimiento] = await Promise.all([
    readFile(path.join(directory, "agent", "prompt.md"), "utf8"),
    readFile(path.join(directory, "src", "knowledge", "registro-proveedor.md"), "utf8"),
  ])
  return [
    comportamiento.trim(),
    "---",
    "# Conocimiento del proceso",
    conocimiento.trim(),
    "---",
    `Casos disponibles en fixtures/reto-01/casos/: ${casos.join(", ")}.`,
  ].join("\n\n")
}
