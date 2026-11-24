// Entry point of the standalone dsh-hdc-mcp server.
//
//   dsh-hdc-mcp            start the MCP server on stdio
//   dsh-hdc-mcp --help     usage
//   dsh-hdc-mcp --version  version
//
// The process is a plain MCP server: stdout carries JSON-RPC frames only,
// every log line goes to stderr.

import { createRequire } from 'node:module'
import { buildTools } from './tools/index.mjs'
import { createServer, SUPPORTED_PROTOCOL_VERSIONS } from './mcp/protocol.mjs'
import { createStdioTransport } from './mcp/stdio.mjs'
import { INSTRUCTIONS } from './core/guide.mjs'

const require = createRequire(import.meta.url)

function readVersion() {
  try {
    return require('../package.json').version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function log(message) {
  try { process.stderr.write('[dsh-hdc-mcp] ' + message + '\n') } catch { /* stderr closed */ }
}

const HELP = [
  'dsh-hdc-mcp — standalone MCP server for HarmonyOS/OpenHarmony development',
  '',
  'Usage:',
  '  dsh-hdc-mcp                 run the MCP server on stdio (default)',
  '  dsh-hdc-mcp --help          show this help',
  '  dsh-hdc-mcp --version       print the version',
  '',
  'Client configuration example (stdio):',
  '  {',
  '    "mcpServers": {',
  '      "dsh-hdc": {',
  '        "command": "node",',
  '        "args": ["/path/to/dsh-hdc-mcp/bin/dsh-hdc-mcp.mjs"],',
  '        "cwd": "/path/to/your/harmonyos/project"',
  '      }',
  '    }',
  '  }',
  '',
  'Environment variables:',
  '  DEVECO_SDK_HOME                explicit SDK root',
  '  DEVECO_CLI_CLT_PATH            standalone Command Line Tools root',
  '  COMMAND_LINE_TOOL_PATH         alias of DEVECO_CLI_CLT_PATH',
  '  DEVECO_ARKTS_CHECK_SCRIPT      override the bundled arkts-check script',
  '  DSH_HDC_MCP_KNOWLEDGE_DIR      override the bundled knowledge directory',
].join('\n')

export function main(argv = []) {
  const args = Array.isArray(argv) ? argv : []
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP + '\n')
    return 0
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(readVersion() + '\n')
    return 0
  }
  const unknown = args.filter((a) => a.startsWith('-'))
  if (unknown.length) {
    log('ignoring unknown argument(s): ' + unknown.join(' '))
  }

  let tools
  try {
    tools = buildTools()
  } catch (e) {
    log('failed to build the tool set: ' + String((e && e.message) || e))
    return 1
  }

  const server = createServer({
    tools,
    instructions: INSTRUCTIONS,
    serverInfo: { name: 'dsh-hdc-mcp', version: readVersion() },
  })

  const transport = createStdioTransport({
    onMessage: async (message) => {
      const response = await server.handle(message)
      if (response) transport.send(response)
    },
    onError: (e) => log('transport error: ' + String((e && e.message) || e)),
    onClose: () => {
      log('stdin closed; shutting down')
      process.exit(0)
    },
  })

  log('ready: ' + tools.length + ' tools on stdio (MCP ' + SUPPORTED_PROTOCOL_VERSIONS[0] + ')')
  return 0
}
