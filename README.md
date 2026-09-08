# OpenClaw A2A

OpenClaw 定制发行 + 内置 **A2A Gateway** 插件。当前推荐线是 **`main` = `openclaw-a2a@1.6.2`**。

| 目录 | 内容 |
|------|------|
| [`a2a-plugin/`](./a2a-plugin/) | A2A Gateway 插件源码、测试与文档 |
| [`installer/`](./installer/) | OpenClaw 2026.3.13 定制安装包及安装说明 |
| [`openclaw-source/`](./openclaw-source/) | 内置 A2A Gateway 的 OpenClaw 定制源码 |

## 怎么看这个仓库

| 你要找的 | 去哪 |
|----------|------|
| 当前代码 | 默认分支 [`main`](https://github.com/Keanu2/Openclaw-A2A) |
| 当前版本说明 | GitHub Release [`a2a-1.6.2`](https://github.com/Keanu2/Openclaw-A2A/releases/tag/a2a-1.6.2) |
| 全部变更 | [`a2a-plugin/CHANGELOG.md`](./a2a-plugin/CHANGELOG.md) |
| 真机验收 | [`a2a-plugin/docs/`](./a2a-plugin/docs/) |
| 旧安装包基线（1.4.3） | tag / Release [`a2a-1.4.3`](https://github.com/Keanu2/Openclaw-A2A/releases/tag/a2a-1.4.3) |
| 升级前的旧 `main` 快照 | 只读分支 [`archive/main-pre-1.6.2`](https://github.com/Keanu2/Openclaw-A2A/tree/archive/main-pre-1.6.2)（不要基于它开发） |
| **每条分支 / tag 是什么** | 看 [`BRANCHES.md`](./BRANCHES.md) |

公开仓与私有镜像是**同一棵树**：

- 公开：[Keanu2/Openclaw-A2A](https://github.com/Keanu2/Openclaw-A2A)
- 私有镜像：[Keanu2/Openclaw-A2A-private](https://github.com/Keanu2/Openclaw-A2A-private)（曾用名 `Openclaw-A2A-file-transfer`）

## 版本与发布

约定：

1. **`main` 只表示当前推荐线**，不表示「永远是 1.4.3 安装包」。
2. **每个推荐版本打 tag `a2a-<version>`，并做同名 GitHub Release。**
3. **CHANGELOG 是完整记录**；Release 是该版本面向使用者的入口。
4. **真机验收文档**记录实验室结果，不替代 CHANGELOG。

| 版本 | 一句话 | CHANGELOG | 真机验收 | GitHub Release |
|------|--------|-----------|----------|----------------|
| **1.6.2**（当前） | Docs/OPENCLAW 上 TCP `link(2)` EPERM 回退 | [1.6.2](./a2a-plugin/CHANGELOG.md) | [验收](./a2a-plugin/docs/FILE-TRANSFER-1.6.2-DEVICE-ACCEPTANCE-2026-09-07.md) | [`a2a-1.6.2`](https://github.com/Keanu2/Openclaw-A2A/releases/tag/a2a-1.6.2) |
| **1.6.1** | 等 `DATA_COMMITTED` 再发 `a2a-transfer://` | [1.6.1](./a2a-plugin/CHANGELOG.md) | [验收](./a2a-plugin/docs/FILE-TRANSFER-1.6.1-DEVICE-ACCEPTANCE-2026-09-04.md) | 并入 1.6.2 Release 说明 |
| **1.6.0** | Unified `fileTransfer.mode` + Agent Card 选路 | [1.6.0](./a2a-plugin/CHANGELOG.md) | [验收](./a2a-plugin/docs/FILE-TRANSFER-1.6.0-DEVICE-ACCEPTANCE-2026-09-03.md) | 并入 1.6.2 Release 说明 |
| **1.5.2** | TCP 真机加固 | CHANGELOG / 紧急修复记录 | — | 私有仓 [`v1.5.2-tcp-device-fix`](https://github.com/Keanu2/Openclaw-A2A-private/releases/tag/v1.5.2-tcp-device-fix) |
| **1.5.1** | 合同层 + `quic-v7` | [1.5.1](./a2a-plugin/CHANGELOG.md) | [验收](./a2a-plugin/docs/FILE-TRANSFER-1.5.1-DEVICE-ACCEPTANCE-2026-09-03.md) | 私有仓 [`v1.5.1-file-transfer`](https://github.com/Keanu2/Openclaw-A2A-private/releases/tag/v1.5.1-file-transfer) |
| **1.4.3** | 定制安装包冻结基线 | 更早章节 | — | [`a2a-1.4.3`](https://github.com/Keanu2/Openclaw-A2A/releases/tag/a2a-1.4.3) |

文档索引：[a2a-plugin/docs/README.md](./a2a-plugin/docs/README.md)。  
文件数据面版本快照：[TCP-FILE-STREAM.md](./TCP-FILE-STREAM.md)。

## 相关仓库

| 仓库 | 用途 |
|------|------|
| 本仓库 | OpenClaw 定制 + A2A 插件 + File Relay 源码（`server/file-relay.js`）+ 安装包 |
| [Openclaw-A2A-private](https://github.com/Keanu2/Openclaw-A2A-private) | 本仓库的私有镜像（同 tip） |
| [a2a-raw-quic-stream](https://github.com/Keanu2/a2a-raw-quic-stream) | QUIC 中继 + 设备 helper（tag `v7-2026-09-02`）；1.6.x 线协议未改 |
| [agent-registry-relay](https://github.com/Keanu2/agent-registry-relay) | 注册中心与可选 Relay（tag `v0.3.3`） |
| [agent-registry-relay-server-backup](https://github.com/Keanu2/agent-registry-relay-server-backup) | 私有：线上服务器源码快照 |
| [a2a-nginx-h3-putget](https://github.com/Keanu2/a2a-nginx-h3-putget) 等 | 私有归档：HTTP/3 对照实验，已冻结 |

边车 File Relay 与 QUIC 中继**不跟每个插件小版本各打一份服务器 Release**。1.6.x 只改设备侧插件；服务器继续用现网 File Relay + QUIC v7。

## 安装

需要直接部署时，从 [`installer/`](./installer/) 取 `openclaw-2026.3.13.tgz`，按
[`README-安装与使用.md`](./installer/README-安装与使用.md) 操作。

完整包内置的 `a2a-gateway` 副本可能仍落后于 `main`。需要 **1.6.2** 文件传输时，用本仓库 `a2a-plugin` 覆盖设备上的 `extensions/a2a-gateway` 后重启 gateway。旧 1.4.3 包见 tag [`a2a-1.4.3`](https://github.com/Keanu2/Openclaw-A2A/releases/tag/a2a-1.4.3)。

只开发插件时进入 [`a2a-plugin/`](./a2a-plugin/)；重新打包完整 OpenClaw 时进入 [`openclaw-source/`](./openclaw-source/)。
