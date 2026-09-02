# TCP 字节流文件传输代码审计

- 审计日期：2026-09-02
- 审计对象：`feature/a2a-tcp-file-stream-v1`
- 审计提交：`682d484c4a0bbca15e9c7c7904277c089e5c699a`
- 审计范围：插件控制面、TCP 客户端、File Relay、Nginx/systemd、测试与发行物
- 目标：高速、稳定、可维护、向后兼容
- 性质：初始问题基线；后续修复见 `TCP-FILE-STREAM-URGENT-FIXES-2026-09-02.md`

## 1. 结论

当前版本适合作为验证 TCP 数据面的原型，**不应按生产可用版本部署到公网，也不应
接入自动降级链路**。

方向正确的部分包括：文件数据不进入 A2A JSON、收发端按流处理、存在长度和
SHA-256 校验、使用 256-bit 随机 ticket、TLS 连接、基本背压、单文件大小上限，
并且功能默认关闭，不会直接破坏旧的 base64 路径。

但实现仍有以下发布阻断问题：

1. 公网 relay 可被一个超长注册头直接打崩；
2. receiver prepare 没有绑定可信来源，也绕过既有入站认证和文件策略；
3. 提供的部署配置让控制隧道走明文 WebSocket，ticket 和设备身份边界不成立；
4. 同名并发提交存在覆盖已落盘文件的竞争；
5. TCP 落盘成功没有形成 A2A FilePart/message，工具却向 sender 报告“发送完成”。

因此目前不能保证稳定性、交付语义或公网安全。P0 必须全部修复后才适合受控灰度；
P1 必须全部修复后才适合加入 `QUIC -> TCP -> inline-base64` 自动选择。

## 2. 优先级定义

| 级别 | 定义 | 发布要求 |
|---|---|---|
| P0 | 可导致服务被远程打崩、未授权落盘、文件覆盖/丢失或核心交付语义不成立 | 阻断部署与灰度 |
| P1 | 常见边界会挂死、结果不确定、资源泄漏、无法安全重试或新旧版本不兼容 | 阻断生产和自动 fallback |
| P2 | 性能、容量、运维、安全加固或长期演进明显不足 | 生产前完成，或有明确容量边界 |
| P3 | 文档、指标、清理和工程一致性问题 | 发布前收敛 |

## 3. 问题总表

| ID | 优先级 | 问题 | 主要影响 |
|---|---|---|---|
| TCP-001 | P0 | 无效/超长首包可触发 relay 未处理的 socket error，进程退出 | 远程拒绝服务 |
| TCP-002 | P0 | prepare 未认证且未绑定 tunnel 的可信 source | 未授权文件落盘、磁盘/连接 DoS |
| TCP-003 | P0 | 提供的边缘配置使用明文 WS 控制面，且客户端没有设备认证凭据 | ticket 泄露、设备冒充、会话劫持 |
| TCP-004 | P0 | `availablePath()` 与 `rename()` 之间存在同名覆盖竞争 | 已有文件被覆盖、结果分裂 |
| TCP-005 | P0 | 流传输提交后没有 A2A 文件通知 | receiver agent 不知道文件到达，成功语义虚假 |
| TCP-006 | P1 | 0 字节文件永远不进入 relay ACK 阶段 | 空文件必定超时 |
| TCP-007 | P1 | receiver 的 `ready` 可能永久 pending，也可能在 relay 确认前过早成功 | prepare 挂死或产生假 READY |
| TCP-008 | P1 | 没有持久状态、幂等提交和 status query | ACK 丢失后重复文件或永久不确定 |
| TCP-009 | P1 | hash 后重新按路径打开源文件，缺少稳定源快照 | 文件变化导致超时或摘要失败 |
| TCP-010 | P1 | sender 异常路径不统一关闭 socket，`drain` 等待不感知 error/close | 连接和调用可长期泄漏/挂死 |
| TCP-011 | P1 | receiver 未处理 partial write，也未在 ACK 前 fsync 文件和目录 | 落盘内容/掉电持久性不可靠 |
| TCP-012 | P1 | payload 完成后 receiver 干净断开不会立即销毁 relay session | sender 最长等待 30 分钟 |
| TCP-013 | P1 | relay 使用固定绝对超时，且 gateway/relay 无资源预算 | 正常慢传被中止，批量连接可耗尽资源 |
| TCP-014 | P1 | 没有能力和 relay 身份协商，也没有兼容 fallback | 旧 peer 或配置不同的 peer 直接失败 |
| TCP-015 | P1 | 错误全部退化为字符串和 `UNAVAILABLE` | 不能区分安全重试与结果不确定 |
| TCP-016 | P1 | 无 status/cancel，shutdown 也不能收敛活动传输 | 运维和恢复不可控 |
| TCP-017 | P1 | CI 不执行 relay 测试，现有测试仅覆盖 happy path | 关键协议回归无法被拦截 |
| TCP-018 | P1 | 完整 OpenClaw 安装包仍内置 1.4.3，不含本次 TCP 实现 | 源码、插件包和设备安装结果分裂 |
| TCP-019 | P2 | 发送前完整预哈希导致源文件读取两遍 | 大文件受磁盘吞吐限制，首字节延迟高 |
| TCP-020 | P2 | Nginx 单 worker、固定连接上限，且控制/文件共享入口 | 并发吞吐和故障域没有容量依据 |
| TCP-021 | P2 | 文件名规则缺少长度和跨平台保留名处理 | Windows/不同文件系统兼容失败 |
| TCP-022 | P2 | ACK 字段验证不完整并把 receiver 绝对路径返回远端 | 协议欺骗、路径信息泄露 |
| TCP-023 | P2 | 配置脚本硬编码环境，证书只支持单 leaf pin | 环境不可移植，证书轮换即中断 |
| TCP-024 | P2 | relay 环境参数和注册字段校验不完整 | 错配置、异常内存/日志和协议行为 |
| TCP-025 | P2 | 协议缺少 `attemptId`、过期时间和可演进 feature 字段 | 后续 QUIC/TCP 统一和安全降级困难 |
| TCP-026 | P2 | systemd 缺少内存/任务/网络族等资源边界 | 故障或攻击时影响整机 |
| TCP-027 | P3 | verify 指标、版本文档和打包内容不一致 | 排障和发布判断容易被误导 |

## 4. P0 详细问题

### TCP-001：超长注册头可让 File Relay 进程退出

证据：

- `server/file-relay.js:17-31` 在读取首行时可能执行
  `socket.destroy(new Error("header too large"))`；
- socket 的 `error` 监听直到成功解析注册头后的 `server/file-relay.js:125` 才安装；
- 因此预注册阶段产生的 error 没有监听器，Node 抛出未处理的 `error` 并退出。

本次实测向本地 relay 发送超过 16 KiB、无换行的首包，进程以 code 1 退出，栈顶为：

```text
Unhandled 'error' event
Error: header too large
at Socket.onData (.../server/file-relay.js:21:60)
```

影响：公网监听经过 Nginx 暴露，任意连接者都可以重复触发 systemd 重启，形成稳定
DoS。畸形 JSON、首包超时等预注册错误也必须按同一原则处理。

整改：连接建立后第一时间安装 error/close handler；`readHeader` 返回结构化错误而不是
制造未观察的 socket error；给首包单独设置 5–10 秒超时；增加畸形 JSON、超长头、
慢速逐字节头和断开 fuzz 测试。

### TCP-002：prepare 未绑定可信 source，且绕过接收策略

证据：

- `/a2a/file-transfer/prepare` 注册在通用 JSON parser 后、A2A `userBuilder` 认证之外，
  见 `a2a-plugin/index.ts:687-723`；
- handler 只比较 body 自报的 `targetDevice`，不校验 source，也不校验调用方身份；
- tunnel 外层虽带有 relay 绑定的 `source_device`，但
  `a2a-plugin/src/tunnel/session.ts:487-500` 转成本地 HTTP 时没有注入该可信来源；
- receiver 没有执行既有 `allowedMimeTypes` 等入站 FilePart 策略。

攻击者只要能通过 tunnel 调用目标设备，就可以自己生成 transferId/ticket/sha，触发
receiver 连接 File Relay，再以 sender 角色上传任意内容到 `receiveDir`。单文件受大小
上限，但没有并发和磁盘总量上限。

整改：relay 必须以已注册连接覆盖外层 source；TunnelSession 删除来路中同名 header，
再注入可信 source header；prepare 同时验证 header、offer.sourceDevice、targetDevice、
已配置 peer 和认证上下文；接收端重新执行 MIME、大小、并发、目录及磁盘策略。

### TCP-003：部署模板中的控制面是明文且缺少设备认证

`server/nginx-a2a.conf:18-27` 明确让 plaintext WS 走 default upstream，只有
`a2a-file.invalid` 的 TLS 流量在第二个 listener 终止 TLS。ticket 正是通过该 WS 控制面
发送。插件 `TunnelConfig` 和 REGISTER 也没有 shared token 或设备签名字段；仅声明
`device_id`，同名连接还可能替换旧连接。

这意味着在提供的公网部署模型下：

- on-path 观察者可读取 ticket 和 offer；
- 未授权连接可尝试注册/替换设备 ID；
- 数据面的 TLS 不能弥补控制面凭据已经泄露。

整改：控制面必须使用 WSS，并给设备提供独立认证凭据；不要为兼容旧 relay 自动降级
到无认证 REGISTER。若继续共享 8001，需要为 control 和 file 配置两个明确 SNI 并均
终止 TLS；更简单的首版方案是分端口，减少路由歧义和共同故障域。

### TCP-004：同名文件提交不是 no-clobber

`a2a-plugin/src/file-transfer.ts:74-84` 先用 `access()` 找“可用”名字，真正提交直到
`a2a-plugin/src/file-transfer.ts:256` 才 `rename()`。两个并发传输可同时选择相同
finalPath；在允许 replace 的平台上，后提交者会覆盖先提交者。即使平台返回失败，
不同操作系统行为也不一致。

整改：开始接收时原子预留目标名，或提交时使用真正的 no-replace 原语；冲突时重新
分配名字，不能覆盖。transfer store 需要把保留名和 transferId 绑定。测试必须覆盖
同名并发、已有文件、进程重启和 Windows/POSIX。

### TCP-005：成功落盘没有形成 A2A 交付

`sendStreamFileCore` 在收到 ACK 后直接向 sender 返回成功，见
`a2a-plugin/index.ts:1201-1208`。receiver 侧只有落盘日志
`a2a-plugin/index.ts:710-717`，没有 A2A message、FilePart、task 或 artifact，executor
也不知道这个文件。

因此“TCP 文件发送完成”目前只表示某目录里多了一个文件，不表示 peer agent 收到
文件。这破坏了工具名称和原有 `a2a_send_file` 的语义。

整改：DATA_COMMITTED 后通过正常 A2A 消息发送小型 FilePart，例如
`a2a-transfer://<transferId>`；receiver 只从本机持久状态解析该 URI，并把真实路径交给
executor。通知使用稳定 messageId；通知失败只能重试通知，不能重传文件。

## 5. P1 详细问题

### TCP-006：0 字节文件 ACK 死锁

relay 只在 `consume()` 中检测 `remaining === 0` 并开始读取 ACK，见
`server/file-relay.js:56-75`。size 为 0 时 `consume()` 从不执行。

本次实测结果：

```json
{"gotReady":true,"gotMetadata":true,"gotAck":false}
```

relay 最终按 pairing timeout 报失败。修复后 0 B 必须直接进入 WAIT_ACK。

### TCP-007：前置失败不会 reject `ready`

`validateOffer()`、`mkdir()` 和 `availablePath()` 位于
`a2a-plugin/src/file-transfer.ts:204-209` 的 `try` 之外。任一失败只会 reject
`completed`，而 prepare 正等待的 `ready` 永远 pending。无效 offer、目录不可写、
文件名分配失败都会造成长时间挂起。

反过来，`a2a-plugin/src/file-transfer.ts:215-220` 写出 receiver 注册头后立刻 resolve
`ready`，并没有等待 relay 确认注册成功。ticket 冲突、重复 receiver 或 relay 拒绝时，
prepare 仍可能短暂返回假 READY。

整改：整个 receiver 生命周期进入一个 try/catch/finally；确保 ready 只结算一次，
且 completed、socket、part、活动表在所有出口一致收敛。

### TCP-008：没有持久幂等状态与查询

receiver 只有内存 `Map<transferId, Promise>`，完成即删除；没有 committed record、
status endpoint 或启动恢复。receiver 已 rename、ACK 永久丢失时，sender 得到失败，
下一次生成新的 transferId 后会产生重复文件。进程崩溃还会留下无法归属的 `.part`。

整改：持久化 transfer/attempt 状态；同一 transferId 幂等返回既有提交；提供
prepare/status/cancel；`AMBIGUOUS` 必须先查询，不能直接 fallback 或换 ID 重传。

### TCP-009：源文件不是稳定快照

`inspectFile()` 先 stat+完整 hash，发送阶段又按路径重新创建 ReadStream，见
`a2a-plugin/src/file-transfer.ts:192-196`、`304-306`。期间文件缩短会让双方等待声明的
剩余字节直到超时；增长会被 relay 拒绝；同尺寸修改会摘要失败。

整改：以一个已打开 descriptor 或受控快照绑定 size/hash/send；发送前后校验 inode、
size、mtime；发送端严格限制恰好 `offer.size` 并同步计算摘要，变化时返回明确的
`SOURCE_CHANGED`，立即关闭双方连接。

### TCP-010：sender 异常路径会泄漏或挂死 socket

`sendFilePayload()` 没有 try/finally。ready 错误、源文件读取错误、ACK 错误时都没有
保证 destroy socket。更严重的是 `socket.write()` 返回 false 后只等待 `drain`，见
`a2a-plugin/src/file-transfer.ts:304-305`；如果期间 socket error/close，Promise 不会
reject，调用可永久停在该 await。

整改：使用可取消的 write/pipeline primitive，同时监听 drain/error/close；所有出口
在 finally 中关闭或销毁 socket 和 ReadStream；超时使用统一 AbortSignal。

### TCP-011：写盘与持久提交语义不足

receiver 忽略 `FileHandle.write()` 返回的 `bytesWritten`，却按整个 chunk 更新 hash 和
received，见 `a2a-plugin/src/file-transfer.ts:230-236`。partial write 时内存摘要正确，
磁盘文件却可能短写。rename 前也没有 file fsync，rename 后没有 parent directory
fsync，但 ACK 已表示成功。

整改：循环 write 直到完整 chunk；close 前 fsync 文件；no-clobber rename/link 后
fsync 父目录；仅在这些步骤全部成功后记录 DATA_COMMITTED 并 ACK。

### TCP-012：payload 后 clean close 不会及时失败

relay 的 close handler 只有 `remaining > 0` 才销毁 session，见
`server/file-relay.js:126-129`。payload 已收完、等待 receiver ACK 时，receiver 干净
断开会留下 session 和 sender，直到 30 分钟总 timer/idle timeout。

整改：显式状态机 `PAIRING -> TRANSFERRING -> WAIT_ACK -> DONE`；任何角色在非 DONE
状态关闭都立即收敛；header reader 自身也要监听 end/close/error。

### TCP-013：缺少 admission control 和资源预算

当前只有单文件 `MAX_BYTES`。不存在每 IP/设备连接数、全局 session 数、活动传输数、
总在途字节、接收目录配额或速率限制。未完成首包和单边配对默认可占用资源 30 分钟。
gateway 的 `activeFileReceives` 也无限增长。

prepare 还复用了为 inline-base64 放大的全局 JSON parser，见
`a2a-plugin/index.ts:679-692`；本应只有几 KiB 的控制消息可以在认证/校验前占用接近
inline body 上限的内存。该端点需要独立的小 body limit。

同一个 30 分钟 `session.timer` 从首个角色注册时开始，传输过程中不会按进度重置，
见 `server/file-relay.js:89-96`。因此低于约 4.8 Mbit/s 的 1 GiB 正常传输也可能在持续
前进时被固定计时器强制中断；这又与客户端和 Nginx 的 idle timeout 语义不一致。

整改：分开 header、pairing、idle/stall 和可选 absolute deadline；按有效进度更新 stall
计时。增加每设备和全局并发上限、总在途字节、磁盘预检、速率/低速淘汰、Nginx
连接限制及明确 BUSY 响应。不要靠 `LimitNOFILE=65536` 代替应用层限流。

### TCP-014：没有能力与 relay 协商，也没有兼容降级

Agent Card 只声明 `tunnelDeviceId`，见 `a2a-plugin/src/agent-card.ts:78-82`。sender 把
“有 tunnelDeviceId”等同于“支持 TCP prepare”。旧 receiver 会 404；两端 relay host、
port、SNI 或协议版本不同则分别连到不同会话，等待超时。失败后也不会回到原有
inline-base64。

同时，已有 `a2a_send_file` 原本是 URI 工具，本版本把 local `path` 加入同一工具并取消
schema 对 `uri` 的必填约束；path 和 uri 同时提供时又静默优先 path。这会改变旧工具的
生成约束和模型选择行为。首版更安全的兼容策略是保留旧工具 contract，新增显式
stream 工具，灰度完成后再考虑统一入口。

整改：Agent Card metadata 声明 `tcp-v1` 和上限；prepare 返回本次实际 endpoint/
relay identity；新 sender 与旧 receiver 默认继续 inline-base64；只有明确的
UNSUPPORTED/UNAVAILABLE_BEFORE_START 才允许安全 fallback。

### TCP-015：错误模型无法支持安全重试

底层错误都是自由文本，Gateway 再统一映射成 `UNAVAILABLE`，见
`a2a-plugin/index.ts:1225-1230`。无法区分认证失败、策略拒绝、源变化、校验失败、
开始前不可用和“可能已经提交”。如果以后直接据此 fallback，会制造重复交付。

整改：定义稳定错误枚举和阶段；至少包括 `UNSUPPORTED`、
`UNAVAILABLE_BEFORE_START`、`FAILED_CONFIRMED`、`AMBIGUOUS`、`INTEGRITY_FAILED`、
`AUTH_FAILED`、`POLICY_REJECTED`、`CANCELED`。

### TCP-016：缺少取消和 shutdown 收敛

活动表只保存 completed Promise，拿不到 socket、partPath 或取消句柄。没有 cancel/status
endpoint；插件停止时只关闭 tunnel，不能通知或回收正在传输的 TCP 会话。

整改：manager 持有 attempt controller；工具取消、超时、gateway shutdown、relay
shutdown 都进入同一个状态机和清理路径，并为无法确认的提交保留 AMBIGUOUS 状态。

### TCP-017：测试与 CI 没覆盖真正的失败面

- `a2a-plugin/tests/file-transfer-stream.test.ts` 只测 ID/ticket、hash 和 config，没有建立
  TCP/TLS 传输；
- `server/file-relay.test.cjs` 只测 1 MiB happy path；
- `.github/workflows/test.yml` 的 working-directory 固定为 `a2a-plugin`，没有运行
  server relay 测试；
- 没有 0 B、错误 header、断线、慢连接、背压、同名并发、ACK 丢失、重启恢复、
  TLS/pin、跨版本和真实双设备测试。

整改：relay 测试纳入 CI；建立 protocol contract tests，让 TCP provider、relay 和
Gateway 共用失败矩阵。

### TCP-018：发行物没有统一

插件源码和 `artifacts/openclaw-a2a-1.5.0.tgz` 是 1.5.0，但
`openclaw-source/extensions/a2a-gateway/openclaw.plugin.json` 仍为 1.4.3，且没有
`fileTransfer`；`installer/openclaw-2026.3.13.tgz` 因而不包含本次 TCP 实现。
根目录和插件 README 也仍指导用户安装旧的完整包。

整改：功能验收后一次性同步插件源码、schema、版本、安装包、校验值和部署文档；增加
打包后解包检查，确认实际安装物包含目标代码和版本。

## 6. P2/P3 问题与优化方向

### 性能与容量

1. **TCP-019：双遍读取。** 发送前 hash 一遍，发送时再读一遍；大文件首字节延迟和
   本地 I/O 都接近翻倍。若协议必须预报 SHA，应使用稳定快照并明确接受双遍成本；
   若追求更低延迟，可在下一协议版本评估 trailer digest，但不能削弱最终完整性。
2. **TCP-020：没有容量基准。** `worker_processes 1`、`worker_connections 2048` 和
   `proxy_buffer_size 256k` 是固定值，且 control/file 共用 Nginx。需要分别测 1/2/8/32
   并发、10 MiB/100 MiB/1 GiB、快 sender+慢 receiver、CPU/TLS/内存/FD/磁盘瓶颈，
   再确定默认值。单机结果不能替代双设备公网长稳测试。

### 兼容性与协议演进

3. **TCP-021：文件名跨平台不足。** `safeName()` 没有限制 UTF-8 字节长度，也没有
   处理 Windows 保留名、尾随点/空格和不同文件系统规范化冲突。
4. **TCP-022：ACK contract 不完整。** sender 只检查 ok/sha/size，不检查
   transferId；其余字段直接类型断言并传播。ACK 还把 receiver 的绝对路径返回远端，
   没有必要且暴露本机布局。外部结果应只返回逻辑标识和安全元数据。
5. **TCP-025：版本模型不足。** 同一个 transferId 同时承担逻辑交付和本次尝试，
   offer 没有 attemptId、expiresAt、feature 位或 relay identity，不利于未来 QUIC/TCP
   统一、安全重试和滚动升级。

### 配置、部署与维护

6. **TCP-023：配置不可移植。** `configure-file-transfer.cjs` 硬编码公网 IP、SNI 和
   单个 leaf fingerprint。证书轮换没有双 pin 窗口；缺 pin 时默认
   `a2a-file.invalid` 又无法通过普通公共 CA 验证。脚本应参数化，证书策略支持当前+
   下一 pin 或受信 CA/hostname 模式，并在启动时 fail-fast。
7. **TCP-024：校验不足。** relay 没有 fail-fast 校验 MAX_BYTES/WAIT_MS/PORT，设备字段
   也缺类型和长度限制；插件 parser 没有完整验证 fingerprint、host、port 和 receiveDir
   组合。
8. **TCP-026：服务隔离不足。** File Relay service 可增加 `MemoryMax`、`TasksMax`、
   `ProtectSystem`、`PrivateDevices`、`RestrictAddressFamilies` 等边界；若启用
   `ProtectHome`，需先为实际工作目录配置最小只读例外。Nginx 容器应固定 digest、
   drop capabilities、只读根文件系统并设置资源限制。
9. **TCP-027：指标与文档不一致。** `receiverVerifyMs` 只计量 `hash.digest()`，不代表
   文件验证或持久化耗时；README 仍写 1.4.3；1.5.0 包还携带嵌套的 1.4.3 tgz 目录。
   应拆分 hash/fdatasync/commit/ack 指标，并清理旧版本内容。

## 7. 推荐整改顺序

### 阶段 A：先消除公网和数据损坏风险

1. 修 TCP-001，加入 relay 畸形输入测试并纳入 CI；
2. 控制面改 WSS + 设备认证，注入可信 source；
3. prepare 执行 peer 和接收策略校验；
4. 实现 no-clobber、write-all、file fsync、directory fsync；
5. 在完成以上工作前，不对公网开放 File Relay。

### 阶段 B：建立确定的传输状态机

1. 修复 0 B、前置异常、clean close、drain/error 和统一 socket cleanup；
2. 引入 transferId + attemptId、持久 record、status/cancel；
3. 明确 DATA_COMMITTED、COMPLETED、FAILED_CONFIRMED 和 AMBIGUOUS；
4. gateway/relay 增加并发、在途字节、磁盘和慢连接预算。

### 阶段 C：恢复 A2A 与版本兼容语义

1. commit 后发送 `a2a-transfer://<transferId>` FilePart；
2. Agent Card 声明 `tcp-v1` 能力和上限；
3. 实现安全的 TCP -> inline-base64 fallback；
4. 新旧 sender/receiver 四组合回归；
5. 最后统一源码、插件包、OpenClaw 完整安装包和文档版本。

### 阶段 D：性能定型

完成正确性和限流后再优化吞吐，避免用 benchmark 掩盖错误语义。至少记录：

- sender hash、setup、payload、ACK；
- receiver download、fsync、commit；
- relay 吞吐、event-loop lag、RSS、FD 和 session 数；
- P50/P95/P99、失败类别和 fallback 原因；
- 0 B、1 B、1 MiB、10 MiB、100 MiB、1 GiB；
- 1/2/8/32 并发及弱网、断网、磁盘慢/满场景。

## 8. 验收门槛

TCP provider 进入自动选择前，应同时满足：

1. P0、P1 全部关闭并有回归测试；
2. relay 对任意畸形首包不崩溃，且有连接/session/内存上限；
3. 双设备双向通过 0 B、1 B、10 MiB、100 MiB，目标上限文件至少完成一次；
4. 同名并发不覆盖，掉电语义经 fsync/no-clobber 测试；
5. sender/receiver/relay 在每个协议阶段断线都能在规定时间收敛；
6. ACK 丢失时通过 status 得到唯一结果，不重复提交；
7. receiver agent 实际收到文件通知，而不只是目录里出现文件；
8. 新旧版本组合仍可使用原有 inline-base64；
9. QUIC 不可用时只有确定的 pre-start 错误才切 TCP，TCP 结果不明确时不继续 base64；
10. 完整安装包解包与真机版本、源码提交和服务端版本一致。

## 9. 本次验证记录

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过 |
| `node --test server/file-relay.test.cjs` | 通过，1 个 1 MiB happy-path 用例 |
| 超过 16 KiB 的 relay 注册首包 | 复现进程 code 1 退出，确认 TCP-001 |
| 0 B sender/receiver 配对 | ready/metadata 已到，ACK 未到，确认 TCP-006 |
| 插件全量 `npm test` | 当前主机的 Node `os.userInfo()` 返回 ENOMEM，tsx 启动前失败；不计为代码失败 |

本次没有执行公网吞吐基准和双设备 TLS 长稳测试，因此不能据此声称达到目标带宽或
生产稳定性。现有测试绿灯只能证明单个 happy path，不能反驳以上状态机和安全问题。
