#!/usr/bin/env node
// dsh-hdc-mcp — standalone MCP server for HarmonyOS/OpenHarmony development.
import { main } from '../src/server.mjs'

const code = main(process.argv.slice(2))
if (code !== 0) process.exit(code)
