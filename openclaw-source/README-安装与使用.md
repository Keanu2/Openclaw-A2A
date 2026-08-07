# 定制版 OpenClaw 安装说明

内置 **A2A**（消息/文件 + 隧道 + 注册中心）。安装包：`openclaw-2026.3.13.tgz`（约 29MB）。  
命令用 `sh`/`bash`，不要用 PowerShell。

## 你要做什么（装包不会自动配好）

1. 安装 tgz  
2. 设置环境变量（鸿蒙必做）  
3. 写 `openclaw.json`（含隧道、注册中心）  
4. 配 `workspace`（至少 MEMORY / TOOLS）  
5. 启动 Gateway  

不要再 `plugins install` 外挂 a2a，也不要写 `plugins.load.paths` 指向 `/workspace/plugins/a2a-gateway`。

---

## 1. 环境变量（鸿蒙）

每次新开终端先执行，或写进 `start-openclaw.sh`：

```bash
export PATH="/usr/local/npm/bin:/usr/local/bin:/data/local/npm/bin:/data/local/tools/node-v24.2.0-openharmony-arm64/bin:$PATH"
export HOME=/data/local
export OPENCLAW_HOME=/data/local
export OPENCLAW_STATE_DIR=/data/local/.openclaw
export OPENCLAW_CONFIG_PATH=/data/local/.openclaw/openclaw.json
```

| 变量 | 值 | 注意 |
|------|-----|------|
| `HOME` | `/data/local` | **不要**设成 `/data/local/.openclaw`（会多出一层嵌套目录） |
| `OPENCLAW_STATE_DIR` | `/data/local/.openclaw` | 数据目录 |
| `OPENCLAW_CONFIG_PATH` | `.../openclaw.json` | 主配置 |

macOS / Termux 一般用默认 `~/.openclaw/`，可不设上面几项；只需保证 `PATH` 里有 `openclaw`。

---

## 2. 安装

```bash
# 推到设备（开发机）
hdc file send openclaw-2026.3.13.tgz /data/local/tmp/openclaw-2026.3.13.tgz

# 设备上（先做第 1 节）
npm install -g --omit=dev /data/local/tmp/openclaw-2026.3.13.tgz
openclaw plugins list    # 应看到 A2A Gateway = loaded
```

若以前装过外挂插件，清一次：

```bash
openclaw config set plugins.load.paths '[]'
```

---

## 3. 写 openclaw.json（含注册中心）

路径：`/data/local/.openclaw/openclaw.json`  
**注册中心不会默认配置**，必须写在这里。

现网地址（可改成你的）：

| 服务 | 地址 |
|------|------|
| 隧道 | `ws://121.37.53.35:8001` |
| 注册中心 | `http://121.37.53.35:8000`，dataset=`openclaw_devices` |

### 电脑 HW-PC1 模板

把 `中继公网IP`、令牌改成你的；已有模型配置请合并保留，不要整文件覆盖丢模型。

```json
{
  "agents": {
    "defaults": {
      "workspace": "/data/local/.openclaw/workspace",
      "timeoutSeconds": 1200,
      "userTimezone": "Asia/Shanghai"
    }
  },
  "gateway": {
    "port": 18789,
    "mode": "local",
    "auth": { "mode": "token", "token": "请改成网关令牌" }
  },
  "plugins": {
    "entries": {
      "a2a-gateway": {
        "enabled": true,
        "config": {
          "server": { "host": "127.0.0.1", "port": 18800 },
          "agentCard": { "name": "HW-PC1-Agent1", "skills": ["chat"] },
          "tunnel": {
            "enabled": true,
            "relayUrl": "ws://中继公网IP:8001",
            "deviceId": "HW-PC1",
            "requestTimeoutMs": 1200000
          },
          "security": {
            "inboundAuth": "bearer",
            "token": "双方约定的同一令牌",
            "maxFileSizeBytes": 52428800,
            "maxInlineFileSizeBytes": 52428800
          },
          "storage": { "tasksDir": "/data/local/.openclaw/a2a-tasks" },
          "observability": { "auditLogPath": "/data/local/.openclaw/a2a-audit.jsonl" },
          "timeouts": { "agentResponseTimeoutMs": 1200000 },
          "registry": {
            "enabled": true,
            "baseUrl": "http://中继公网IP:8000",
            "dataset": "openclaw_devices",
            "serviceId": "HW-PC1",
            "registerOnStart": true,
            "discoverIntervalMs": 15000,
            "mergeWithStatic": true,
            "defaultPeerAuth": { "type": "bearer", "token": "双方约定的同一令牌" }
          },
          "fileStorage": {
            "tempDir": "/storage/cloud/100/files/Docs/Download/OPENCLAW"
          },
          "peers": []
        }
      }
    }
  }
}
```

### 手机只改这些

| 字段 | 电脑 | 手机 |
|------|------|------|
| `tunnel.deviceId` / `registry.serviceId` | `HW-PC1` | `HW-Phone1` |
| `agentCard.name` | `HW-PC1-Agent1` | `HW-Phone1-Agent1` |
| `fileStorage.tempDir` | `.../Download/OPENCLAW` | `/storage/media/100/local/files/Docs/OPENCLAW` |
| A2A `security.token` | 两端相同 | 两端相同 |
| `gateway.auth.token` | 本机自用，可不同 | 本机自用，可不同 |

---

## 4. 配 workspace

装包**不含**设备专属 workspace。出于安全考虑，带设备名称、路径和 Agent
记忆的本地 `harmony-workspace/` 不上传 GitHub。请分别为电脑和手机创建 workspace，
再拷到设备 `/data/local/.openclaw/workspace/`。主要配置：

- `MEMORY.md`：本机名、对端名、路径  
- `TOOLS.md`：怎么发消息/文件  

手机和电脑不要互相覆盖。

---

## 5. 启动与自检

```bash
# 鸿蒙推荐
openclaw gateway run --force --port 18789

# 或
sh /data/local/tmp/start-openclaw.sh
```

日志里应有：隧道已连接、registry 已注册、`HTTP listening` 在 18800。

```bash
export GATEWAY_TOKEN="你的网关令牌"
openclaw gateway call a2a.registry.list --token "$GATEWAY_TOKEN" --timeout 60000 --json
openclaw gateway call a2a.send --token "$GATEWAY_TOKEN" --timeout 300000 \
  --params '{"peer":"HW-Phone1","message":{"text":"你好"}}'
```

`list` 能看到两端；发文件用 `a2a.send_local_file` / 工具 `a2a_send_local_file`，`path` 用绝对路径。

---

## 常见问题

| 现象 | 处理 |
|------|------|
| `a2a-gateway not found` / 旧路径 | `openclaw config set plugins.load.paths '[]'` 后重启 |
| `openclaw: not found` | 检查 `PATH`（第 1 节） |
| `unauthorized` / token missing | `gateway call` 加 `--token` |
| 出现 `.openclaw/.openclaw` | `HOME` 设错了；改回 `/data/local`，可删内层 |
| Agent 乱说 SoftBus / 路径错 | workspace 没配或配错设备 |
| 对端 not found | 对端没上线，或 peer 名不是对方的 `serviceId` |

---

## 维护者：重新打包

```bash
# 同步 Openclaw-A2A → openclaw-custom/extensions/a2a-gateway/ 后：
cd /path/to/openclaw-custom
npm pack --ignore-scripts --pack-destination /path/to/output
```

得到 `openclaw-2026.3.13.tgz`。
