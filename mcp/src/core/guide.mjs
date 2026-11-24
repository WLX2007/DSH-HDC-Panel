// Operational guides for the standalone MCP server.
//
// The DSH plugin exposed these as runtime "skills" that the host injected
// into the model's context. MCP has no skill concept, so the same material
// is served two ways:
//   - a compact workflow summary in the initialize response `instructions`
//   - the full guides on demand through the hdc_guide tool
//
// The `deveco-cli` guide is an adaptation (translated summary, not a verbatim
// copy) of the official SKILL.md from gitcode.com/openharmony-sig/deveco-cli,
// licensed MIT — Copyright (c) 2026 Huawei Device Co., Ltd.

export const INSTRUCTIONS = [
  'HarmonyOS/OpenHarmony development toolkit (standalone MCP server, no DSH host required).',
  '',
  'New project: project_create (devecocli create) -> switch_cwd -> edit .ets -> build_project.',
  '',
  'Standard loop: switch_cwd -> hms_setup(doctor) -> hdc_list_targets -> edit .ets -> arkts_check -> build_project -> hms_build(run) / start_app -> verify with hdc_ui_dump / hdc_screenshot / hdc_hilog / hdc_crash.',
  '',
  'Device layer (needs a local hdc binary; the tools use the device last used in this server unless a target is given):',
  '  hdc_list_targets, hdc_connect, hdc_shell, hdc_screenshot (returns the JPEG inline), hdc_install, hdc_hilog,',
  '  hdc_ui_dump, hdc_ui_find, hdc_ui, hdc_app, hdc_crash, hdc_fport, hdc_file, hdc_target, hdc_diag, hdc_log.',
  '',
  'Official toolchain + knowledge layer:',
  '  project_create (create a new project via devecocli create), hms_setup (doctor), hms_build (status/build/run/sign/clean), hms_lint, hms_api, hms_knowledge, hms_docs, hms_api_change, hms_emulator.',
  '',
  'Compile assistance: switch_cwd, build_project, arkts_check, start_app.',
  '',
  'Call hdc_guide with action=device|toolchain|knowledge|compile for the full operating guides.',
].join('\n')

export const GUIDES = {
  device: [
    '# HarmonyOS device debug loop',
    '',
    'This guide covers the device tools only; for ArkTS/API knowledge use the `knowledge` guide.',
    '',
    '## The loop',
    '1. hdc_list_targets — confirm the device (the first Connected target is used by default; pass `target` to override)',
    '2. hdc_ui_dump — read the current screen as text (a text-mode screenshot)',
    '3. hdc_ui_find — locate a control by text/hint (returns bounds and center coordinates)',
    '4. hdc_ui tap / input / swipe / key — act (always with the coordinates from the latest dump)',
    '5. hdc_ui_dump — verify the state change',
    '',
    '- Vision models: hdc_screenshot returns the JPEG inline as an image block (the local copy is at `path`)',
    '- Diagnosis: hdc_crash (structured crash summary) / hdc_hilog (logs) / hdc_diag (server + hdc state)',
    '- Lifecycle: hdc_install (install a .hap) / hdc_app (query/start/stop/clear-data/uninstall)',
    '- Environment check: hms_setup (hdc / Studio / SDK / devecocli / devices)',
    '',
    '## Field-tested behaviour',
    '- Mixed-string input (digits -> letters -> digits): the IME mode switch reliably swallows the character right after a letter. Work around it by typing in segments, verifying with a dump, and re-sending the missing character.',
    '- The soft keyboard changes the layout: use the coordinates from the latest dump before every tap; when the keyboard covers a button, send `hdc_ui action=key key=Back` first.',
    '- snapshot_display only accepts .jpeg (API 10+).',
    '- Install error 9568332 means the signing profile is not bound to the device UDID: add the device in AGC, re-sign, reinstall.',
    '- The hdc client can return exit code 0 for a remote failure: trust the `ok`/`error` fields of the tool result, not the exit code.',
  ].join('\n'),

  toolchain: [
    '# DevEco CLI (devecocli) guide',
    '',
    '> Adapted from the official SKILL.md (translated summary, not a verbatim copy).',
    '> Copyright (c) 2026 Huawei Device Co., Ltd. — MIT License.',
    '> Original: https://gitcode.com/openharmony-sig/deveco-cli/blob/develop/SKILL.md',
    '',
    '## Entry points (prefer these tools; the arguments are already validated)',
    '- project_create: create a new HarmonyOS project (devecocli create); appName / projectPath / bundleName / apiLevel / deviceTypes; target directory must be empty; verifies the generated scaffold',
    '- hms_build: status / build / run / sign / clean (falls back to the local hvigorw when the CLI is missing)',
    '- hms_lint: rules (57+ official rule docs read from the local install) / read-rule / check (devecocli check lint)',
    '- hms_docs: search / read / catalog (devecocli docs, the official local documentation set)',
    '- hms_api_change: versions / diff (devecocli check compat, the official cross-version breaking-change scan)',
    '',
    '## Installation and toolchain shapes (pick one)',
    '- A | DevEco Studio: `npm i -g @deveco/deveco-cli` (macOS/Windows, Node >= 18) plus DevEco Studio >= 6.0.',
    '- B | Standalone Command Line Tools (CLT): the official Huawei zip distribution (codelinter/hvigorw/ohpm/emulator/embedded SDK), >= 26.0.0, the only shape on Linux. Extract it, put <clt>/bin on PATH and set DEVECO_CLI_CLT_PATH=<extracted dir> (deveco-cli does not discover the CLT on its own). Download: developer.huawei.com/consumer/cn/download/command-line-tools-for-hmos.',
    '- The server detects both shapes and injects the matching root into the environment; hms_setup reports the current toolchainKind.',
    '',
    '## Command cheat sheet',
    '- `build`: compile and package. `--modules <m1> <m2>@<target>` selects modules; `--product <name>` builds the whole product; `build clean` cleans.',
    '- `run`: build + install + launch. `--module`, `--device <name|serial>` (required with several devices), `--uninstall` (uninstall first, fixes signing-key changes), `--skip-build`, `--apply <file>` for fast incremental deployment (Studio >= 6.1.1).',
    '- `check lint [path]`: official ArkTS lint. `--fix`, `--format json` (needs Studio >= 6.1.0), `--limit <n>`.',
    '- `check compat`: scan breaking API changes between two SDK versions. `versions` lists them; `--source-version X --target-version Y --format json --output-path <dir>`; target must be newer than source.',
    '- `signature generate`: generate signing material and write it into build-profile.json5. Requires `auth login` + the project directory + a connected device.',
    '- `auth login/status/logout`: Huawei developer account OAuth (a manual browser step).',
    '- `docs search <kw>` / `docs read <id>` / `docs catalog`: the official local documentation set.',
    '- `emulator list/start/stop`, `ui layout/screenshot/click/text`, `log --crash --bundle-name X`, `create --app-name X --api-level N`, `skills list/add`.',
    '',
    '## Hard constraints',
    '- Node >= 18; build/sign/lint need a local toolchain: DevEco Studio >= 6.0 (lint by default, `--format json` needs >= 6.1.0, `--apply` needs >= 6.1.1) or the standalone Command Line Tools >= 26.0.0 (the CLT has no embedded JDK, so CI needs its own JAVA_HOME).',
    '- `auth login` is a browser OAuth that an agent cannot complete on the user behalf: when the CLI reports "Not logged in", give the user the command instead of retrying.',
    '',
    '## Error cheat sheet',
    '- `Not logged in` -> devecocli auth login',
    '- `error:install sign info inconsistent` -> devecocli run --uninstall or signature generate --force',
    '- `Provision number exceeds limit` -> delete an old test profile in the AGC console',
    '- `Product / Build mode not found` -> check build-profile.json5',
    '- `Multiple entry modules` -> add --modules to build, --module to run',
  ].join('\n'),

  knowledge: [
    '# HarmonyOS knowledge discipline (official-first, versioned, licence-clean)',
    '',
    '## Source tiers (strictly in order, top tier wins)',
    '**Tier 0 official first-hand (read from the local install, follows the user toolchain version, never redistributed)**',
    '- hms_api: the local SDK .d.ts, every entry carries @since/@deprecated/@syscap — the first choice for "when was this API added, when was it deprecated"',
    '- hms_docs: the official local documentation set (devecocli docs)',
    '- hms_api_change: the official cross-version breaking-change scan (check compat)',
    '- hms_lint rules: the official lint rules bundled with the local DevEco install (Apache-2.0, read locally)',
    '**Tier 1 bundled with the server (offline, no Studio/SDK/network needed)**',
    '- hms_knowledge: verbatim OpenHarmony documentation excerpts (CC-BY-4.0, attributed) — 28 high-traffic official documents: API modules (promptAction/router/notification/vibrator/http/ws/preferences/util/uiAbility/permissions/context/hilog/abilityManager...), the window/Window classes, the Navigation component, the application model and the ArkTS state-management guide. catalog lists the topics, read shows the TOC and then a section, search matches titles/sections',
    '**Tier 2 user-installed (point at it, never bundle it)**: community skill packs such as harmony-next.skills (no LICENSE, not redistributable); the official web docs at developer.huawei.com',
    '',
    '## Query cheat sheet',
    '- Concepts/usage/examples (human-readable): hms_knowledge first (offline, instant); the full official set goes through hms_docs (needs devecocli)',
    '- Signing/version/deprecation decisions (machine-readable, exact): the @since/@deprecated/@syscap tags from hms_api',
    '- The "起始版本 / API version" markers inside the documentation body are equally reliable — quote them when answering',
    '',
    '## Version discipline (HarmonyOS knowledge changes between versions, not only by addition)',
    '1. Establish the target API version before answering: hms_setup collects all three sources — the project build-profile.json5 compatibleSdkVersion, the device `param get const.ohos.apiversion`, and the local SDK apiVersion',
    '2. When the three disagree, tell the user explicitly (e.g. SDK=23 while the phone runs 24) and suggest hms_api_change diff',
    '3. @since N means the API exists from N onwards; @deprecated since M means it should be avoided from M onwards — find the replacement',
    '4. Answering a new-version question with old-version knowledge is a high-severity error: query hms_api first',
    '5. When citing knowledge, state the source tier and the version (e.g. "hms_api@SDK23: since 15, available on target 23")',
    '',
    '## Licence discipline',
    '- Reading from the local install (SDK .d.ts / codelinter rules) is legitimate, but the content must never be copied into generated artefacts and redistributed',
    '- Resources without a LICENSE may only be referenced by link, never copied',
    '- Keep the copyright and the source when quoting official content',
  ].join('\n'),

  compile: [
    '# HarmonyOS compile loop',
    '',
    '1. `switch_cwd`: point the server at the application root (the directory holding build-profile.json5).',
    '2. `arkts_check`: run the fast SDK ets-loader check after editing `.ets` files.',
    '3. `build_project`: package the application. It verifies that a fresh `.hap` was produced and falls back to direct `hvigorw` when the devecocli channel does not complete.',
    '4. `start_app`: deploy the latest package and start its entry ability. It uses devecocli first, then falls back to `hdc` installation and launch.',
    '5. `hdc_log`: collect, clear or list device logs. Use the bundle or PID filters for runtime diagnosis.',
    '',
    '## Boundaries',
    '- Do not construct ad-hoc `hvigorw` commands. The tools preserve the project root, quote arguments and verify the artefacts.',
    '- `start_app` does not build. Run `build_project` first. For signing and account login use `hms_build` and the `toolchain` guide.',
    '- `arkts_check` requires the DevEco Studio SDK ets-loader. A full `build_project` remains the fallback when it is unavailable.',
    '- For device UI inspection, screenshots, the installation lifecycle and crash files use the `device` guide.',
    '',
    '## Common results',
    '- `HarmonyOS project not found`: run `switch_cwd` with the directory containing `build-profile.json5`.',
    '- No updated `.hap`: inspect the build output; a reported success without an artefact is treated as a failure.',
    '- No device: call `hdc_log` with `action=list_devices` or `hdc_list_targets`, then start or connect the intended target.',
  ].join('\n'),

  next: [
    '# Harmony Next (optional community skills)',
    '',
    'The Harmony Next community skill is optional and is not bundled with this server.',
    'Use the locally installed skill documentation as the source of truth for its commands and workflow.',
    'For the server-provided path, use `compile` for build and deployment, `device` for device actions and `knowledge` for versioned API references.',
  ].join('\n'),
}

export function buildGuideTool() {
  return {
    name: 'hdc_guide',
    description: 'Operating guides for this server: device debug loop (device), official DevEco CLI toolchain (toolchain), versioned HarmonyOS knowledge discipline (knowledge), compile loop (compile). Returns the full guide text for the requested topic.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'One of: device, toolchain, knowledge, compile, next, all' },
      },
      required: ['action'],
    },
    async execute(args) {
      const action = String((args && args.action) || '').trim().toLowerCase()
      if (!action) return { ok: false, error: 'action is required (device, toolchain, knowledge, compile, next, all)' }
      if (action === 'all') {
        const guides = {}
        for (const [key, value] of Object.entries(GUIDES)) guides[key] = value
        return { ok: true, action, guides }
      }
      const text = GUIDES[action]
      if (!text) return { ok: false, error: 'unknown action: ' + action + ' (expected device, toolchain, knowledge, compile, next, all)' }
      return { ok: true, action, guide: text }
    },
  }
}
