# TCP 字节流紧急修复记录

- 日期：2026-09-02
- 基线审计：`TCP-FILE-STREAM-CODE-REVIEW-2026-09-02.md`
- 范围：按要求暂不处理认证、设备凭据、WSS 和证书轮换问题
- 目标：先消除进程崩溃、覆盖/短写、挂死、资源失控、结果不确定和 A2A 未交付问题

## 1. 本轮结论

本轮已修复审计中最紧急的非认证类正确性和稳定性问题。传输现在采用持久状态记录，
接收端只有在完整写盘、校验、文件同步、无覆盖提交和目录同步完成后才进入
`DATA_COMMITTED`。最终 ACK 丢失时，发送端会查询该状态；若对端已经提交，只发送
小型 A2A 通知，不再重复传输文件。

这不等于已经达到公网生产发布条件。`TCP-002`、`TCP-003` 按本轮范围明确保留；能力
协商、完整结构化错误、安全自动 fallback、安装包统一和双设备长稳/性能测试也仍未完成。

## 2. 修复明细

| 审计项 | 状态 | 实现结果 |
|---|---|---|
| TCP-001 | 已修复 | 连接建立即安装 error/close 处理；注册头有独立大小/时间限制，错误返回结构化响应，畸形输入不再打崩进程。 |
| TCP-004 | 已修复 | 使用同目录 hard-link 的原子 no-clobber 提交，冲突自动选择新名称；恢复流程不会删除未经所有权确认的候选文件。 |
| TCP-005 | 已修复 | 提交后发送稳定 messageId 的 `a2a-transfer://<transferId>` FilePart；receiver 仅从本机持久状态解析成真实路径。 |
| TCP-006 | 已修复 | 0 B 在配对后直接进入 `WAIT_ACK`。 |
| TCP-007 | 已修复 | receiver 全生命周期纳入统一 try/catch；relay 增加 `registered` 确认，确认后才返回 prepare ready。 |
| TCP-008 | 已修复（v1 范围） | 增加原子 JSON 状态记录、启动恢复、幂等 prepare、status/cancel；ACK 不确定时先查询。尚未拆分 attemptId。 |
| TCP-009 | 已修复 | 预哈希前后校验同一文件描述符；发送前及发送后验证设备/inode/大小/mtime/ctime，并在发送中同步校验大小和 SHA。 |
| TCP-010 | 已修复 | socket write 同时感知 error/close，sender 所有异常出口统一销毁 socket 并关闭文件描述符。 |
| TCP-011 | 已修复 | 循环处理 partial write，提交前同步文件，link/remove 后同步父目录。 |
| TCP-012 | 已修复 | relay 使用显式状态机，任一角色在非终态断开立即使会话失败。 |
| TCP-013 | 已修复（全局预算） | 拆分 header/pairing/stall/absolute deadline；增加连接、session、在途字节和 gateway 接收并发/字节上限。每设备/IP 配额仍是后续加固。 |
| TCP-016 | 已修复（当前进程） | 活动接收保存取消句柄；提供 status/cancel；gateway stop 会取消并限时等待清理，relay 支持优雅 shutdown。 |
| TCP-017 | 已部分修复 | relay 新增 happy path、0 B、超长头不崩溃、receiver 断开用例，并加入 CI。TLS、ACK 丢失和双设备矩阵仍需补充。 |
| TCP-021 | 已修复 | 限制 UTF-8 字节数，处理控制字符、Windows 保留名和尾随点/空格。 |
| TCP-022 | 已修复 | ACK 强校验 transferId/size/sha/path/name；对外工具结果不再传播 receiver 绝对路径。 |
| TCP-024 | 已部分修复 | relay 环境数值、端口、ID/ticket/device/size/hash 均 fail-fast 或有界校验；插件启动组合校验仍可加强。 |
| TCP-026 | 已部分修复 | systemd 增加 `MemoryMax=1G`、`TasksMax=256`，并把协议资源上限显式写入环境。更严格文件系统/网络沙箱待部署验证。 |

## 3. 状态与结果语义

接收端状态为：

`PREPARING -> READY -> TRANSFERRING -> COMMITTING -> DATA_COMMITTED -> COMPLETED`

失败终态为 `FAILED_CONFIRMED` 或 `CANCELED`。

- `DATA_COMMITTED`：内容、长度和 SHA-256 已验证，文件及目录已同步，最终文件名已用
  no-clobber 原语提交；即使最终 TCP ACK 丢失，也不能再自动重传文件。
- `COMPLETED`：receiver 已收到并解析对应的 A2A FilePart，文件路径已交给 executor。
- `FAILED_CONFIRMED`：未形成可确认的持久提交，可以由上层按策略重试。
- restart 遇到 `COMMITTING` 时，只有候选文件通过所有权/摘要验证才提升为
  `DATA_COMMITTED`；否则只清理本 transfer 的 `.part`，绝不删除候选最终文件。

## 4. 新增配置

Gateway `fileTransfer`：

| 配置 | 默认值 | 含义 |
|---|---:|---|
| `maxConcurrentReceives` | 4 | 同时活动的接收任务上限 |
| `maxInFlightBytes` | 2147483648 | 活动接收声明大小总和上限；解析时至少为单文件上限 |

Relay 新增 `HEADER_BYTES`、`HEADER_MS`、`PAIRING_MS`、`STALL_MS`、
`MAX_DURATION_MS`、`MAX_SESSIONS`、`MAX_CONNECTIONS` 和 `MAX_INFLIGHT_BYTES`
对应环境变量，systemd 模板已给出有界默认值。

## 5. 验证记录

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过 |
| `node --test server/file-relay.test.cjs` | 4/4 通过：1 MiB、0 B、超长注册头后进程存活、receiver payload 后断开 |
| 持久 store 独立运行检查 | 通过：崩溃恢复不修改同名既有文件；仅解析已提交本地 URI |
| `git diff --check` | 通过（仅有仓库既有 LF/CRLF 提示） |
| 插件 `npm test` | 未运行到测试：当前 Windows 主机 Node 24 的 `os.userInfo()` 返回 `uv_os_get_passwd ENOMEM`，tsx 启动前失败；不是断言失败 |

尚未在本机完成真实 TLS relay、双设备公网、磁盘满、ACK 人工丢包、1 GiB 和多并发
长稳测试。因此本轮结论是“紧急代码缺陷已收敛并有基础回归”，不是“已完成生产验收”。

## 6. 明确保留的问题

1. `TCP-002`：prepare 可信 source、peer/调用方认证和完整入站策略绑定；
2. `TCP-003`：WSS 控制面、设备凭据和证书轮换；
3. `TCP-014`/`TCP-015`：能力协商、结构化阶段错误，以及只有 pre-start 确定失败才允许的安全 fallback；
4. `TCP-018`：源码、插件包、完整 OpenClaw 安装包与部署端版本统一；
5. `TCP-019`/`TCP-020`：双遍读取成本、真实容量基准和弱网/高并发长稳；
6. `TCP-025`：attemptId、过期时间、feature bits 和未来 QUIC/TCP 统一协议。

在上述认证与兼容能力完成前，不应开放到不可信公网，也不应启用自动
`TCP -> inline-base64` fallback；尤其不能在结果不明确时切换传输方式。
