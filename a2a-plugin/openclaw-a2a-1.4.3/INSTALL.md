# Openclaw-A2A 安装包说明

> **包名**：`openclaw-a2a`  
> **版本**：`1.4.3`  
> **插件 ID**：`a2a-gateway`（配置、启停、日志一律用这个 ID）  
> **安装包文件**：`openclaw-a2a-1.4.3.tgz`  
> **鸿蒙安装方式**：**手工覆盖 bundled**（不使用安装脚本）

本文说明：**如何用本安装包安装**、**有哪些功能**、**怎么配**、**典型用例怎么跑**。更长的逐步手册见仓库内 `docs/操作手册.md`（不在 tgz 内）。

---

## 1. 安装包是什么

`npm pack` 生成的 `.tgz`，解压后是一份可被 OpenClaw 加载的插件源码（TypeScript 入口 `index.ts`），主要包含：

| 内容 | 作用 |
|------|------|
| `index.ts` / `openclaw.plugin.json` | 插件入口与配置 schema |
| `src/**` | A2A、隧道、注册中心、文件安全等实现 |
| `skill/**` | Agent Skill 与辅助脚本 |
| `package.json` | 依赖声明（安装后需 `npm install --omit=dev`） |
| `INSTALL.md` | 本文 |

**不包含**：单元测试、完整操作手册、开发用 CLI。

### 1.1 两条安装路线（先选对）

| 环境 | 推荐装法 | 真正生效的目录 |
|------|----------|----------------|
| 普通电脑上的 OpenClaw（`openclaw plugins install`） | **路线 A** | OpenClaw 自己的 extensions 安装目录 |
| HarmonyOS / 定制 OpenClaw（设备上已内置 bundled 插件） | **路线 B** | **只覆盖 bundled**：`…/openclaw/extensions/a2a-gateway/` |

定制 OpenClaw 会**优先加载 npm 包内的 bundled 插件**。若同时存在 `.openclaw/extensions`、`workspace/plugins` 等多份同 ID 插件，后加载的会被覆盖，聊天里仍可能是旧代码。  
因此设备升级时：**只保留并更新 bundled 这一份**，其余副本改名禁用。

---

## 2. 路线 A — 普通电脑（次要）（OpenClaw CLI）

### 2.1 前置条件

- Node.js **22+**
- 已安装并能启动 OpenClaw Gateway：`openclaw gateway status`

### 2.2 安装步骤

```bash
# 1) 进入放着 tgz 的目录
cd /path/to/release

# 2) 用 OpenClaw 安装本包（路径换成实际 tgz）
openclaw plugins install ./openclaw-a2a-1.4.3.tgz

# 3) 允许并启用
openclaw config set plugins.allow '["a2a-gateway"]'
openclaw config set plugins.entries.a2a-gateway.enabled true

# 若 allow 里还有其它插件，把它们一并写进数组，不要只留 a2a-gateway 而把别人踢掉

# 4) 重启
openclaw gateway restart

# 5) 确认
openclaw plugins list
curl -s http://127.0.0.1:18800/.well-known/agent-card.json
```

**成功标志：**

- `plugins list` 中有启用的 `a2a-gateway`
- curl 返回含 `name` / `protocolVersion` 的 Agent Card JSON
- 日志出现：`a2a-gateway: HTTP listening`、以及（若开了注册中心工具）`a2a.registry.register` / `a2a.registry.list`

### 2.3 从源码目录安装（开发机）

```bash
cd /path/to/Openclaw-A2A
npm install
openclaw plugins install .
openclaw gateway restart
```

---

## 3. 路线 B — 鸿蒙设备（主路径：手工覆盖 bundled）

适用：手机 / PC 上 OpenClaw 自带  
`/data/local/npm/lib/node_modules/openclaw/extensions/a2a-gateway`。

**不要用安装脚本**；用 `hdc` 推送 + 设备上解压覆盖即可。  
插件在配置里一般已是 `enabled: true`，随 Gateway **默认启动**；装完重启即可。

目标目录（唯一应保留的生效副本）：

```text
/data/local/npm/lib/node_modules/openclaw/extensions/a2a-gateway
```

### 3.1 在 Windows 开发机上操作

把 `<SERIAL>` 换成 `hdc list targets` 里的序列号；发布目录示例：`D:\openclaw\Openclaw-A2A\openclaw-a2a-1.4.3`。

```powershell
$hdc = "C:\Users\1\tools\hdc\hdc.exe"   # 按本机 hdc 路径修改
$serial = "<SERIAL>"
$tgz = "D:\openclaw\Openclaw-A2A\openclaw-a2a-1.4.3\openclaw-a2a-1.4.3.tgz"
$bundled = "/data/local/npm/lib/node_modules/openclaw/extensions/a2a-gateway"

# 1) 推送安装包
& $hdc -t $serial file send $tgz /data/local/tmp/openclaw-a2a-1.4.3.tgz

# 2) 在设备上解压到临时目录，再覆盖 bundled 关键文件
& $hdc -t $serial shell @"
set -e
TGZ=/data/local/tmp/openclaw-a2a-1.4.3.tgz
BUNDLED=$bundled
STAGE=/data/local/tmp/a2a-unpack
rm -rf `$STAGE
mkdir -p `$STAGE
tar -xzf `$TGZ -C `$STAGE
PKG=`$(find `$STAGE -maxdepth 2 -type f -name package.json | head -n 1)
PKG_DIR=`$(dirname `$PKG)
mkdir -p `$BUNDLED/src
cp -f `$PKG_DIR/index.ts `$BUNDLED/index.ts
cp -f `$PKG_DIR/package.json `$BUNDLED/package.json
cp -f `$PKG_DIR/openclaw.plugin.json `$BUNDLED/openclaw.plugin.json
rm -rf `$BUNDLED/src
cp -R `$PKG_DIR/src `$BUNDLED/src
if [ -d `$PKG_DIR/skill ]; then rm -rf `$BUNDLED/skill; cp -R `$PKG_DIR/skill `$BUNDLED/skill; fi
# 禁用其它同名副本，避免加载旧代码
[ -d /data/local/.openclaw/extensions/a2a-gateway ] && mv /data/local/.openclaw/extensions/a2a-gateway /data/local/.openclaw/extensions/a2a-gateway.disabled
[ -d /data/local/.openclaw/workspace/plugins/a2a-gateway ] && mv /data/local/.openclaw/workspace/plugins/a2a-gateway /data/local/.openclaw/workspace/plugins/a2a-gateway.disabled
[ -d /data/local/tools/openclaw-a2a-gateway-tunnel ] && mv /data/local/tools/openclaw-a2a-gateway-tunnel /data/local/tools/openclaw-a2a-gateway-tunnel.disabled
rm -rf `$STAGE
echo OK
"@

# 3) 重启 OpenClaw
& $hdc -t $serial shell "sh /data/local/tmp/start-openclaw.sh"
```

若设备上已有可用的 `node_modules`，一般**不必**再跑 `npm install`。若启动报缺依赖，再进 `$bundled` 执行一次 `npm install --omit=dev`。

### 3.2 成功标志

重启日志中应看到：

- `a2a-gateway: registered gateway method a2a.registry.register`
- `a2a-gateway: registered gateway method a2a.registry.list`
- **没有** `duplicate plugin id … a2a-gateway`

### 3.3 回滚

把 `*.disabled` 改回原名，或从备份还原 bundled，再执行 `start-openclaw.sh`。

---

## 4. 功能特性一览

| 能力 | 默认 | 说明 |
|------|------|------|
| A2A HTTP Gateway | 开（插件启用即听） | 默认 `127.0.0.1:18800`，提供 Agent Card、任务、消息 |
| 静态 peers 直连 | 配了 peers 且无 tunnelDeviceId | 局域网 / Tailscale 可达时用 |
| 嵌入式 Tunnel | `tunnel.enabled=false` | 跨 NAT 经云端中继 WebSocket 转发 |
| 注册中心通讯录 | `registry.enabled=false` | HTTP 注册/发现；**流量仍走 Tunnel 或直连** |
| 聊天手动注册/列举 | 工具随插件注册 | `a2a_registry_register` / `a2a_registry_list` |
| 本地文件收发 | 开 | 默认单文件约 50MB；可配落盘目录 |
| 路由规则 / 健康检查等 | 可选 | 见 `openclaw.plugin.json` schema |

---

## 5. 配置位置与写法

配置挂在 OpenClaw：

```text
plugins.entries.a2a-gateway.config
```

设备上常见文件：`/data/local/.openclaw/openclaw.json`。

最小可用（只起本地 Gateway，不开隧道）：

```json
{
  "server": { "host": "127.0.0.1", "port": 18800 },
  "agentCard": {
    "name": "My-Agent",
    "skills": ["chat"]
  },
  "security": {
    "inboundAuth": "bearer",
    "token": "改成自己的令牌"
  }
}
```

---

## 6. 关键配置项说明

### 6.1 `server` / `agentCard` / `security`

| 字段 | 含义 | 建议 |
|------|------|------|
| `server.host` / `port` | 本机 A2A HTTP 监听 | 设备上常用 `127.0.0.1:18800`（经隧道入站） |
| `agentCard.name` | 对外展示名 | 与设备角色一致，便于列表辨认 |
| `security.inboundAuth` | `none` / `bearer` | 生产用 `bearer` |
| `security.token` | 对端访问本机时要带的令牌 | 与对端 `peers[].auth.token` / `registry.defaultPeerAuth` 对齐 |

### 6.2 `tunnel`（跨 NAT）

| 字段 | 必填（开启时） | 说明 |
|------|----------------|------|
| `enabled` | — | `true` 才连中继 |
| `relayUrl` | 是 | 必须 `ws://` 或 `wss://`，例如 `ws://121.37.53.35:8001` |
| `deviceId` | 是 | 本机在中继上的唯一 ID（如 `HW-Phone1`） |
| `requestTimeoutMs` | 否 | 大文件 / 慢模型可加大（如 `1200000`） |

**解释：** Tunnel 只解决「两端不能直连 IP」；对端身份用 `deviceId`。发消息时 peer 上要有对应的 `tunnelDeviceId`。

### 6.3 `peers[]`（静态通讯录）

| 字段 | 说明 |
|------|------|
| `name` | 发送时用的逻辑名（`a2a.send` 的 peer） |
| `agentCardUrl` | Card URL；隧道模式下常写本机 path 形式即可 |
| `tunnelDeviceId` | 有则走中继；无则直连 |
| `auth` | 访问对端时的鉴权 |

### 6.4 `registry`（云端通讯录）

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | `false` | 总开关 |
| `baseUrl` | — | 如 `http://121.37.53.35:8000` |
| `dataset` | `openclaw_devices` | 命名空间；聊天工具也固定用配置值 |
| `serviceId` | 同 `tunnel.deviceId` | 中心里的本机 ID |
| `registerOnStart` | `true` | 启动时 POST 本机 Agent Card |
| `discoverIntervalMs` | `30000` | 周期拉列表写入内部 peers（**会跳过自己**） |
| `mergeWithStatic` | `true` | 与静态 peers 合并；同名静态优先 |
| `defaultPeerAuth` | — | 发现出的对端默认鉴权（peers 为空时很重要） |

**解释：**

- 注册中心 = **通讯录**，不是消息通道。  
- 远场发消息仍依赖 Tunnel（或直连）。  
- 聊天「列举设备」会返回**含本机**的完整列表，并按「本机优先 → serviceId 升序」排序。

### 6.5 `fileStorage`

| 字段 | 说明 |
|------|------|
| `tempDir` | 收到的 inline 文件落盘目录；文件名保留 basename，重名变 `name (1).ext` |

HarmonyOS 示例（以设备上真实可写路径为准，先用 `hdc shell ls`/`touch` 验证）：

- Phone：`/storage/media/100/local/files/Docs/OPENCLAW`
- PC：以现场可写路径为准

---

## 7. 用例（带解释）

### 用例 1 — 单机自检：插件是否装对

**目的：** 确认安装包生效，不依赖对端。

1. 安装并重启（路线 A 或 B）。  
2. 查 Card：`curl -s http://127.0.0.1:18800/.well-known/agent-card.json`  
3. 看日志是否有 `HTTP listening` 与 `a2a.registry.list`（方法注册，不要求已开 registry）。

**解释：** 这一步只验证「插件进程起来了」。隧道/注册中心都还没必要开。

---

### 用例 2 — 两台局域网直连互发

**目的：** 同一网段、能互相访问 `:18800`。

**设备 A 配置要点：**

```json
{
  "agentCard": { "name": "Agent-A" },
  "security": { "inboundAuth": "bearer", "token": "token-a" },
  "peers": [
    {
      "name": "Agent-B",
      "agentCardUrl": "http://<B的IP>:18800/.well-known/agent-card.json",
      "auth": { "type": "bearer", "token": "token-b" }
    }
  ]
}
```

设备 B 对称配置（peers 指向 A，token 互换）。

**验证：**

```bash
openclaw gateway call a2a.send --params '{"peer":"Agent-B","message":{"text":"hello from A"}}'
```

**解释：** 无 `tunnelDeviceId` → HTTP/JSON-RPC 直连。令牌必须「访问谁就用谁的 inbound token」。

---

### 用例 3 — 跨 NAT：Tunnel + 静态 peers

**目的：** 两边都在 NAT 后，不能直连。

**前置：** 云端中继已启动（WebSocket 端口，例如 `:8001`），两边都能连上。

**设备 A：**

```json
{
  "tunnel": {
    "enabled": true,
    "relayUrl": "ws://121.37.53.35:8001",
    "deviceId": "HW-PC1"
  },
  "peers": [
    {
      "name": "HW-Phone1",
      "tunnelDeviceId": "HW-Phone1",
      "agentCardUrl": "http://127.0.0.1:18800/.well-known/agent-card.json",
      "auth": { "type": "bearer", "token": "12345678" }
    }
  ],
  "security": { "inboundAuth": "bearer", "token": "12345678" }
}
```

**设备 B：** `deviceId`/`peers` 对调。

**成功日志：** `a2a-tunnel: connected as HW-PC1`（文案以实际为准）。  
**验证：** `a2a.send`，peer 名为对端 `name`。

**解释：** 中继按 `deviceId` 转发；`peers[].tunnelDeviceId` 必须等于对端的 `tunnel.deviceId`。

---

### 用例 4 — Tunnel + 注册中心自动发现（少写 peers）

**目的：** 通讯录自动维护，少改静态 peers。

两端增加：

```json
{
  "registry": {
    "enabled": true,
    "baseUrl": "http://121.37.53.35:8000",
    "dataset": "openclaw_devices",
    "serviceId": "HW-Phone1",
    "registerOnStart": true,
    "discoverIntervalMs": 15000,
    "mergeWithStatic": true,
    "defaultPeerAuth": { "type": "bearer", "token": "12345678" }
  },
  "peers": []
}
```

**行为：**

1. 启动 → POST 本机 Card 到中心  
2. 周期 GET → 把**他人**写成内部 peers（跳过自己）  
3. `a2a.send` 的 peer 名 = 对端 `serviceId`

**探活中心：**

```bash
curl -s http://121.37.53.35:8000/api/warmup-status
```

**解释：** `defaultPeerAuth` 在 `peers` 为空时决定访问对端用的令牌；两端 `security.token` 与之一致最省事。中心磁盘满会导致注册 500，需先保证中心可写。

---

### 用例 5 — 聊天窗口：注册 / 列举设备

**目的：** 人工触发通讯录操作，或演示/排障。

在 OpenClaw 聊天中说类似意图（具体措辞随 Agent Skill）：

- 「把我注册到注册中心」→ 工具 `a2a_registry_register`  
- 「列出已注册设备」→ 工具 `a2a_registry_list`

或 CLI：

```bash
openclaw gateway call a2a.registry.register --timeout 60000 --params '{}'
openclaw gateway call a2a.registry.list --timeout 60000 --params '{}'
```

**列表含义：**

| 字段 | 含义 |
|------|------|
| `serviceId` | 中心 ID，发送时常用作 peer 名 |
| `tunnelDeviceId` | 中继设备 ID（通常与 serviceId 相同） |
| `isSelf` | 是否本机 |
| AgentCard.* | 对端展示名、描述、skills 等 |

**解释：** dataset 固定用配置，不由聊天传入。列表含本机；自动 discover 仍跳过本机以免自己发给自己。

---

### 用例 6 — 发本地小文件

**目的：** 验证 FilePart / 落盘。

1. 两端配置可写 `fileStorage.tempDir`（可选）。  
2. 使用 `a2a.send` / `a2a.send_local_file`（以已注册 gateway 方法为准）发送文件。  
3. 在对端 `tempDir` 下看到**原始文件名**（重名则 `name (1).ext`）。

**解释：** 默认有大小上限（约 50MB）；过大需改 `security.maxFileSizeBytes` 等并确认中继/超时足够。

---

## 8. 验收清单（安装包专用）

- [ ] tgz 已按路线 A 或 B 安装  
- [ ] 重启后无 duplicate `a2a-gateway` 警告（设备路线 B）  
- [ ] 日志有 `a2a.registry.register` / `a2a.registry.list` 方法注册  
- [ ] Card URL 可 curl  
- [ ] （可选）Tunnel：`connected`  
- [ ] （可选）Registry：中心 list 能看到本机 `serviceId`  
- [ ] （可选）聊天列举：本机排第一，字段完整  

---

## 9. 常见问题

| 现象 | 原因与处理 |
|------|------------|
| 装了新包聊天仍像旧版 | 设备加载了另一份副本 → 按路线 B 只留 bundled，禁用其它 |
| `plugin not found: a2a-gateway` | 生效目录被移走/改名，或 `load.paths` 指向空目录 → 恢复 bundled |
| `plugin id mismatch … entry hints "openclaw-a2a"` | 包名与插件 ID 不同引起的提示，一般仍可加载；以 ID `a2a-gateway` 为准 |
| Tunnel connection timeout | 中继地址/端口/安全组；本机出网；`relayUrl` 必须是 ws/wss |
| Registry 500 / 注册失败 | 中心磁盘或权限；先 `warmup-status` 与中心日志 |
| send 报 Device not found | 通讯录有、中继无 → 对端 Tunnel 未连上 |

---

## 10. 版本与重新打包

在源码仓库根目录：

```bash
npm pack
# 生成 openclaw-a2a-1.4.3.tgz
```

升级设备时用**新 tgz** 再按第 3 章手工覆盖 bundled 并重启即可。

---

## 11. License

MIT（见包内 `LICENSE`）。

