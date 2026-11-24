// Assembles the complete tool set of the standalone MCP server.
//
// 16 device tools (hdc_*) + 8 official toolchain/knowledge tools (hms_*) +
// 4 compile tools + hdc_log + hdc_guide.
//
// The tool names are identical to the DSH plugin's, so the operating habits
// transfer one-to-one.

import { createRuntime } from '../core/runtime.mjs'
import { buildGuideTool } from '../core/guide.mjs'
import { buildDeviceTools } from './device.mjs'
import { buildToolchainTools } from './toolchain.mjs'
import { buildCompileTools } from './compile.mjs'

export function buildTools() {
  const rt = createRuntime()
  const tools = [
    ...buildDeviceTools(rt),
    ...buildToolchainTools(rt),
    ...buildCompileTools(rt),
    buildGuideTool(),
  ]
  // Guard against an accidental duplicate name: MCP clients index tools by
  // name, so a collision would silently drop one.
  const seen = new Set()
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error('duplicate tool name: ' + tool.name)
    seen.add(tool.name)
  }
  return tools
}
