# DSH-CoWork

让 ZCode / Codex / Claude Code 把任务交给你电脑上已经打开的 **DeepSeek Harness Desktop**（下文简称 DSH）去做，然后查看进度、拿回结果、自己验收。

`zcode-support` 分支提供 ZCode 接入，使用源码安装。完整步骤见 [ZCode 安装与使用指南](docs/zcode.md)。

在调用方里说一句“把这个交给 DSH”，它会在 DSH Desktop 里新建一个会话执行任务。你可以在 DSH Desktop 里看到同一个会话和它的每一步操作，做完后由调用方检查改动和测试。

> 当前是测试版，只支持 Windows，已在 DeepSeek Harness Desktop 0.2.1-rc.2（Host 协议 4）上实机连通。

## 组成

| 部分 | 作用 |
|---|---|
| DSH 插件 `dsh-desktop-cowork-connector` | 装进 DSH Desktop。DSH 每次启动时，它把本机端口和登录凭据写到一个只有你本人能读的文件里，不开端口、不代理请求 |
| MCP 服务 `dsh_desktop` | 由 ZCode / Codex / Claude 自动启动，读取上面的文件后连接 DSH，提供 `dsh_delegate`、`dsh_wait`、`dsh_followup` 等工具 |
| skill `zcode-dsh-desktop` / `codex-dsh-desktop` / `claude-dsh-desktop` | 告诉调用方什么时候用这些工具、怎么交接任务、怎么验收 |

## 安装

需要：Windows 10/11 x64，已为当前用户安装 DeepSeek Harness Desktop，以及 ZCode、Codex 或 Claude Code。ZCode 请按 [专项指南](docs/zcode.md) 从源码安装。

### 方式一：安装包（推荐）

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

## 使用

保持 DSH Desktop 处于打开状态，在 ZCode / Codex / Claude Code 里直接说：

> 把这个任务交给 DSH：修复登录页提交失败的问题，只改登录相关代码和测试。做完你检查改动和测试，再告诉我结果。

- 可以让调用方使用对应的 skill，也可以显式调用：ZCode 里输入 `/zcode-dsh-desktop`，Claude Code 里输入 `/claude-dsh-desktop`，Codex 里输入 `$codex-dsh-desktop`。
- 新对话按任务的 `cwd` 归入 DSH Desktop 中对应路径的项目文件夹；已有项目会直接复用，该路径尚未登记为项目时自动登记。
- 模型和推理强度沿用 DSH Desktop 里的设置，这里不能修改。
- DSH 需要审批或向你提问时，到 DSH Desktop 里处理，调用方不会代你批准。
- 同一个目录同一时间只允许一个任务写入。任务验收完之后，调用方会释放这个目录的占用。

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
- 在没有开启 Windows 开发者模式的机器上，有 6 个创建符号链接的测试会失败，与功能无关。

## 来源

本项目基于 [Fly2Kiana/Codex-DSH-Orchestrator](https://github.com/Fly2Kiana/Codex-DSH-Orchestrator) 改写，后者派生自 [dsh-Agentlink](https://github.com/hootandy321/dsh-Agentlink)。仓库里保留了上游用于旧版 Web Host 的代码和 skill（`skill/codex-dsh`、`skill/claude-code-dsh`、`skill/codex-dsh-orchestrator`），相关文档放在 [docs/legacy/](docs/legacy/)。许可证为 MIT，详见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
