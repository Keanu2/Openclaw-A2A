# Openclaw-A2A

OpenClaw 的 **A2A Gateway** 插件（嵌入 Tunnel 版）：让两台设备上的 Agent 通过 A2A 互通，并在跨 NAT 时走云端中继转发。

| 项 | 值 |
|----|-----|
| 仓库目录 | `a2a-plugin` |
| npm 包名 | `openclaw-a2a` |
| 插件 ID | `a2a-gateway` |
| 当前版本 | `1.6.2` |

## 能做什么

- Agent ↔ Agent 消息与本地文件传输
- **文件数据面（1.6.x）**：`fileTransfer.mode` = `auto` \| `quic` \| `tcp` \| `base64`，与对端 Agent Card 交集选 `quic-v7` / `tcp-v1` / `inline-base64`
- 可选嵌入隧道客户端，跨 NAT 经中继互通
- 可选注册中心自动发现对端

小文件仍可走内联 base64（默认上限约 50MB）；流式传输需配置 `fileTransfer` 与边车 relay / QUIC helper。详见 [CHANGELOG.md](./CHANGELOG.md) 与 [docs/FILE-TRANSFER-UNIFIED-PLAN.md](./docs/FILE-TRANSFER-UNIFIED-PLAN.md)。

## 快速开始

设备装定制包 `openclaw-2026.3.13.tgz`（约 29MB），不要只装本仓库的小插件包。完整包内置的 gateway 可能仍是较旧副本；需要 1.6.x 文件传输时，用本目录 `npm pack` 产物覆盖设备上的 `extensions/a2a-gateway`。

```bash
npm install -g --omit=dev /data/local/tmp/openclaw-2026.3.13.tgz
# 然后覆盖 a2a-gateway 到 1.6.2，重启 gateway
```

装完还需：环境变量 → `openclaw.json`（隧道+注册中心，可选 `fileTransfer`）→ workspace → 启动。  
见 [INSTALL.md](./INSTALL.md) 与
[`../installer/README-安装与使用.md`](../installer/README-安装与使用.md)。

本目录是插件源（**1.6.2**），可同步到
`../openclaw-source/extensions/a2a-gateway` 后重新打包完整安装包。

## 文档

| 文档 | 说明 |
|------|------|
| [INSTALL.md](./INSTALL.md) | 简版安装 |
| [`../installer/README-安装与使用.md`](../installer/README-安装与使用.md) | 完整安装与配置说明 |
| [docs/操作手册.md](./docs/操作手册.md) | 细节与用例 |
| [docs/README.md](./docs/README.md) | 文档索引（含文件传输验收） |
| [CHANGELOG.md](./CHANGELOG.md) | 版本变更 |
| [`../TCP-FILE-STREAM.md`](../TCP-FILE-STREAM.md) | 文件数据面版本快照 |

## License

MIT
