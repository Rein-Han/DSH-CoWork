# Kimi Code 与 Kimi Work 接入 DSH

两个客户端共用 DSH MCP 和等待协议，但接入入口不同。源码提供配置安装/导出、专用 skill 和 SDK 验收脚本；原生客户端是否成功加载必须另行验证。

| 客户端 | 接入方式 | 当前限制 |
|---|---|---|
| Kimi Code | 用户级或项目级 `mcp.json`，安装专用 skill | 使用当前 `KIMI_CODE_HOME` / `.kimi-code` 规则；新开会话加载 |
| Kimi Work | 导出 MCP 设置 + 独立 skill，使用客户端支持的设置入口 | 本机 3.2.15 禁止本地插件携带 MCP；MCP 页可用性取决于版本/账号能力 |

先在本仓库 `npm ci`、`npm run build`，按 [README](../README.md) 配好 Connector，保持 DSH Desktop 运行。已连通的 Connector 不需重装。改动尚未进入已有 exe 包。

## Kimi Code

官方文档定义用户配置 `$KIMI_CODE_HOME/mcp.json`（默认 `~/.kimi-code/mcp.json`）和项目配置 `.kimi-code/mcp.json`，项目同名配置优先；skill 放在相应的 `skills/` 下。依据：[MCP 文档](https://moonshotai.github.io/kimi-code/en/customization/mcp.html)、[Skills 文档](https://moonshotai.github.io/kimi-code/en/customization/skills)。

```powershell
npm run setup-desktop -- --caller kimi-code --scope user --dry-run
npm run setup-desktop -- --caller kimi-code --scope user --apply
```

项目级：

```powershell
npm run setup-desktop -- --caller kimi-code --scope project --project 'C:\work\my-project' --dry-run
npm run setup-desktop -- --caller kimi-code --scope project --project 'C:\work\my-project' --apply
```

安装 `mcpServers.dsh_desktop` 和 `skills/kimi-code-dsh-desktop/`。首次默认 `toolTimeoutMs=120000`，stdio 由 command/args 定义。同名条目的自定义超时、启用状态、工具限制、额外 env 和其他服务均保留；command/args 与 DSH 管理的环境字段更新。已有不同条目需核对后加 `--replace`。配置被拒绝时不继续安装 skill。

新开 Kimi Code 会话，确认工具可见，并加载 `kimi-code-dsh-desktop` skill（支持时可用 `/skill:kimi-code-dsh-desktop`）。保留的工具限制若隐藏了派发/等待/释放工具，应按自己的权限意图调整，安装器不会自动放开限制。

卸载仅移除该服务和对应 skill，保留备份、历史和共享 Connector：

```powershell
npm run setup-desktop -- --caller kimi-code --scope user --uninstall --apply
```

项目级卸载使用安装时的 scope/project。

## Kimi Work

不能假设 Work 读取 `.kimi-work/mcp.json`。本机 Work 3.2.15 的安装代码拒绝本地插件中的非空 MCP 定义，并关闭本地插件安装；同时保留了带 stdio、command、args、env、cwd 和超时字段的用户 MCP 设置页。该页受账号能力约束；本机代码证据不代表所有账号已开放入口。

导出到指定目录：

```powershell
npm run setup-desktop -- --caller kimi-work --output .\artifacts\kimi-work-dsh-desktop --dry-run
npm run setup-desktop -- --caller kimi-work --output .\artifacts\kimi-work-dsh-desktop --apply
```

产物：

- `mcp-settings.json`：MCP 表单参数，包括 stdio、绝对路径、环境变量和超时；供查看并填入客户端，**不假定客户端支持导入此 JSON**。
- `skills/kimi-work-dsh-desktop/`：独立 skill 及协作协议参考。
- `kimi.plugin.json`：仅含 skill 的源码清单，没有 `mcpServers`；供支持的 Plugin Builder 流程使用，不是绕过限制的本地 MCP 插件。

在 Work 的 **Plugins → MCP**（名称以实际界面为准）中新增 `dsh_desktop`：transport 选 stdio，将 JSON 中 command、args、env 和超时逐项填入；args 中各元素独立输入。若需要 cwd，填本仓库绝对路径。再通过 Work 支持的 skill 上传入口或 Plugin Builder 创建个人插件并安装 skill。依据：[创建插件与技能](https://www.kimi.com/help/plugins-and-skills/create)、[插件中心](https://www.kimi.com/help/kimi-work/plugin-center)。

如果账号没有 MCP 设置页，导出不能让 Work 自动接入；需要客户端开放入口，或暂用 Kimi Code。不要修改私有数据库或绕过插件限制。如果 Work 的运行环境无法启动本机 node.exe，同样不能使用本地 stdio。

安装器不写 Work 内部配置，不支持 Work 项目级安装或自动卸载。移除服务和 skill 在 Work 内操作；删除导出目录不移除已添加服务。路径变化后重新导出并更新表单。

## 等待与验收

两套 skill 保存 taskId、回执的 targetStartAfterCursor 和 nextCursor，明确选择 `terminal/compact`，单次最多 30 秒。普通事件不逐条返回给调用模型。安装器和运行时均拒绝 `long`，直到完成各客户端长调用、中断、并发和结果回收验证。

新任务必须同时传 `projectRoot`（调用方当前项目根）和 `cwd`（请求任务目录），且 `projectRoot` 是 `cwd` 自身或祖先。显式 `projectRoot` 只精确复用该根的已有 workspace，没有则只在该根创建；省略时才复用 `cwd` 本身或最近祖先的已有 workspace，都没有才以 `cwd` 创建。已有会话不迁移，其他 legacy 行为不变。调用方名字只用于归因，不影响项目选择；独立 worktree 未明确扩大范围时不得归入另一个项目。

Host 0.2.1-rc.2 不允许创建会话时同时传 `workspaceId` 和 `cwd`，选择 workspace 后实际 session cwd 强制为 `workspace.path`。因此子目录任务的真实会话 cwd 和 bridge claim 都提升到项目根，输入 `cwd` 仍放在 prompt 中作为任务范围，不是沙箱。核对 `delegated.desktopWorkspace`：`path/sessionCwd` 是 canonical 项目根，`requestedCwd` 是 canonical 请求目录，`resolution` 为 `exact|ancestor|created`，并确认 `workspaceClaim.cwd==sessionCwd==path`。证据缺失或不符时保留任务和回执并报告，不重派。

审批/提问由用户在 DSH Desktop 处理；观察超时不取消 DSH、不重派任务。取完整结果、核对归属并验收后正常释放目录。日常多客户端应共用 bridge home，以共享目录占用；隔离 home 仅用于独立验收目录。

SDK 检查（非原生客户端 UI 验收）：

```powershell
node scripts/verify-caller.mjs --caller kimi-code --project 'C:\work\my-project' --cwd 'C:\work\my-project\packages\demo'
node scripts/verify-caller.mjs --caller kimi-work --project 'C:\work\my-project' --cwd 'C:\work\my-project\packages\demo' --config .\artifacts\kimi-work-dsh-desktop\mcp-settings.json
```

`--project` 始终表示项目根；可选 `--cwd` 表示请求任务目录，默认等于 `--project`。Code 项目级配置需加 `--config 'C:\work\my-project\.kimi-code\mcp.json'`。脚本派发一个只读标记任务，消耗少量 DSH 模型额度，校验上述项目证据，并把 `project`、`requestedCwd` 和 `desktopWorkspace` 保存到 `<project>/artifacts/dsh-verification/<taskId>.json`。180 秒预算用尽或待交互后，处理完可用相同参数加 `--receipt '<receipt-path>'` 继续，不重复派发；没有新增字段的旧回执仍可恢复。自定义 bridge home 必须保持一致。

各原生客户端最终分别验收：工具可见、skill 加载、派发与项目归属及 workspace/claim 证据、等待不刷屏、完整结果、正常释放、同目录再次派写任务、用户中断/审批。SDK PASS 只证明桥接和 Host 路径及返回证据，不证明原生界面或账号已开放功能。
