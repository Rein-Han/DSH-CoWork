# DSH-CoWork

让 Codex / Claude Code / ZCode / Kimi Code，以及具备用户 MCP 设置入口的 Kimi Work，把任务交给你电脑上已经打开的 **DeepSeek Harness Desktop**（下文简称 DSH），然后查看进度、拿回结果、自己验收。

当前源码整合了 P1–P3 修复、ZCode 接入与新会话项目归属，并新增 Kimi 接入和自适应观察。见 [ZCode 指南](docs/zcode.md)、[Kimi Code / Kimi Work 指南](docs/kimi.md) 和 [自适应等待说明](docs/adaptive-wait.md)。现有 exe 安装包仍是旧构建；`v0.2.0` 是源码标签，不是已经更新的安装包。

在调用方里说一句“把这个交给 DSH”，它会在 DSH Desktop 里新建一个会话执行任务。你可以在 DSH Desktop 里看到同一个会话和它的每一步操作，做完后由调用方检查改动和测试。

> 当前是测试版，只支持 Windows；已在 DeepSeek Harness Desktop 0.2.1-rc.2（Host 协议 4）上实机连通。后续版本需按协议能力重新核验。自适应观察尚未完成全部原生客户端验收。

## 组成

| 部分 | 作用 |
|---|---|
| DSH 插件 `dsh-desktop-cowork-connector` | 装进 DSH Desktop。DSH 每次启动时，它把本机端口和登录凭据写到一个只有你本人能读的文件里，不开端口、不代理请求 |
| MCP 服务 `dsh_desktop` | 由配置好的调用方启动，读取上面的文件后连接 DSH，提供 `dsh_delegate`、`dsh_wait`、`dsh_followup` 等工具 |
| 各调用方的 `*-dsh-desktop` skill | 告诉调用方怎么交接任务、等待、验收和释放目录；五端共用同一桥接协议 |

## 安装

P3 长等待实现与验收：见 [long-wait.md](docs/long-wait.md)。支持显式 900 秒
terminal 等待、取消观察隔离、限频进度、增量账本与共享检查。两端正式配置
默认仍是 bounded；150 秒/10 分钟协议测试通过不等于原生客户端界面验收通过。
临时 `dsh_wait_acceptance` 只运行定时器，用于无模型开销的客户端验收。

需要：Windows 10/11 x64，已为当前用户安装 DeepSeek Harness Desktop，以及 ZCode、Codex 或 Claude Code。ZCode 请按 [专项指南](docs/zcode.md) 从源码安装。

### 方式一：已有的旧版安装包

当前 exe 不是 `v0.2.0` 源码构建。需要本标签的新功能时，使用下方的源码安装步骤；不要将旧 exe 的验收结果视为这个标签的验收。

1. 从本仓库的 Releases 页面下载 `DSH-Desktop-Cowork-Setup-<版本>.exe`。安装包没有数字签名，Windows 可能弹出 SmartScreen 提示，选"更多信息 → 仍要运行"。
2. 在托盘图标上右键退出 DeepSeek Harness Desktop（只关窗口不够）。
3. 运行安装包（英文界面），按提示操作：
   - 安装器会把插件装进 DSH，然后提示你重新打开 DSH Desktop；
   - 等 DSH 发布连接文件后，安装器自动把 `dsh_desktop` 注册到 Codex 和 Claude Code。
4. 重启 Codex / Claude Code，开一个新会话。

安装位置是 `%LOCALAPPDATA%\Programs\DSH Desktop Cowork`，不需要管理员权限。安装包自带 Node.js，不依赖系统里的 Node。

### 方式二：从源码安装

需要 Node.js 22 或更高版本。在 PowerShell 里进入仓库目录：

```powershell
npm ci
npm run build
```

1. 退出 DSH Desktop，安装插件：

   ```powershell
   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add (Resolve-Path .\release\dsh-desktop-cowork-connector-1.0.1.tgz)
   ```

2. 重新打开 DSH Desktop，等大约 10 秒，然后检查：

   ```powershell
   npm run doctor:desktop
   ```

   `connector-registered` 和 `published-connection` 都显示 `[ok]` 后再继续。

3. 先预览，再写入 Codex 和 Claude 的配置（只用其中一个时，把 `both` 换成 `codex` 或 `claude`）：

   ```powershell
   npm run setup-desktop -- --caller both --scope user --dry-run
   npm run setup-desktop -- --caller both --scope user --apply
   ```

   写入前会在原文件旁生成 `.bak-dsh-desktop-cowork-*` 备份。注册时记录的是当前目录的绝对路径，之后不要移动这个目录。

4. 可选：做一次真实往返测试。这一步会在 DSH 里建一个会话并发送一条只读消息，会消耗少量模型额度：

   ```powershell
   npm run verify-desktop -- --project "$env:USERPROFILE\Documents\cowork-acceptance"
   ```

### ZCode 接入

完整步骤见 [ZCode 安装与使用指南](docs/zcode.md)。完成源码构建和 DSH 插件安装后，保持 DSH Desktop 运行，再注册 ZCode：

```powershell
npm run setup-desktop -- --caller zcode --scope user --dry-run
npm run setup-desktop -- --caller zcode --scope user --apply
```

安装器会在 `~/.zcode/cli/config.json` 的 `mcp.servers` 中注册 `dsh_desktop`，并把 `zcode-dsh-desktop` 技能安装到 `~/.zcode/skills/`。配置写入前会生成备份。重新打开 ZCode 会话后，可以说“把这个任务交给 DSH”，或使用 `/zcode-dsh-desktop`。

在当前仓库目录执行以下命令，可以用 ZCode 已注册的 MCP 配置发送一次只读测试消息。测试会在 DSH Desktop 中保留一个会话，并消耗少量模型额度：

```powershell
node scripts/verify-zcode.mjs
```

卸载 ZCode 接入配置：

```powershell
npm run setup-desktop -- --caller zcode --scope user --uninstall --apply
```

### Kimi Code / Kimi Work 接入

Kimi Code 支持用户级和项目级配置。用户级安装：

```powershell
npm run setup-desktop -- --caller kimi-code --scope user --dry-run
npm run setup-desktop -- --caller kimi-code --scope user --apply
```

Kimi Work 导出 MCP 设置参数和独立 skill：

```powershell
npm run setup-desktop -- --caller kimi-work --output .\artifacts\kimi-work-dsh-desktop --apply
```

将参数填入 Work 的 **Plugins → MCP** 设置页，再通过客户端支持的入口添加 skill。本机 Work 3.2.15 禁止本地插件携带 MCP；若账号没有 MCP 设置页，暂时无法通过此路径接入。导出成功不等于客户端已安装。详细限制和验收见 [Kimi 指南](docs/kimi.md)。

ZCode、Kimi Code、Kimi Work 默认仍使用 30 秒的有界等待。源码支持为各调用方显式配置 adaptive/long，但不代表它们的原生长调用已经验收；启用前见 [自适应等待说明](docs/adaptive-wait.md)。`--caller both` 仍只表示 Codex 与 Claude。

## 使用

保持 DSH Desktop 处于打开状态，在 Codex / Claude Code / ZCode / Kimi Code / Kimi Work 里直接说：

> 把这个任务交给 DSH：修复登录页提交失败的问题，只改登录相关代码和测试。做完你检查改动和测试，再告诉我结果。

- 主 agent 是 Principal Agent / Tech Lead，负责需求、架构、跨领域集成判断和最终验收；DSH 是默认工程 Worker，承担可独立执行的实现、重构、测试和修复切片。小任务仅在委派与交接成本明显更高时才留在主 agent，不能因此回避所有工程委派。
- Flash/Pro 只作为实施与架构的分工指引：实现和测试修复适合当前继承的 Flash 执行路线，复杂决策保留给高智力主 agent 或由用户在 Desktop 选择 Pro。桥接始终保持 `modelPolicy=inherit`，不会自动切换模型。
- 可以让调用方使用对应的 skill，也可以显式调用：ZCode 里输入 `/zcode-dsh-desktop`，Claude Code 里输入 `/claude-dsh-desktop`，Codex 里输入 `$codex-dsh-desktop`，Kimi Code 里输入 `/skill:kimi-code-dsh-desktop`。
- 新对话同时传 `projectRoot`（调用方当前项目根）和 `cwd`（请求任务目录）。精确匹配的已有 DSH 项目必须复用；不存在时只在该项目根创建。省略 `projectRoot` 的旧调用会复用最近已有父项目，没有时才以 `cwd` 创建。调用方名称不影响项目选择。
- Desktop 0.2.1-rc.2 不允许 `workspaceId + cwd` 同时创建会话，选择项目后实际 session cwd 和 bridge claim 都是项目根；子目录只作为 prompt 中的任务范围，不是沙箱。返回的 `desktopWorkspace` 包含 `workspaceId/path/created/resolution/requestedCwd/sessionCwd`，可用于核对归属。
- 模型和推理强度沿用 DSH Desktop 里的设置，这里不能修改。
- DSH 需要审批或向你提问时，到 DSH Desktop 里处理，调用方不会代你批准。
- 同一实际项目根目录树同一时间只允许一个任务写入。任务验收后，桥接通过 Desktop 的实时 inbox 和 job/list 检查待处理输入及活动作业，再释放目录占用；接口缺失、状态过期或读取失败仍保留占用并报告 `workspace_state_unknown`。已验证 Desktop 0.2.1-rc.2 的完整连续写任务流程。

### 等待与监督策略

新版 Desktop 独立 `dsh_wait` 默认使用 `terminal/compact` 并报告连续工具失败的候选提醒：普通工具事件留在桥接内部，终态、待人工处理、连接/恢复异常或等待期限到达才返回。摘要用 `nextCursor` 续接；完整结果通过 `dsh_status` / `dsh_tail` 获取并验收。旧 `dsh_observe`、delegate 内嵌等待和显式 legacy 路径保留原有语义。

已安装旧版本时，在本源码目录构建并更新（会备份配置并保留自定义字段）：

```powershell
npm run build
npm run setup-desktop -- --caller both --scope user --wait-profile bounded --replace --dry-run
npm run setup-desktop -- --caller both --scope user --wait-profile bounded --replace --apply
```

然后重新加载 Codex / Claude 的 MCP 服务或重启调用方；无需重装 DSH Connector。旧会话已经加载的工具和 skill 不会自动更新。未配置新 profile 时默认仍为 30 秒有界等待；`--wait-profile adaptive` 或 `long` 只供完成各客户端长调用、中断、并发及结果回收验证后显式启用，当前未把任一客户端标记为已验证。旧安装包仍是旧版本，不能通过这个源码标签自动升级。

这些本地安装的 skill 不会出现在 Claude 桌面 app 设置里的 Skills / Plugins 页面。那两个页面管的是账号级内容。

## 卸载

**用安装包装的：** 在 Windows 设置 → 应用里卸载 DSH Desktop Cowork，按提示先退出 DSH Desktop。

**从源码装的：**

```powershell
npm run setup-desktop -- --caller both --scope user --uninstall --apply
```

然后退出 DSH Desktop，移除插件：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-desktop-cowork-connector
```

两种方式都会保留 `%LOCALAPPDATA%\DSHDesktopCowork`（连接文件和任务记录）以及配置备份。确认不再需要后，可以手动删除这个目录，然后正常重启一次 DSH Desktop，让旧的登录凭据失效。

## 已知限制

- 只支持 Windows、本机的 DSH Desktop，以及协议族 `dsh-host-0.2`。其他版本会被明确拒绝，不会尝试连接。
- 连接文件里的凭据是 DSH 的 Host 所有者级别，不是只能访问某个项目的低权限令牌。它靠 Windows 文件权限保护，只有当前用户、SYSTEM 和管理员能读。
- 安装包已经编译好，但还没有实际运行过：开发机上已经有一套从源码装的版本，没有拿它去覆盖测试。
- 如果 bridge 进程被强制结束，可能会留下一个过期的任务锁，导致 `dsh_status` 超时。处理方法见 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)。

更多文档：[兼容性](docs/compatibility.md) · [排错](docs/troubleshooting.md) · [回滚与凭据](docs/rollback.md) · [协作规则](docs/cowork-semantics.md)

## 开发

```powershell
npm ci
npm run build
npm test
```

- 插件源码在 `packages/desktop-connector/`，打包命令：`npm pack ./packages/desktop-connector --pack-destination ./release`。
- 安装包脚本在 `installer/`，需要 Inno Setup 6，执行 `installer\build.ps1`。脚本从 `release/` 取文件，产物输出到 `release/`（exe 不提交进仓库）。
- 当前 Windows 机器上的全量测试为 341/354 通过：6 项无法创建符号链接，另有夹具或沙箱限制，以及 1 项已确认的 junction 安装防护缺口（暂缓修复）。未发布源码已修复一条可复现的完成通知漏订阅路径，相关 10 项测试通过；原生 Codex 短结果交付仍可能排队，修复尚未经过更新后客户端的验收。详见 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)。

## 来源

本项目基于 [Fly2Kiana/Codex-DSH-Orchestrator](https://github.com/Fly2Kiana/Codex-DSH-Orchestrator) 改写，后者派生自 [dsh-Agentlink](https://github.com/hootandy321/dsh-Agentlink)。仓库里保留了上游用于旧版 Web Host 的代码和 skill（`skill/codex-dsh`、`skill/claude-code-dsh`、`skill/codex-dsh-orchestrator`），相关文档放在 [docs/legacy/](docs/legacy/)。许可证为 MIT，详见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
