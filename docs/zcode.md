# 在 ZCode 中使用 DSH-CoWork

ZCode 通过 `dsh_desktop` MCP 服务，把任务交给本机正在运行的 DeepSeek Harness Desktop。你可以在 DSH Desktop 中查看对话和执行过程，由 ZCode 读取结果并验收。

当前本地源码以 P1–P3 修复为基础，整合 `zcode-support` 的接入和项目归属，再补齐等待协议、配置保留及验收脚本。以下命令在此源码目录运行，不要求切换或覆盖 GitHub 分支。现有 exe 包尚未包含这些本地改动。

## 环境要求

- Windows 10/11 x64。
- Node.js 22 或更高版本，以及 Git。
- 已安装 ZCode 和 DeepSeek Harness Desktop。
- DSH Desktop 中已配置可用的模型，能够正常发送消息。

模型、推理强度和 agent preset 沿用 DSH Desktop 的设置。审批和提问也在 DSH Desktop 中处理。

## 下载和构建

在 PowerShell 中执行：

```powershell
npm ci
npm run build
```

选好长期保存源码的目录。注册 MCP 时会记录 `node.exe` 和 `dist/index.js` 的绝对路径，移动目录后需要重新注册。

## 安装 DSH 连接插件

在托盘菜单中退出 DSH Desktop，再从仓库目录执行：

```powershell
$dshCli = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
& $dshCli plugin --profile desktop add (Resolve-Path .\release\dsh-desktop-cowork-connector-1.0.1.tgz)
```

如果 DSH 安装在其他位置，把 `$dshCli` 改成实际安装目录下的 `resources\runtime\cli\bin\dsh.cmd`。插件已经安装时可以跳过本节。

重新打开 DSH Desktop，等待连接插件发布信息后检查：

```powershell
npm run doctor:desktop
```

`connector-registered` 和 `published-connection` 应显示 `[ok]`。后者会显示 `connection.json` 的位置、协议族和本机地址。

当前诊断工具只在默认安装位置查找 Desktop runtime。使用自定义安装目录时，可能出现 `desktop-runtime` 为 `[blocked]`，同时插件和连接文件均为 `[ok]` 的情况。此时继续用后面的真实往返测试确认连接；如果插件或连接文件也显示阻塞，先处理对应问题。

## 注册到 ZCode

先预览，再写入用户配置：

```powershell
npm run setup-desktop -- --caller zcode --scope user --dry-run
npm run setup-desktop -- --caller zcode --scope user --apply
```

安装器将写入：

| 内容 | 位置 |
| --- | --- |
| MCP 服务 | `%USERPROFILE%\.zcode\cli\config.json` 中的 `mcp.servers.dsh_desktop` |
| 调用技能 | `%USERPROFILE%\.zcode\skills\zcode-dsh-desktop\SKILL.md` |

写入前生成 `.bak-dsh-desktop-cowork-*` 备份。保留其他服务，也保留同名 `dsh_desktop` 的自定义字段、启用状态、工具限制、超时和额外 env；command、args 及 DSH 管理的环境字段更新。保留的禁用状态和工具限制仍会生效。配置只保存连接文件路径，不复制凭据。

如果目标已经存在不同的 `dsh_desktop` 配置，安装器会拒绝覆盖。检查预览结果，确认需要更新该条目后执行：

```powershell
npm run setup-desktop -- --caller zcode --scope user --replace --apply
```

`--caller both` 仍表示 Codex 和 Claude Code。注册 ZCode 时使用 `--caller zcode`。

安装完成后重新打开 ZCode 会话，使 MCP 和技能生效。

### 仅供某个项目使用

需要项目级配置时，用实际项目目录替换示例路径：

```powershell
npm run setup-desktop -- --caller zcode --scope project --project 'C:\work\my-project' --dry-run
npm run setup-desktop -- --caller zcode --scope project --project 'C:\work\my-project' --apply
```

MCP 写入项目下的 `.zcode/config.json`，技能写入 `.zcode/skills/zcode-dsh-desktop/`。避免两级同时配置不同的同名服务，以 ZCode 实际显示的服务为准。

## 发起任务

保持 DSH Desktop 运行，在项目的 ZCode 会话中说：

> 把这个任务交给 DSH：检查当前项目的 README 和安装步骤，只读检查，给出发现和建议。项目目录使用当前工作区。完成后由你验收。

也可以输入 `/zcode-dsh-desktop` 加载技能，再描述任务。

新对话按任务的 `cwd` 归入 DSH 的项目文件夹。例如 `cwd` 为 `C:\work\my-project` 时，桥接服务会先调用 `workspace/create`，按目录路径取得或登记项目，再用返回的 `workspaceId` 创建对话。已有项目的名称和目录保持原样。

项目归属取决于任务目录，和 DSH-CoWork 源码存放位置分别管理。希望对话出现在父目录项目下时，应将任务的 `cwd` 设为父目录。此行为适用于新建对话；已有对话不会自动迁移。

ZCode 保存 `taskId`、回执的 `targetStartAfterCursor` 和 `nextCursor`，每次明确使用 `until=terminal,responseMode=compact,timeoutSec=30`。普通事件留在桥接内部；超时不重派、不取消 DSH。完成后获取完整结果、核对归属并验收，再正常释放 claim。队列/作业状态未知仍拒绝释放。阶段监督、steer/cancel、旧调用 change/full 和历史恢复保持可用。

返回的项目目录与请求 cwd 不一致时拒绝创建会话。同一目录树同一时间保持一个写任务；read-only 是协作约定，实际权限由 Desktop 决定。ZCode 尚未通过原生长调用验收，安装器和运行时均拒绝 long。

## 真实往返测试

用户级安装完成后，在仓库目录执行：

```powershell
node scripts/verify-zcode.mjs
```

脚本读取用户级配置，发送只读标记任务，绑定回执等待、取完整结果并正常释放。消耗少量模型额度并保留 DSH 对话。SDK PASS 只证明桥接到真实 Host，不代替 ZCode 原生界面验收。

可使用 `--project 'C:\work\my-project'` 指定项目。项目配置加 `--config 'C:\work\my-project\.zcode\config.json'`。回执立即保存到 `<project>/artifacts/dsh-verification/<taskId>.json`。

任务超时或待交互后，处理完可用回执续接同一轮：

```powershell
node scripts/verify-zcode.mjs --receipt '<printed-receipt-path>'
```

总观察预算 180 秒，每次最多 30 秒。续接不再派发；使用过自定义 project/config/bridge-home 时须提供相同参数。单独旧 taskId 不足以确定目标轮次，因此会被拒绝。审批和输入在 Desktop 处理。

最终在 ZCode 原生界面验证工具/skill 加载、等待不刷屏、完整结果、正常释放、同目录再派写任务，以及用户中断和审批。不得把 SDK 结果当作原生客户端已全部通过。

如果任务返回 `DeepSeek Messages transport failed` 或其他模型错误，先在 DSH Desktop 中检查该对话和模型连接。连接成功、任务已接收和模型正常回复是不同的检查结果。

## 更新与卸载

在当前源码目录构建并更新注册；存在本地改动时不要盲目 pull 覆盖：

```powershell
npm ci
npm run build
npm run setup-desktop -- --caller zcode --scope user --dry-run
npm run setup-desktop -- --caller zcode --scope user --apply
```

更新后重新打开 ZCode 会话。目录或配置条目发生变化时，按预览结果决定是否使用前面的 `--replace` 命令。

移除 ZCode 的 MCP 配置和技能：

```powershell
npm run setup-desktop -- --caller zcode --scope user --uninstall --apply
```

项目级安装使用相同的 `--scope project --project 'C:\work\my-project'` 参数卸载。卸载后保留配置备份、DSH 对话及 `%LOCALAPPDATA%\DSHDesktopCowork` 中的连接和任务记录。

连接插件可能被其他调用方共用。需要移除时，退出 DSH Desktop，再使用前面配置的实际 CLI 路径执行：

```powershell
& $dshCli plugin --profile desktop remove dsh-desktop-cowork-connector
```
