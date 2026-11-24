# dsh-hdc-mcp

> 独立的鸿蒙开发 MCP 服务：`hdc` 设备闭环调试（看设备 → 截图 → 看图 → 改码 → 装包 → 验证）＋ 官方优先版本化知识层（官方 KMS MCP + 离线随包 + Gitee 云端按需 + SDK 机读）＋ 可选官方 DevEco CLI 构建/签名通道。
> A standalone MCP server for HarmonyOS/OpenHarmony development — no MCP host plugin required.

本包是 [`dsh-hdc-panel`](../README.md) DSH 插件的**独立化产物**：把插件的工具层完整剥离出来，做成一个标准 MCP 服务，可以直接挂到 Claude Code、CodeBuddy、Cursor、Cline 等任意 MCP 客户端上，**不需要 DSH 宿主、不需要浏览器面板、不需要沙箱策略**。

## 定位

`hdc_mcp` 等 MCP 服务器已覆盖 hdc 能力层。本服务的价值在鸿蒙工程闭环本身：

- 设备闭环工具齐备：观察（`hdc_ui_dump`）→ 定位（`hdc_ui_find`）→ 操作（`hdc_ui`）→ 验证（`hdc_ui_dump` / `hdc_screenshot`）
- **截图直出**：MCP 的 `content` 支持 image block，`hdc_screenshot` 直接把 JPEG 以 base64 内联返回，模型立即可看屏（DSH 插件版依赖宿主 `read_image`，独立服务不存在该工具）
- 官方优先版本化知识层：本机 SDK `.d.ts`（`@since`/`@deprecated`/`@syscap` 精确到 API 版本）＋ 华为官方开发者知识库 MCP（匿名免登录）＋ 随包 28 篇官方文档节选 ＋ Gitee 云端按需拉取
- 会话级编译闭环：`switch_cwd` / `arkts_check` / `build_project` / `start_app` / `hdc_log`
- 结构化失败上报：所有工具**失败不抛异常**，统一返回 `{ ok: false, error, hint }`；MCP 层映射为 `isError: true` + 完整 JSON 文本
- 零 npm 依赖，安装期不执行任何第三方脚本

## 安装

```sh
# npm 安装
npm i -g dsh-hdc-mcp

# 或直接从 GitHub 安装（纯 JS、无构建步骤）
npm i -g github:WLX2007/DSH-Hdc-Tool#mcp
```

## 客户端配置

### Claude Code

```sh
claude mcp add dsh-hdc --scope user -- node "$(npm root -g)/dsh-hdc-mcp/bin/dsh-hdc-mcp.mjs"
```

### CodeBuddy / Cursor / 通用 MCP 客户端

```json
{
  "mcpServers": {
    "dsh-hdc": {
      "command": "node",
      "args": ["/abs/path/to/DSH-Hdc-Tool/mcp/bin/dsh-hdc-mcp.mjs"],
      "cwd": "/abs/path/to/your/harmonyos/project"
    }
  }
}
```

`cwd` 决定服务的默认工程根目录；`switch_cwd` 可以在会话中改掉它。

## 工具总览（30 个）

> 约定：所有工具失败不抛异常，统一返回业务值 `{ ok: false, error, hint }`；成功返回带 `ok: true` 的结果对象。MCP 映射：`ok:false` → `isError:true`，`content` 同时给出完整 JSON 文本。

### 设备层（16 个，复用本机 hdc）

| 工具 | 说明 |
| --- | --- |
| `hdc_list_targets` | 列出已连接设备/模拟器（空列表 + 连接指引） |
| `hdc_connect` | `hdc tconn`（严格 host:port 校验） |
| `hdc_shell` | 设备 shell（param get / ps / uitest dumpLayout…，含单引号命令的 base64 保真通道） |
| `hdc_screenshot` | 截图 → 拉取 JPEG → 落盘校验 → **以内联 image block 返回** |
| `hdc_install` | 安装 .hap（默认 -r；输出标记级失败检测） |
| `hdc_hilog` | hilog 尾部 N 行（tag `-T`、domain `-D`、level `-L`、pid `-P`、regex `-e`） |
| `hdc_fport` | TCP 端口转发管理：add / remove / list |
| `hdc_file` | 主机与设备间文件传输：send / recv |
| `hdc_target` | 目标管理：disconnect / reboot / mode（usb/tcp） |
| `hdc_ui_dump` | 文本化 UI 快照：uitest 布局树 → 可见文本节点 |
| `hdc_ui_find` | 按文本/hint 找控件：返回 bounds 与中心坐标 |
| `hdc_ui` | UI 操作：tap / doubleTap / longPress / swipe / input / key |
| `hdc_app` | 应用管理：query / start / stop / clear-data / uninstall（破坏性动作已标注） |
| `hdc_crash` | 崩溃抓取：faultlogger 目录里最近的 jscrash / cppcrash / appfreeze，含结构化摘要 |
| `hdc_diag` | 诊断：宿主 shell、hdc 路径、候选清单、探测日志 |
| `hdc_log` | 收集 / 清除 / 列出设备日志；支持关键词、bundle 和 PID 过滤 |

### 官方工具链层（9 个）

| 工具 | 说明 |
| --- | --- |
| `project_create` | 创建鸿蒙工程：封装 `devecocli create`，参数 appName / projectPath / bundleName / apiLevel / deviceTypes；校验目标目录与产物，失败返回 `{ok:false,error,hint}` |
| `hms_setup` | 环境体检：hdc / DevEco Studio / SDK(API) / devecocli / 设备五项 ＋ 目标 API 版本三源解析与不一致告警 |
| `hms_build` | 官方构建/签名/运行通道：status / build / run / sign / clean；devecocli 缺失或失败时自动回退本机 hvigorw |
| `hms_api` | 本机 SDK `.d.ts` 的版本化 API 知识（`@since`/`@deprecated`/`@syscap` 精确到 API 版本） |
| `hms_knowledge` | 分层官方知识：official-search / official-read / catalog / read / search / ls / sync / cache / rm |
| `hms_docs` | 官方本地文档检索：`devecocli docs` search / read / catalog |
| `hms_api_change` | 官方跨版本破坏性变更扫描：`devecocli check compat`（versions / diff） |
| `hms_lint` | 官方 lint：rules（本机 codelinter 规则索引）/ read-rule / check（JSON 报告落工作区暂存、读后即删） |
| `hms_emulator` | 官方模拟器控制：list / start / stop / create / delete ＋ 状态注入（shake / power / rotate / volume / fold / battery / geolocation / sensor / scene） |

### 会话编译层（4 个）

`switch_cwd`（切换工程根目录）、`build_project`（构建并验证 `.hap` 产物）、`arkts_check`（SDK ets-loader ArkTS 静态检查）、`start_app`（不重新构建地部署启动）。另有 `hdc_log` 承担日志采集。

### 指南

`hdc_guide`（action = device / toolchain / knowledge / compile / next / all）返回完整操作指南；`initialize` 响应里另带一段精简工作流说明。

## 返回值契约（MCP 映射）

| 内部结果 | MCP 结果 |
| --- | --- |
| `{ ok: true, ... }` | `{ content: [{type:'text', text:'<JSON>'}], structuredContent: {...} }` |
| `{ ok: false, error, hint }` | 同上，但 `isError: true` |
| `{ image: { data, mimeType } }`（`hdc_screenshot`） | `{ content: [{type:'image',...}, {type:'text',...}] }` |

`structuredContent` 仅在 2025-06-18 之后的客户端上可见，旧客户端忽略即可。

## 与 DSH 插件版的差异

本服务不是插件的复制品，独立化过程中做了这些改动：

| 方面 | DSH 插件 | 本 MCP 服务 |
| --- | --- | --- |
| 宿主依赖 | `ctx.shell` / `ctx.tools` / `ctx.get('fs')` / 沙箱策略 | 无；`child_process.spawn` 直连 |
| 命令执行 | 拼 shell 字符串，宿主方言（pwsh/bash）引号转义 | **hdc 用 argv 直调**（彻底消除跨方言引号隐患）；hvigor/devecocli 仍走宿主 shell |
| 沙箱 | DSH 沙箱策略对象（workspaceRoot / mode / sessionId） | **整体移除**，直连执行 |
| 会话 cwd | DSH session id 键控的 Map | 进程级单值（stdio 单客户端） |
| 设备记忆 | 进程级 `preferredTarget` | 同左，保持不变 |
| 截图 | 落盘 + 提示调用宿主 `read_image` | **直接内联 image block** |
| 技能 | 5 个运行时 skill（宿主注入） | `initialize.instructions` 精简说明 ＋ `hdc_guide` 工具按需拉取 |
| 设备面板 | `/api2/hdc-panel/*` REST ＋ React 面板 | 不需要 UI，整体丢弃 |
| 错误提示 | 含「沙箱阻断 / [Outside sandbox]」措辞 | 改为沙箱无关措辞（host IPC / 普通用户会话） |

> `hdc` 参数层改为 argv 直调是这次独立化顺带修掉的一个真 bug：旧实现用 PowerShell 的 `''` 转义去包裹 POSIX 语境下的 hdc 参数，在 bash 宿主上会静默丢字符。

## 环境要求

- **Node ≥ 18.17**（使用全局 `fetch`）
- HarmonyOS 设备/模拟器；真机需开发者模式 + USB 调试
- hdc 二进制自动探测：显式 `devecoPath` / `DEVECO_STUDIO_HOME` / `DEVECO_HOME` / `DEVECO_SDK_HOME` → Windows 注册表（含 WOW6432Node）→ 非默认 DevEco/CLT SDK 根 → 默认安装根 → PATH 回退
- 截图查看需图像输入模型；纯文本模型可用 `hdc_ui_dump` 做文本化 UI 检查
- 可选后端 `@deveco/deveco-cli`（MIT）**不随包安装**（零依赖，安装期不执行任何第三方脚本），工具链二选一：
  - **路线 A｜DevEco Studio**：本机装 DevEco Studio ≥ 6.1.0（macOS/Windows）+ `npm i -g @deveco/deveco-cli`
  - **路线 B｜独立 Command Line Tools**：华为官方 zip 发行版（≥ 26.0.0，解压即用），设置 `DEVECO_CLI_CLT_PATH`（或 `COMMAND_LINE_TOOL_PATH`）；**Linux 主机仅支持此形态**
  - 未安装时相关工具优雅降级并给出安装指引；`hms_setup` 一眼可查当前 `toolchainKind`
- 本机无任何工具链时仍可用：hdc_* 全部工具、随包离线知识层
- 签名前需一次人工 `devecocli auth login`（浏览器 OAuth）

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `DEVECO_SDK_HOME` | 显式 SDK 根 |
| `DEVECO_CLI_CLT_PATH` / `COMMAND_LINE_TOOL_PATH` | 独立 Command Line Tools 根 |
| `DEVECO_ARKTS_CHECK_SCRIPT` | 覆盖随包 arkts-check 脚本 |
| `DSH_HDC_MCP_KNOWLEDGE_DIR` | 覆盖随包知识目录 |

## 目录结构

```
mcp/
  bin/dsh-hdc-mcp.mjs      # 入口（stdio MCP 服务）
  src/
    server.mjs             # 启动、参数、instructions
    mcp/                   # 协议层：JSON-RPC 分发、stdio 帧编解码、schema/结果映射
    core/                  # 与宿主无关的核心：shell、hdc、工具链探测、知识层、项目辅助
    tools/                 # 工具组：device / toolchain / compile
  knowledge/               # 随包官方文档节选（28 篇 + index.json，CC-BY-4.0 已署名）
  assets/arkts-check.cjs   # ArkTS 静态检查脚本
  scripts/                 # 自检脚本
```

## 开发与自检

```sh
# 协议层 + 真机链路冒烟（需要连着设备）
node scripts/smoke.mjs

# 真机验收：hdc_shell / ui_dump / ui_find / screenshot / hilog / diag
node scripts/device-check.mjs

# 官方工具链层验收：doctor / api / knowledge / lint / app
node scripts/toolchain-check.mjs

# 编译链路验收（--build 在工程副本上构建，不动原工程）
node scripts/compile-check.mjs <projectRoot> [--build]
```

## 许可与来源

- 本包零 npm 依赖；随包内容与改写内容的分类、署名与许可见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)
- `knowledge/` 为 OpenHarmony 官方文档逐字节选（CC-BY-4.0，逐文件溯源见 `knowledge/index.json`）
- `hdc_guide action=toolchain` 的内容改写自华为官方 `deveco-cli` SKILL.md（MIT，版权声明保留）

## License

MIT
