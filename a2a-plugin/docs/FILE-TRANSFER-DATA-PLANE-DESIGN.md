# A2A 文件传输数据面方案（合同先行）

- 状态：合同先行修订，待实施
- 相对「修订版」：发布面仍然收口；**合同面按长期多 provider 一次定死**
- 约束：向后兼容、失败不重复交付、大文件高速、**长期可维护、可扩展**
- 当前基础：
  - 现网 A2A Gateway + WebSocket tunnel + `a2a_send_local_file`（inline-base64，默认 50 MiB）
  - raw QUIC v7 真机双向 10/100 MiB 已验证
  - 文件传输仓：`Keanu2/Openclaw-A2A-file-transfer`（含 tcp-v1 / quic-v7 / inline-base64；原名 `Openclaw-A2A-tcp-file-stream`）

## 1. 决策摘要

分层不变：

```text
                         A2A 控制面（现有，不改 SDK / 不改标准 transport）
          能力声明、tunnel 转发、prepare / status / cancel、完成后 FilePart 指针
sender gateway  <--------------------------------->  receiver gateway
      |                                                    |
      |                   文件数据面（可插拔）              |
      +-------------- quic-v7  / UDP relay ----------------+
      +-------------- tcp-v1   / TLS relay ----------------+
      +-------------- inline-base64 / A2A JSON ------------+
```

长期结构是三个数据面共用**同一套合同**。第一版**发布**仍然只打开：

- 默认：现有 inline-base64（行为与现在完全一致）
- 灰度：双方具备 QUIC helper 且列入 `autoPeers` 时走 `quic-v7`
- TCP：作为合同内的第二个 stream provider 接入代码树，**默认不宣告、不自动选择**，直到通过与 QUIC 相同的 contract test 和双设备矩阵

用户入口始终只有 `a2a_send_local_file`。不新增 agent 工具，不把 QUIC/TCP 写进 Agent Card `additionalInterfaces`，不在 Node 里重写 QUIC，不 FFI `librcp_quic.so`，不把 QUIC 与 TCP relay 合成一个进程。

核心一句话：**瘦的是默认打开哪些 provider，不是把 attempt、错误类别、通知和目录各做一套。**

## 2. 重新评估：上一版哪里会伤害长期维护

上一版（「只做 QUIC + inline，本地注入，不引入 URI，第一版不写 TCP」）对**短期风险**是对的，对**五年扩展**不够。

| 上一版选择 | 短期收益 | 长期成本 |
|---|---|---|
| 不写 `tcp-provider.ts`，只留注释 | 少一个未验证实现 | TCP 快照继续以平行模块活着：第二套 store、第二套 offer、第二套配置 |
| 接收侧本地注入，不发 FilePart | 避开 SSRF 改动 | stream 成功不进入 A2A 历史；QUIC 与 TCP 快照（已用 `a2a-transfer://`）通知模型分裂 |
| FileOffer 可晚点再加 `attemptId` | 少字段 | TCP-025 已证明：没有 attempt 就无法安全换 transport；补字段是破坏性改协议 |
| `enabled` + `autoPeers` 替代能力集合 | 配置简单 | 无法表达「本机有 TCP、对端只有 QUIC」；每次加 provider 都改 manager 分支 |
| `receiveDir` 不用、沿用 `tempDir` | 兼容现网路径 | TCP 快照已用 `receiveDir` + `.a2a-transfer-state`；两套目录 = 两套恢复逻辑 |
| provider 名写死 `"quic-v7" \| "inline-base64"` | 类型窄、安全 | 加 `tcp-v1` / `quic-p2p` 变成类型破坏；合同测试无法对第三实现编译 |

同时，TCP 快照本身也**还不是**可扩展合同：

- `file-transfer.ts` 把 TLS 客户端、落盘、store、prepare 生命周期揉在一起，没有 `FileTransferProvider`
- `FileOffer` 没有 `version` / `attemptId` / `transport` / `expiresAt`
- 错误是字符串，manager 无法做安全降级
- `receiveDir` 与现网 `fileStorage.tempDir` 是两个概念
- prepare 仍未绑定 tunnel 可信 source（TCP-002）

若 QUIC 按上一版另起炉灶，仓库里会长期存在「TCP 专用栈」和「QUIC 专用栈」。这是最贵的维护形态。

**本版纠正：** 先把合同、目录、通知、错误、控制口做成**唯一一套**；QUIC 作为第一个填满合同的 stream 实现；TCP 快照**拆进**这套合同，而不是并列。发布策略仍然保守。

## 3. 长期必须稳定的合同

下面这些一旦发布，只允许加字段或加 provider 名，不允许改成功语义。

### 3.1 标识

```text
transferId  一次逻辑交付，跨 transport / attempt 不变；可进审计日志
attemptId   一次具体 provider 尝试；每次唯一
ticket      每 attempt 的 256-bit secret；只走 tunnel；派生 channel，不把 transferId 当 channel
```

`FileOffer.version` 从 1 开始。缺 `attemptId` 的旧 TCP 快照 offer 视为不兼容，不得混跑。

Channel / 会话密钥派生（QUIC 与 TCP 各自用自己的 wire，但密钥材料同一规则）：

```text
base64url(HMAC-SHA256(ticket, "openclaw-a2a-file\0" + transferId + "\0" + attemptId))
```

### 3.2 Provider 接口

```ts
type TransportName = "inline-base64" | "quic-v7" | "tcp-v1";

type ErrorCategory =
  | "UNSUPPORTED"
  | "UNAVAILABLE_BEFORE_START"
  | "FAILED_CONFIRMED"
  | "AMBIGUOUS"
  | "POLICY_REJECTED"
  | "INTEGRITY_FAILED"
  | "AUTH_FAILED"
  | "CANCELED";

interface FileTransferProvider {
  readonly name: TransportName;
  available(context: TransferContext): Promise<Availability>;
  prepare(context: TransferContext, offer: FileOffer): Promise<PreparedAttempt>;
  send(attempt: PreparedAttempt, sourcePath: string): Promise<TransferResult>;
  cancel(attemptId: string): Promise<void>;
}
```

规则：

- manager 是**唯一**跨 provider 状态机。provider 不得自行换 transport、不得调 agent、不得改其他 provider 的 record。
- `TransferResult` 必须带 `category`，禁止用 `message.includes("timeout")` 做降级。
- 成功的唯一定义：receiver 已校验 size + SHA-256，no-clobber 提交，目录 fsync，record 进入 `DATA_COMMITTED`。
- payload 开始之后的超时、断连、ACK 丢失 → `AMBIGUOUS`，先 status，禁止直接重传。

后续 P2P QUIC、对象存储、断点续传都是**新 provider 名或新 control version**，不改上述成功定义。

### 3.3 QUIC 后端是替换点，不是 provider 本身

```ts
interface StreamBackend {
  startReceiver(attempt: PreparedAttempt): Promise<void>; // 发出 registered
  send(attempt: PreparedAttempt, sourcePath: string): Promise<TransferResult>;
  cancel(attemptId: string): Promise<void>;
}
```

第一版 `QuicProcessBackend`：`spawn(rcp-raw-stream-v7)`。将来换长驻 daemon / 其它 QUIC 库时只换 backend，不改 manager、不改 Agent Card 名 `quic-v7`、不改 `a2a-stream/2` 除非升 ALPN。

TCP 同理：`TcpTlsBackend` 包现有 `file-relay.js` 协议；换 nginx 或直连 P2P 时只换 backend。

### 3.4 能力声明（可加不可改义）

只放 Agent Card `metadata`：

```json
{
  "openclawFileTransfer": {
    "version": 1,
    "control": "tunnel",
    "transports": ["quic-v7", "tcp-v1", "inline-base64"],
    "maxStreamBytes": 104857600,
    "maxInlineBytes": 52428800
  }
}
```

- 缺字段 = legacy，只假定 inline-base64。
- `transports` 是本机**当前可提供**的集合，不是愿望清单。无 RCP helper 就不要写 `quic-v7`；TCP relay 未启用就不要写 `tcp-v1`。
- Card 只用于筛选候选；**权威是 prepare 响应**。
- `maxInlineBytes` 必须等于 `security.maxInlineFileSizeBytes`。
- `enabled !== true` 时不得写出该 metadata，不得改现有工具返回。
- 未知 future transport 名：旧插件忽略，不得启动失败。

控制路径版本化，避免以后加字段只能靠猜：

```text
POST /a2a/internal/file-transfer/v1/prepare
GET  /a2a/internal/file-transfer/v1/status?transferId=
POST /a2a/internal/file-transfer/v1/cancel
```

`enabled !== true` 时不注册。文件字节不走 tunnel。

### 3.5 唯一通知合同：`a2a-transfer://`

所有 **stream** provider（QUIC、TCP、以后的 P2P）完成后，sender 发一个很小的标准 A2A FilePart：

```json
{
  "kind": "file",
  "file": {
    "uri": "a2a-transfer://<transferId>",
    "name": "example.bin",
    "mimeType": "application/octet-stream"
  }
}
```

`messageId` 由 `transferId` 派生，通知重试幂等。

receiver executor：

1. `a2a-transfer:` **不走网络 fetch**，只查本机 store；
2. 在 `validateUriSchemeAndIp` **之前**特判（现有 SSRF 只放行 http/https，TCP 快照已这样做）；
3. record 必须是 `DATA_COMMITTED` 或 `COMPLETED`；路径必须在统一落盘目录内；size/SHA 与记录一致；
4. 文案复用现有「【A2A 文件接收成功】+ 绝对路径」；
5. 解析成功后 record → `COMPLETED`。

inline-base64 **不使用**该 URI，继续走 `FilePart.bytes`。对 agent 来说两种路径最终都是同一段落盘文案。

上一版的「receiver 本地注入、不发 FilePart」只作为 `NOTIFY_PENDING` 的**降级补偿**（A2A 通知失败时本机仍能告知用户），不是主合同。主合同必须进入 A2A 消息，否则任务历史、多 agent、审计都无法扩展。

### 3.6 唯一落盘与状态目录

```text
files:  fileStorage.tempDir          # 现网默认 os.tmpdir()/a2a-files
state:  <tempDir>/.a2a-transfer-state/<transferId>.json
```

TCP 快照的 `receiveDir` **配置别名到 `fileStorage.tempDir`**，不再引入第二个用户可见目录。提交语义对齐现有 `uniquePathForName`（`a.jpg` → `a (1).jpg`），吸收 TCP 快照的 Windows 保留名 / 尾随点空格规则。

提交原语：优先同目录 `link(2)`（原子占名、同 inode）。**1.6.2**：若目标 FS 拒绝 hard link（鸿蒙 `Docs/OPENCLAW` 上常见 `EPERM`），回退 `rename(.part→最终名)`，再失败则 `copyFile` + 删 `.part`，并继续 no-clobber 换名；成功后仍 fsync 父目录。不改变 `DATA_COMMITTED` 含义。

store 用原子 JSON + 同目录 lock 文件，不依赖 `flock`。终态 TTL 可配。启动把遗留 active 标为 `INTERRUPTED` 再核对 `.part` / 最终文件 / helper，未知状态不得当失败重传。

通知合同（**1.6.1**）：发端须在收端记录已达 `DATA_COMMITTED`/`COMPLETED` 后再发送 `a2a-transfer://` FilePart；活动接收期间 status 可返回 `RECEIVING`。

## 4. 兼容与选择（发布策略，可配，不是合同）

新旧四组合在 `enabled=false` 或对端无 metadata 时，必须等于今天的 inline-base64。

默认选择：

```text
size <= 1MiB
    → inline-base64（不启动 helper / 不占 stream 槽）

双方交集含 quic-v7，peer ∈ autoPeers，size <= maxStreamBytes
    → quic-v7

双方交集含 tcp-v1，且配置允许 tcp（第一版默认不允许自动选）
    → tcp-v1

stream 在发出字节前失败（UNSUPPORTED / UNAVAILABLE_BEFORE_START / FAILED_CONFIRMED）
    → 仅当 size <= maxInlineFileSizeBytes 时 inline-base64
    → 否则明确失败

stream 已发字节后失败
    → AMBIGUOUS → status；已提交则成功并补通知；未提交才允许下一 provider
    → 下一 provider 仍受「未超 inline 上限才能回退 inline」约束

size > maxInlineFileSizeBytes 且无可用 stream
    → 明确失败（与今天超限一致）
```

第一版 `order` 实际生效为 `["quic-v7", "inline-base64"]`。配置里允许写 `tcp-v1`，未通过阶段门槛前 manager **忽略**它的自动选择。诊断可用环境变量强制单 provider，不给模型第二工具。

并发：每目标设备 `maxConcurrentStreams` 默认 2，超额排队，不立刻失败。

## 5. 身份（所有 stream provider 共用）

tunnel session：

1. 删除用户可控的 `x-openclaw-a2a-source-device`；
2. 注入 `this.opts.deviceId`；
3. 校验 `target_device` 等于本机；
4. prepare / status / cancel 比较 header、offer.sourceDevice、已配置 peer。

这是 TCP-002 的正确修法，必须做在 **manager 控制口**，而不是每个 provider 各写一遍。没有这层，QUIC 和 TCP 会重复同一个未授权落盘洞。

无认证部署可留显式开关，不得标 production-ready。ticket、channel、路径不得进普通日志和 agent 原文。status 不向非参与 peer 暴露本地路径。

## 6. 状态机

```text
CREATED → PREPARING → READY → TRANSFERRING → COMMITTING
       → DATA_COMMITTED → NOTIFY_PENDING → COMPLETED

失败终态：FAILED_CONFIRMED | CANCELED | EXPIRED
恢复：INTERRUPTED（启动时，不得直接当可重传失败）
```

`DATA_COMMITTED`：字节已安全落盘。此后禁止再传该 transfer 的文件，只重试 FilePart 通知（及本机补偿注入）。

工具在 `enabled=true` 且走过 stream 时**追加**字段，不删现有字段：`transport`、`transferId`、`attemptId`、`dataCommitted`、`doNotRetry`、`errorCategory`。`enabled=false` 时返回与现在逐字段一致。

## 7. 代码边界

```text
a2a-plugin/src/file-transfer/
  types.ts              # TransportName、ErrorCategory、FileOffer、Record；稳定合同
  manager.ts            # 选择、降级、并发、通知；唯一总状态机
  transfer-store.ts     # 从 TCP 快照吸收原子 JSON / recover / URI resolve
  capability.ts         # metadata 解析与交集
  inline-provider.ts    # 包装现有 sendLocalFileCore
  quic-provider.ts      # 实现 FileTransferProvider
  quic-process-backend.ts
  tcp-provider.ts       # 实现 FileTransferProvider；默认不参与 auto 选择
  tcp-tls-backend.ts    # 从 file-transfer.ts 抽出的 TLS 收发
  uri.ts                # a2a-transfer:// 解析；executor 只依赖这里
  contract.test.ts      # 假 backend：成功 / AMBIGUOUS / 同名不覆盖 / 取消
```

吸收 TCP 快照时的拆法（可维护性关键）：

| 快照文件 | 去向 |
|---|---|
| `file-transfer-store.ts` | `transfer-store.ts` + `uri.ts`（泛化为任意 stream，不绑 TCP） |
| `file-transfer-types.ts` | 并入 `types.ts`，**补** version / attemptId / transport / expiresAt / ErrorCategory |
| `file-transfer.ts` 的 TLS 读写 | `tcp-tls-backend.ts` |
| `index.ts` 里的 prepare/send 编排 | 删掉，改走 manager |
| `server/file-relay.js` | 仍独立进程；不与 QUIC relay 合并 |
| executor 的 `a2a-transfer:` 分支 | 保留并改为调 `uri.ts`；QUIC 复用，禁止再写一套 |

Node 硬规则：stream 路径不得把文件字节读进 JS。`inspectFile` 的预哈希对大文件是 P2（TCP-019）；合同允许 provider 在 send 中流式哈希，但提交前必须有最终 SHA。

Helper：`spawn(..., { shell: false, env })`，`extraEnv` 可配 `LD_LIBRARY_PATH`。cancel / shutdown / timeout 杀进程组，不假设 HarmonyOS 有 cgroup。

## 8. 配置

```json
{
  "fileTransfer": {
    "enabled": false,
    "autoPeers": [],
    "order": ["quic-v7", "tcp-v1", "inline-base64"],
    "inlinePreferredBelowBytes": 1048576,
    "maxStreamBytes": 104857600,
    "maxConcurrentStreams": 2,
    "recordTtlHours": 72,
    "quic": { "enabled": true, "binary": "", "extraEnv": {}, "relayHost": "", "relayPort": 8008 },
    "tcp": { "enabled": false, "relayHost": "", "relayPort": 8001, "certificateSha256": "" }
  }
}
```

- `enabled: false`：发布默认；零行为变化。
- `tcp.enabled` 默认 false：代码可以在树里，Card 不宣告 `tcp-v1`。
- 禁止配置「任何错误都 fallback」。
- schema 容忍未知 provider 块。

威胁模型必须写进运维说明：ticket 防未授权加入 channel；若 relay 终结 TLS/QUIC，**中继可见文件字节**；未做证书 pin 与 prepare 认证前不得称 production-ready。

## 9. 扩展规则（避免五年后推翻）

加一个新数据面时，只允许：

1. 新 `TransportName` 字符串；
2. 一个新 `*-provider.ts` + 可选 backend；
3. capability `transports` 多一个名字；
4. 同一套 contract test 必须通过。

不允许：

- 新的 agent 工具；
- 新的落盘目录或新的 URI scheme（除非 control version +1，且旧 scheme 仍解析）；
- provider 内部重试其它 provider；
- 把 stream 成功改成「ACK 到了就算」或「agent 看到了就算」；
- 修改 `DATA_COMMITTED` 含义。

control `version: 2` 仅在 offer 形状不兼容时才升。字段只能追加。`attemptId` 因此必须从 v1 就存在。

## 10. 实施阶段

### A — 合同骨架（零行为变化）

- types / store / manager / capability / uri / InlineProvider。
- executor 接入 `a2a-transfer:` 特判，但 `enabled=false` 时无此类消息。
- tunnel 注入可信 source（即使本阶段还没有 stream，避免 TCP/QUIC 各自再补洞）。
- `enabled=false` 现有测试全绿。

门槛：新旧 inline 四组合无回归。

### B — QUIC 填满合同

- QuicProvider + process backend；helper JSONL + no-clobber。
- `autoPeers` 灰度；完成后发 `a2a-transfer://`。
- contract test + 真机双向 0 B / 1 B / 10 MiB / 100 MiB。
- PC 无 RCP：交集无 `quic-v7`，≤50 MiB 走 inline，更大则明确失败。

门槛：RSS 不随文件变大；旧 peer 仍 inline。本阶段 TCP **不**自动选择。

### C — 把 TCP 快照迁进合同

- 抽出 TcpProvider / TcpTlsBackend；relay 保持独立进程。
- 补 attemptId、ErrorCategory、统一目录、prepare 走同一认证。
- 同一 contract test 必须绿。
- `tcp.enabled` 仍默认 false。双设备矩阵（含 ACK 丢失、断连、同名并发）通过前，不得加入 auto `order`。

门槛：故意关 QUIC 后，仅当显式打开 TCP 才走 TCP；中途断网不重复提交。

### D — 受控生产

证书 pin、ticket 生命周期、限流、安装包校验 helper/relay 哈希、升级回滚演练。`enabled: true` 仍不是全员默认。

1 GiB、P2P、续传、长驻 helper：仍是演进边界，用第 9 节规则加，不改 v1 成功语义。

## 11. 验收（合同相关必过）

除既有功能/故障/性能矩阵外，增加**可维护性门禁**：

- 用假 provider 跑 contract test：成功、AMBIGUOUS 不重传、同名不覆盖、cancel、INTERRUPTED 恢复。
- 同一 transferId 换 attemptId：旧 attempt 未提交才允许新 prepare。
- `a2a-transfer://` 对 QUIC 与 TCP 走同一 `uri.ts`；未知/未提交 URI 不得 fetch。
- Card 含未知 transport 名时插件仍启动。
- `enabled=false` 时 Card、工具返回、控制口均与当前版本一致。

## 12. 最终取舍

接受：

1. 第一版自动路径仍可能是 QUIC 或 inline；混合设备 >50 MiB 在 TCP 未达标前会明确失败。
2. 代码树里会出现尚未默认打开的 `tcp-provider.ts`——这是有意的，避免第二套栈。
3. 要改 executor 为 `a2a-transfer:` 开洞；这是一次性成本，换来所有 stream 共用通知。
4. 第一版不做续传；未发字节且未超 inline 上限才允许换 provider。

不接受：

1. QUIC 一套状态、TCP 再一套状态。
2. 无 attemptId 就上自动降级。
3. 用本地注入代替 A2A FilePart 作为主成功路径。
4. 为了少改而把可扩展合同推迟到「以后重构」。

这样既保住上一版的兼容与发布纪律，又让 TCP 快照、QUIC v7 和现有 inline 收敛成一条可维护的演进线。
