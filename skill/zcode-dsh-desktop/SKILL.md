---
name: zcode-dsh-desktop
description: 在 ZCode 中通过 dsh_desktop MCP 服务把任务交给本机 DeepSeek Harness Desktop，查询进度、继续任务并验收结果。用户提到“交给 DSH”“让 DSH 做”“继续 DSH 任务”“DSH 做完了吗”，或要求连接 DSH Desktop、接续指定 DSH 会话时使用。
---

# 在 ZCode 中调用 DSH Desktop

使用 `dsh_desktop` MCP 服务连接当前用户的 DSH Desktop。DSH Desktop 需要保持运行。

## 检查连接

先调用 `dsh_host_status`，确认 `reachable`、协议族和能力。

如果工具尚未出现在 ZCode 中，在 DSH-CoWork 仓库目录检查并注册：

```powershell
npm run doctor:desktop
npm run setup-desktop -- --caller zcode --scope user --dry-run
npm run setup-desktop -- --caller zcode --scope user --apply
```

注册后重新打开 ZCode 会话。安装器需要 DSH 插件已经发布 `connection.json`。连接文件包含凭据，只传递文件路径，保持文件权限并避免输出其内容。

若 `reachable` 为 false，报告 `errorCode` 和实际检查结果。`connector_missing` 表示需要检查 Desktop 插件；`stale_connection` 表示连接文件已过期，应检查 Desktop 是否仍在运行。

## 发起和继续任务

新任务调用 `dsh_delegate`，传入：

- `prompt`：目标、交付物、允许修改的范围、已完成工作、相关路径、约束和验收命令。
- `cwd`：项目的真实绝对路径。
- `title`：便于在 DSH Desktop 中识别的标题。
- `workspaceMode`：只读任务用 `read-only`，修改文件的任务用 `exclusive-write`。

保存返回的 `taskId`。继续已有任务时，先调用 `dsh_status`，再对同一个 `taskId` 调用 `dsh_followup`。

用户指定已有 DSH 会话时，先用 `dsh_find_sessions` 查找，再按返回的前置条件调用 `dsh_attach_session`；附加成功后才发送 `dsh_followup`。多个候选无法唯一确定时，让用户选择。

## 等待和验收

用 `dsh_wait` 查询进度，每次最多等待 30 秒，后续调用沿用返回的 `cursor`。一次等待没有事件时，继续检查同一个任务。

出现 `awaiting_approval` 或 `awaiting_input` 时，告知用户到 DSH Desktop 处理。模型、推理强度和 agent preset 沿用 DSH Desktop 的设置。

任务完成后读取结果，检查文件改动并执行相应验收命令。需要补充工作时，对原 `taskId` 调用 `dsh_followup`。验收结束后调用 `dsh_release_workspace`，报告实际产出、验证结果和剩余问题。

同一目录树保持一个写入任务；并行写入任务使用互不重叠的目录。
