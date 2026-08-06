# Openclaw-A2A

OpenClaw 的 **A2A Gateway** 插件（嵌入 Tunnel 版）：让两台设备上的 Agent 通过 A2A 互通，并在跨 NAT 时走云端中继转发。

| 项 | 值 |
|----|-----|
| 仓库目录 | `Openclaw-A2A` |
| npm 包名 | `openclaw-a2a` |
| 插件 ID | `a2a-gateway` |
| 当前版本 | `1.4.3-tunnel.3` |

## 能做什么

- Agent ↔ Agent 消息与本地文件传输（默认内联上限 50MB）
- 可选嵌入隧道客户端，跨 NAT 经中继互通
- 可选注册中心自动发现对端（少写死 peers）

## 快速开始

```bash
cd Openclaw-A2A
npm install
npm run test:tunnel          # 建议先跑通隧道单测
openclaw plugins install .   # 或按操作手册写入 extensions
openclaw gateway restart
```

要求：Node.js 22+，本机已安装并可启动 OpenClaw Gateway。

## 文档

| 文档 | 说明 |
|------|------|
| [docs/操作手册.md](./docs/操作手册.md) | 安装、直连 / NAT、注册中心、配置与排障（完整步骤） |
| [docs/README.md](./docs/README.md) | 文档索引 |
| [docs/工作文档/](./docs/工作文档/) | 改动说明、测试报告等历史记录 |
| [docs/COMPATIBILITY.md](./docs/COMPATIBILITY.md) | A2A 兼容性说明 |
| [CHANGELOG.md](./CHANGELOG.md) | 版本变更 |

本地文件名规则（摘要）：发送侧传输名 = `path` 的 basename；线上 FilePart 为 `{ name, mimeType, bytes }`。详情见操作手册与 [2026-08-06 改动说明](./docs/工作文档/2026-08-06-改动说明-传输文件名加固与仓库重命名.md)。

## License

MIT
