---
name: zcode-dsh-desktop
description: 在 ZCode 中通过 dsh_desktop MCP 将任务交给本机正在运行的 DSH Desktop，继续指定任务或会话，等待并验收结果。用于用户要求“交给 DSH”“继续 DSH 任务”“检查 DSH 结果”。
---

# ZCode 与 DSH Desktop 协作

## 连接

使用客户端实际公开的 dsh_desktop 工具；插件可能为工具名添加命名空间。
先调用 dsh_host_status，确认 reachable、adapter、observation 能力。
工具缺失时报告安装问题；连接不可达时报告 errorCode。不要启动另一个 Host、
修改模型、权限或自行建立第二条连接。

在 DSH-CoWork 源码目录构建后，用 setup-desktop --caller zcode --scope user --dry-run 预览，--apply 安装；已有不同条目先审查 --replace 预览。重载或新建客户端会话。项目级安装使用 --scope project --project <绝对目录>。

本接入只启用 bounded，单次最多 30 秒；不要设置 long 或请求 900 秒。
Kimi/ZCode 的原生后台、插话及长调用尚未验收，不能根据 SDK 成功推断已支持。

## 派发与续接

- 新任务用 dsh_delegate：真实绝对 cwd、简短 title、waitSeconds:0。
  修改文件用 exclusive-write，只读用 read-only。它是 bridge 协作约定，不是 Host 沙箱。
- prompt 包括目标、交付物、已完成工作、相关路径、允许修改范围、约束与验收命令。
  不传聊天全文、秘密或无关大段文件。模型、推理强度和 preset 继承 Desktop。
- 保存 taskId 和 receipt.waitTarget.targetStartAfterCursor。
- 续同一任务先 dsh_status，再 dsh_followup；queue 后换成新 receipt 的目标，steer 保持当前目标。
  不自动把失效 steer 改成 queue，不重试结果不明的提示发送。
- 用户指定已有 Desktop 会话时先 dsh_find_sessions；用唯一目标的 sessionId 和返回前置条件
  dsh_attach_session，成功后才能 followup。无法唯一确定时请用户选择。

## 等待

每次 dsh_wait 明确传入以下参数，并使用收到的真实数值：

```json
{"taskId":"<receipt taskId>","until":"terminal","responseMode":"compact","timeoutSec":30}
```

每次都还须附加 receipt 中真实的 targetStartAfterCursor，不能猜数值。后续使用 sinceCursor=上次 nextCursor，
同一轮继续带 targetStartAfterCursor。普通工具事件留在 bridge 内部。
仅需要阶段性监督时选择 change；需要细节才调用 dsh_tail。

timeout 是正常观察结果，不代表 DSH 失败。继续已授权任务并给有意义的进展，
不要因固定几次空超时便结束，也不要声称有未实现的后台通知。
awaiting_approval / awaiting_input 时请用户到 DSH Desktop 处理；同一待处理交互
未解决前不要立即重复 wait。连接/恢复异常先查状态，保留 taskId 与 receipt。

取消观察不会取消 DSH。客户端超时后先检查同一任务，不能重新派发。
若客户端确实将 wait 放入后台，保存它的句柄并回收该结果，避免再建重复 waiter。

## 完整结果与释放

compact 摘要不是交付物。同一轮仍为当前轮时，用一次 dsh_status 取完整 finalMessage，
核对 finalMessagePointer。若已开始另一轮，用 dsh_tail：
sinceCursor=finalMessageAfterCursor、maxEvents=1，核对 sourceSessionId/sourceSeq
与目标 pointer 的 sessionId/seq。缺失、截断、不可用内容不能当验收通过。
ambiguous_wait_target / unverified_wait_target 时检查归属，不得重发任务。

根据原请求检查实际文件、差异和必要测试。未达标则在仍持有 claim 时 followup 同一任务。
验收结束后 dsh_release_workspace；它会读真实 inbox/jobs。
session_busy / workspace_state_unknown 时保留占用并报告原因，不删除锁或伪造空状态。
实际取消状态为 canceled，取消结果需要报告；正常释放仍由真实状态守卫决定。
释放不删除 Desktop 项目或会话；释放后不要在无新 claim 的情况下继续写该目录。

同一目录树保持一个写入者；多个客户端须共用同一 DSH_BRIDGE_HOME 才共享占用记录。
完整语义见 [references/cowork-semantics.md](references/cowork-semantics.md)。
