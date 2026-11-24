// Quoting helpers for the standalone MCP server.
//
// The standalone server has no DSH sandbox and no mounted host shell: every
// command runs through child_process.spawn. Two quoting layers remain:
//
//   1. HOST LAYER — used only for the few flows that genuinely need a shell
//      (devecocli, hvigorw, arkts-check, directory listings). Those build a
//      command *string* and hand it to the shell, so the string must be quoted
//      for that shell's dialect.
//   2. DEVICE LAYER — hdc is spawned with an argv array, so no host quoting
//      is involved at all: the bytes handed to `hdc shell` reach the on-device
//      sh verbatim. Apostrophes are handled by base64-encoding the command
//      (see tools/device.mjs), because HarmonyOS sh would otherwise end the
//      quoted string early.
//
// PowerShell's '' doubling and POSIX quote-splicing are NOT interchangeable:
// in POSIX shells two adjacent quotes close and reopen with an EMPTY middle
// ('it''s' parses as its), so each quoting layer keeps its own helper.

export const BACKSLASH = String.fromCharCode(92)
export const APOS = "'"

export const IS_WINDOWS = process.platform === 'win32'

// The dialect of the shell this server spawns for the host layer. Windows
// always gets PowerShell; POSIX gets a POSIX shell.
export const SHELL_FLAVOR = IS_WINDOWS ? 'pwsh' : 'bash'

export const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'"
export const posixQuote = (s) => "'" + String(s).replace(/'/g, "'" + BACKSLASH + "''") + "'"

// Dialect-aware quote for the host layer.
export const quote = (s) => (SHELL_FLAVOR === 'pwsh' ? psQuote(s) : posixQuote(s))

// Escape a command for the on-device sh. Kept for the device layer only; the
// host layer no longer participates in hdc invocations.
export const dcFidelityCommand = (command, flavor = SHELL_FLAVOR) =>
  (flavor === 'pwsh' ? psQuote(command) : posixQuote(command))
