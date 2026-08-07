# Openclaw-A2A

OpenClaw 的 **A2A Gateway** 插件（嵌入 Tunnel 版）：让两台设备上的 Agent 通过 A2A 互通，并在跨 NAT 时走云端中继转发。

| 项 | 值 |
|----|-----|
| 仓库目录 | `a2a-plugin` |
| npm 包名 | `openclaw-a2a` |
| 插件 ID | `a2a-gateway` |
| 当前版本 | `1.4.3` |

## 能做什么

- Agent ↔ Agent 消息与本地文件传输（默认内联上限 50MB）
- 可选嵌入隧道客户端，跨 NAT 经中继互通
- 可选注册中心自动发现对端

## 快速开始

设备装定制包 `openclaw-2026.3.13.tgz`（约 29MB），不要只装本仓库的小插件包。

```bash
npm install -g --omit=dev /data/local/tmp/openclaw-2026.3.13.tgz
```

装完还需：环境变量 → `openclaw.json`（隧道+注册中心）→ workspace → 启动。  
见 [INSTALL.md](./INSTALL.md) 与
[`../installer/README-安装与使用.md`](../installer/README-安装与使用.md)。

本目录是插件源（**1.4.3**），同步到
`../openclaw-source/extensions/a2a-gateway` 后打包。

## 文档

| 文档 | 说明 |
|------|------|
| [INSTALL.md](./INSTALL.md) | 简版安装 |
| [`../installer/README-安装与使用.md`](../installer/README-安装与使用.md) | 完整安装与配置说明 |
| [docs/操作手册.md](./docs/操作手册.md) | 细节与用例 |
| [CHANGELOG.md](./CHANGELOG.md) | 版本变更 |

## License

MIT
