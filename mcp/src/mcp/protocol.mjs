// MCP request handling (JSON-RPC 2.0 over the transport).
//
// The server speaks the Model Context Protocol: initialize, tools/list and
// tools/call are the methods this server implements, plus ping and the
// logging level notification. Notifications (messages without an id) never
// produce a response.

import { toMcpTool, toMcpResult, toolErrorResult } from './tools.mjs'

// Protocol revisions this server understands, newest first.
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
export const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
}

function errorResponse(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error }
}

export function createServer(options) {
  const tools = options.tools || []
  const serverInfo = options.serverInfo || { name: 'dsh-hdc-mcp', version: '1.0.0' }
  const instructions = options.instructions || ''
  const toolMap = new Map(tools.map((t) => [t.name, t]))

  function negotiateVersion(requested) {
    const value = String(requested || '')
    if (value && SUPPORTED_PROTOCOL_VERSIONS.includes(value)) return value
    return DEFAULT_PROTOCOL_VERSION
  }

  async function handleToolsCall(id, params) {
    const name = params && params.name
    if (!name || typeof name !== 'string') {
      return errorResponse(id, ERROR_CODES.INVALID_PARAMS, 'tools/call requires a tool name')
    }
    const tool = toolMap.get(name)
    if (!tool) {
      return errorResponse(id, ERROR_CODES.INVALID_PARAMS, 'Unknown tool: ' + name, { available: Array.from(toolMap.keys()) })
    }
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {}
    try {
      const value = await tool.execute(args)
      return { jsonrpc: '2.0', id: id === undefined ? null : id, result: toMcpResult(value) }
    } catch (e) {
      return { jsonrpc: '2.0', id: id === undefined ? null : id, result: toolErrorResult(e) }
    }
  }

  // Returns the JSON-RPC response for a request, or null for notifications.
  async function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return errorResponse(null, ERROR_CODES.INVALID_REQUEST, 'Invalid JSON-RPC request')
    }
    const { method, id, params } = message
    const isNotification = id === undefined || id === null

    if (typeof method !== 'string') {
      return errorResponse(id, ERROR_CODES.INVALID_REQUEST, 'Invalid JSON-RPC request: method must be a string')
    }
    if (method.startsWith('notifications/')) {
      // Notifications never get a response.
      return null
    }

    switch (method) {
      case 'initialize': {
        const protocolVersion = negotiateVersion(params && params.protocolVersion)
        const result = {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
        }
        if (instructions) result.instructions = instructions
        return { jsonrpc: '2.0', id: id === undefined ? null : id, result }
      }
      case 'ping':
        return { jsonrpc: '2.0', id: id === undefined ? null : id, result: {} }
      case 'tools/list':
        return { jsonrpc: '2.0', id: id === undefined ? null : id, result: { tools: tools.map(toMcpTool) } }
      case 'tools/call':
        return handleToolsCall(id, params)
      case 'logging/setLevel':
        return { jsonrpc: '2.0', id: id === undefined ? null : id, result: {} }
      case 'completion/complete':
        return errorResponse(id, ERROR_CODES.METHOD_NOT_FOUND, 'completion/complete is not supported')
      default:
        if (isNotification) return null
        return errorResponse(id, ERROR_CODES.METHOD_NOT_FOUND, 'Method not found: ' + method)
    }
  }

  return { handle, tools, toolMap }
}
