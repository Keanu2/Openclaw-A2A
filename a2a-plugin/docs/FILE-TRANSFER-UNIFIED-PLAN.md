# A2A 文件传输统一方案（客户端 + 服务器）

- 日期：2026-09-03
- 状态：**已实施（插件 1.6.0）**；边车侧仍只需核对 registry metadata / QUIC systemd
- 代码仓：`Keanu2/Openclaw-A2A-file-transfer`
- QUIC helper/中继仓：`Keanu2/a2a-raw-quic-stream`
- 边车示例：`121.37.53.35`
- 线协议兼容现网 1.5.x：prepare 路径、`tcp-v1` / `quic-v7` / `inline-base64`、`a2a-transfer://` 不改

选路、`mode`、工具合并都在**设备 gateway**上完成。服务器继续提供管子，不为 auto 增加第四个服务，也不把三种数据面合成一个进程。

---

## 0. 总览

```text
设备 A gateway                         边车                              设备 B gateway
──────────────                         ────                              ──────────────
Agent Card 宣告真实能力                                                 同样宣告
mode + 对端 Card 交集 → 选定一种

inline-base64  ──FilePart.bytes──►  TCP 8001 隧道  ──►  对端 gateway（旧世界共同语言）

tcp-v1         ──TLS+SNI────────►  TCP 8001 Nginx ──►  本机 19185 卸 TLS
                                   a2a-file.invalid        └── file-relay :19182

quic-v7        ──UDP────────────►  UDP 8008  quiche-raw-relay-v7

控制面始终：发现 / prepare / status / cancel / 完成后的小 FilePart
           走 TCP 8001 隧道（注册中心另见 :8000）
```

| 方式 | 谁发起 | 公网 | 边车进程 | 服务器要改线协议吗 |
|------|--------|------|----------|-------------------|
| 控制面 + base64 | 设备 gateway | TCP **8001** | Nginx → 隧道后端 `:18001` | 否 |
| tcp-v1 | 设备 gateway | TCP **8001**（SNI `a2a-file.invalid`） | Nginx → `:19185` TLS → `file-relay` `:19182` | 否 |
| quic-v7 | 设备 `rcp-raw-stream-v7` | UDP **8008** | `quiche-raw-relay-v7` | 否 |

base64 **不是**边车上的第四个进程。

**不要**把 QUIC 塞进 TCP 8001。最多将来 UDP 也用 8001 这个**端口号**（与 TCP 并存），现网没必要为方案改口。

---

## 1. 目标

1. 模型和 CLI 只面对一个「发本机文件」动作。
2. 字节怎么走：本机 `mode` + **对端 Agent Card 交集**，在开传前选定。
3. 旧客户端不升级、不配 `fileTransfer`，小文件仍能收发。
4. 已部署 1.5.x 流式设备与 Unified 可互传。
5. 结果不明时不换协议、不重复交付。
6. 边车协议保持 1.5.x；注册中心必须保住 Card `metadata`。

---

## 2. 三种运行时（只认 Card，不认安装包版本）

| 称呼 | 判定 | 能力 |
|------|------|------|
| **Legacy** | Card **没有** `metadata.openclawFileTransfer` | 只吃 `FilePart.bytes` 和公网 `https://`。无 prepare，不认 `a2a-transfer://`，不连 file-relay / QUIC |
| **Stream-1.5** | 有该块 `version: 1`，prepare 在现路径 | 按 `transports` 收；stream 完成后 `a2a-transfer://` |
| **Unified** | 同 1.5.x 线协议 + `mode` + 单一发送入口 | 发送按 Card 选路；接收同时接 stream 和旧 FilePart |

读不到对端 Card 或解析失败 → **当 Legacy**。

发送端**不扫对端磁盘**。对端有没有 helper = 其 Card 是否宣告 `quic-v7`。

---

## 3. 客户端

### 3.1 对外入口

只保留：

- 模型：`a2a_send_file(peer, path)` — 本机绝对路径
- CLI：`a2a.send_file` — 同样参数

调用方不传 `transport`（调试覆盖可隐藏，文档不写）。

一个发布周期内别名转到同一实现：`a2a_send_local_file`、`a2a.send_local_file`。  
旧 `uri=`（公网链接）仅兼容，不推荐给模型。不要再把 path 和 https URI 捆成一个智能工具。

### 3.2 用户配置（日常）

```json
"tunnel": {
  "enabled": true,
  "relayUrl": "ws://121.37.53.35:8001",
  "deviceId": "<本机设备 ID>"
},
"fileTransfer": {
  "enabled": true,
  "mode": "auto",
  "host": "121.37.53.35",
  "certificateSha256": "<TCP 证书 DER 的 SHA-256>",
  "quic": {
    "binary": "/data/local/tmp/a2a-rcp/rcp-raw-stream-v7"
  }
}
```

peer 仍需 `tunnelDeviceId`。`receiveDir` 可省略，默认数据目录 `a2a-files`。

| 字段 | 何时需要 |
|------|----------|
| `enabled` | 要提供 stream 收/发时 |
| `mode` | `auto` \| `quic` \| `tcp` \| `base64`，默认 `auto` |
| `host` | 走 tcp/quic 时；QUIC 与 TCP 共用，不填第二份 IP |
| `certificateSha256` | 走 TCP 时强烈建议 |
| `quic.binary` | 要用 QUIC；**文件存在且可执行才在 Card 写 `quic-v7`** |

代码默认、用户不必写：`port=8001`，`serverName=a2a-file.invalid`，`quic.relayPort=8008`，`quic.relayHost=host`，`maxFileSizeBytes=1GiB`，`inlinePreferredBelowBytes=1MiB`，连接/传输/stall 超时，并发与 in-flight 上限。

**不再当产品配置：** `quic.enabled`、`order`、`autoPeers`（与 mode+Card 重复）。

`mode` 只约束本机**发送**。对端用 QUIC 发来，只要本机宣告了且 helper 在，就要能收。  
收 Legacy 的 `FilePart.bytes` **不依赖** `fileTransfer.enabled`。

### 3.3 Agent Card（本机宣告真实能力）

```json
"openclawFileTransfer": {
  "version": 1,
  "control": "tunnel",
  "transports": ["quic-v7", "tcp-v1", "inline-base64"],
  "maxStreamBytes": 1073741824,
  "maxInlineBytes": 52428800
}
```

- 缺整个块 = Legacy；发送端只假设 `inline-base64`，inline 上限按 50MiB 保守估计。
- `version`：这块 JSON 的格式。`tcp-v1` / `quic-v7` / `inline-base64`：数据面协议版本。换线协议加新名，旧名保留到对端升级。
- 未知 transport 忽略，不启动失败。
- 无 TCP 中继配置 → 不写 `tcp-v1`。无 helper → 不写 `quic-v7`。
- `maxInlineBytes` = `security.maxInlineFileSizeBytes`。
- 不写进 `additionalInterfaces`。

Card 过期（卸了 helper 仍宣告 quic）：以 prepare 在**发字节前**失败为准，再改选下一个。

### 3.4 交集

```text
local:
  永远 + inline-base64
  enabled 且 TCP 配好 → + tcp-v1
  binary 存在可执行 → + quic-v7

remote:
  无块 → [inline-base64]
  有块 → 只保留本端认识的名字

available = 交集
```

### 3.5 `mode` 与 auto

| `mode` | 行为 |
|--------|------|
| `quic` | 只要 `quic-v7` ∈ available，否则失败（不对 Legacy 打 prepare） |
| `tcp` | 只要 `tcp-v1` ∈ available，否则失败 |
| `base64` | 只要 inline；超过双方 `maxInlineBytes` 则失败 |
| `auto` | 开传前选定一种，传起来不再换 |

**auto（Card 先行，不是失败接力）：**

```text
1. 取 available
2. size ≤ 1MiB（inlinePreferredBelowBytes）→ inline-base64（小图不开中继）
3. 否则按顺序取 available 第一个：quic-v7 → tcp-v1 → inline-base64
   落到 inline 仍须 ≤ maxInlineBytes，否则失败（旧端+大文件禁止灌隧道）
4. 选中的 stream：prepare/握手在发 payload 前 404/UNSUPPORTED
   → cancel，新 transferId，试下一个（仅此类）
5. 已发第一个文件字节，或 DATA_COMMITTED / COMMITTING / AMBIGUOUS
   → 锁定。已提交只补通知；说不清则停，禁止换协议重发
```

合理说法：auto **优先选** QUIC；Card 显示不会再用 TCP；两种流都不会且文件够小才 base64。  
不合理：QUIC **传失败了**再拿 TCP 重传。

### 3.6 线协议（设备 ↔ 设备 / 设备 ↔ 中继）

控制路径保持 1.5.x（不要改成新 `/v1/` URL）：

```text
POST /a2a/file-transfer/prepare
POST /a2a/file-transfer/status
POST /a2a/file-transfer/cancel
```

**Inline**

```json
{ "kind": "file", "file": { "name": "a.jpg", "mimeType": "image/jpeg", "bytes": "<base64>" } }
```

**Stream**（双方 Card 都有对应 transport）

1. 隧道 prepare（`transferId`、`attemptId`、`transport`、`ticket`、size、sha256…）
2. `tcp-v1`：TLS 连 `host:8001`，SNI=`serverName`；`quic-v7`：spawn helper 连 UDP `host:8008`
3. 收端 `DATA_COMMITTED` 后发端再发 `uri: a2a-transfer://<transferId>`
4. `a2a-transfer:` 禁止当网络 URL fetch，只查本机 store。Legacy 不应收到这种 URI

落盘、no-clobber、`COMMITTING` 歧义、prepare 与恢复屏障：沿用 1.5.2。

设备还需要：QUIC 时本机有 `rcp-raw-stream-v7`；TCP 时能出网 8001 并校验证书钉扎。

---

## 4. 服务器 / 边车

### 4.1 要跑的进程（不是「auto 再加一个」）

| systemd / 进程 | 作用 | 现网 |
|----------------|------|------|
| `a2a-edge-nginx` | 公网 TCP 8001 分流 | 应常驻 |
| 隧道后端 | 本机 `:18001`，A2A WebSocket | 应常驻 |
| `a2a-file-relay` | 本机 `:19182`，TCP 文件配对转发 | 应常驻 |
| `quiche-raw-relay-v7` | UDP 8008 | 应常驻（现网曾出现进程在听但 unit inactive，需 `enable --now`） |
| `a2x-registry` | TCP 8000，通讯录 / Agent Card | 应常驻 |

auto **不**在服务器上选路，也不新增端口。

### 4.2 Nginx SNI 是什么（TCP 8001 一分为二）

公网只有一个 TCP 8001，但上面有两种流量：

1. 控制面：`ws://host:8001` 明文 WebSocket（隧道、prepare、base64）
2. TCP 文件：客户端用 **TLS**，并在握手里带 SNI=`a2a-file.invalid`

`a2a-file.invalid` **不是网站、不用 DNS**，只是 TLS 贴纸。插件 `fileTransfer.serverName` 默认就是它。

```text
listen 8001;  ssl_preread on;

SNI == a2a-file.invalid  →  127.0.0.1:19185（这里卸 TLS）→ file-relay :19182
其它 / 无 SNI            →  127.0.0.1:18001（隧道）
```

### 4.3 数据面协议：这次不改

- `file-relay.js`：id + ticket 配对、状态机、资源上限（对齐已推的 1.5.2 即可，不是 Unified 新协议）
- `quiche-raw-relay-v7`：`a2a-stream/2`、现网启动参数保持
- 不为 auto 增加探测口；不把 QUIC 封进 TCP

若只想少开防火墙口：以后可让 QUIC 听 **UDP 8001**（与 TCP 8001 同号不同协议）。那是发布策略，第一版维持 UDP **8008**，以免 1.5.x 设备全断。

### 4.4 注册中心：这次要核对 / 必要时改

发送端靠 list/get 回来的 Card 判断对端会不会 `quic-v7` / `tcp-v1`。

**必须原样存、原样返回** `metadata.openclawFileTransfer`（以及 `tunnelDeviceId`）。丢掉的话，新设备会被当成 Legacy。

旧设备没有该字段 → 仍是合法 Card，按 Legacy 处理。

### 4.5 明确不用为 Unified 做的

- 不改 SNI 名字（除非所有客户端一起改）
- 不为旧客户端新开兼容端口（它们不连中继）
- 不在中继里解析 Agent Card
- 不在 QUIC 失败时由服务器改走 TCP

---

## 5. 互操作

| 发 | 收 | 行为 |
|----|----|------|
| Legacy | Unified | `FilePart.bytes`；Unified 不必 `enabled` 也能收 |
| Unified | Legacy | 无 Card 块 → 只 inline；大文件失败，不 prepare、不发 `a2a-transfer://`、不连 8008 |
| Unified `mode:tcp` | Legacy | 直接失败 |
| Unified auto | Stream-1.5 仅 tcp | 大文件 `tcp-v1`，现 prepare + 8001 SNI |
| Stream-1.5 `send_file` | Unified | 现网 TCP/QUIC 合同 |
| Stream-1.5 `send_local_file` | Unified | inline |
| Unified auto | Unified 无 helper | 无 quic → TCP 或小文件 inline |
| Unified auto | Unified 双方 quic | 大文件 `quic-v7` → UDP 8008 |
| Unified auto | 双方都会 quic，小文件 | 仍 inline |

---

## 6. 错误与重试

| 情况 | 结果 |
|------|------|
| Legacy + 超过 inline 上限 | `UNSUPPORTED`，对端需升级 |
| `mode: quic/tcp` 但交集没有 | 失败，不静默改 base64 |
| prepare 前明确不支持 | 未开始；auto 可换下一个 |
| 已 `DATA_COMMITTED`，通知失败 | 只补通知，`doNotRetry` |
| `COMMITTING` / 不明 | `AMBIGUOUS`，禁止换协议重传 |

---

## 7. 升级顺序

1. 边车：确认 file-relay 已是 1.5.2 语义；QUIC systemd 常驻；注册中心回传 metadata。
2. 先升设备**接收端**到 Unified：旧发送端无感。
3. 再升发送端：按 Card 选路；对面 Legacy 则 inline。
4. 同一发布周期保留旧工具名别名。
5. 现网 1.5.2 在代码落地前行为不变：`send_file` 默认 TCP，`send_local_file` 默认 base64。

---

## 8. 验收

**客户端**

| # | 场景 | 期望 |
|---|------|------|
| 1 | Legacy → Unified，小图 | bytes 成功 |
| 2 | Unified → Legacy，小图 | 自动 base64 |
| 3 | Unified → Legacy，100MiB | 失败，无 prepare |
| 4 | Unified `mode:tcp` → Legacy | 失败 |
| 5 | Unified auto → 1.5.x 仅 tcp，10MiB | `tcp-v1` |
| 6 | 1.5.x `send_file` → Unified | 与现网 TCP 相同 |
| 7 | Unified ↔ Unified，无 helper，10MiB | `tcp-v1` |
| 8 | Unified ↔ Unified，双方 quic，10MiB | `quic-v7` |
| 9 | auto + 小文件，双方都会 quic | 仍 inline |
| 10 | stream 成功、通知失败 | 不重传文件 |
| 11 | Card 拉失败，小文件 | 当 Legacy |
| 12 | Card 写了 quic，prepare 发字节前 404 | auto 改 TCP（若有） |

**服务器**

| # | 检查 |
|---|------|
| S1 | TCP 8001：无 SNI 的 WS 进隧道；SNI `a2a-file.invalid` 进 file-relay |
| S2 | UDP 8008 有 `quiche-raw-relay-v7`，且开机能起来 |
| S3 | 注册中心 get/list 的 Card 含完整 `openclawFileTransfer` |
| S4 | Legacy 设备注册仍成功（无该 metadata） |
| S5 | 中继不因 auto 增加新端口 |

---

## 9. 明确不做

- 不要求旧客户端加 JSON
- 不在 Ambiguous/已提交后换协议
- 不把三种中继合成一个进程，不为 auto 加第四个服务
- 不把 QUIC 封进 TCP 8001
- 不改 1.5.x prepare URL 与 `a2a-transfer://`（第一版）
- 不让用户同时填 `order`、`quic.enabled`、`autoPeers` 与 `mode`

---

## 10. 实施顺序

1. 边车核对：registry metadata、QUIC systemd、file-relay 版本。
2. 客户端 schema：`mode`；binary 存在才宣告 quic；`relayHost` 默认 `host`。
3. Card + `selectTransport` 接到唯一发送入口；旧方法做别名。
4. 第 8 节单测与真机矩阵。

实现完成前，现网 1.5.2 客户端行为保持不变。
