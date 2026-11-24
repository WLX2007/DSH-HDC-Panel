// Mapping between the internal tool definitions and the MCP wire format.
//
// Internal tool shape:
//   { name, description, inputSchema, async execute(args) -> object }
//
// MCP tool shape (tools/list):
//   { name, description, inputSchema }
//
// MCP result shape (tools/call):
//   { content: ContentBlock[], isError?: boolean, structuredContent?: object }
//
// The internal contract of this server is "never throw, always return a
// business value": a tool result carrying `ok: false` is reported as an MCP
// error result (isError: true) with the full JSON still in the text block, so
// the model sees both the verdict and the payload.

export function toMcpTool(def) {
  const tool = {
    name: def.name,
    description: def.description || '',
    inputSchema: def.inputSchema || { type: 'object', properties: {}, required: [] },
  }
  return tool
}

export function toMcpResult(value) {
  const content = []
  let payload = value

  if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.image && payload.image.data) {
    content.push({
      type: 'image',
      data: String(payload.image.data),
      mimeType: String(payload.image.mimeType || 'image/jpeg'),
    })
    const { image, ...rest } = payload
    payload = rest
  }

  const text = typeof payload === 'string'
    ? payload
    : (payload === undefined ? '' : JSON.stringify(payload, null, 2))
  content.push({ type: 'text', text })

  const isError = !!(payload && typeof payload === 'object' && !Array.isArray(payload) && payload.ok === false)
  const result = { content }
  if (isError) result.isError = true
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) result.structuredContent = payload
  return result
}

// A thrown tool is still a tool-level failure, not a protocol error: report it
// through the result with isError so the client can show it to the model.
export function toolErrorResult(error) {
  const message = String((error && error.message) || error || 'unknown error')
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }],
    isError: true,
    structuredContent: { ok: false, error: message },
  }
}
