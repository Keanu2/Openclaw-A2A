# OpenClaw A2A 代码仓库

本仓库按用途分为三个独立部分：

| 目录 | 内容 |
|------|------|
| [`a2a-plugin/`](./a2a-plugin/) | A2A Gateway 插件源码、脚本、测试与文档（当前 **`openclaw-a2a@1.6.2`**） |
| [`installer/`](./installer/) | OpenClaw 2026.3.13 定制安装包及安装说明 |
| [`openclaw-source/`](./openclaw-source/) | 内置 A2A Gateway 的 OpenClaw 定制源码 |

GitHub：公开仓 [Openclaw-A2A](https://github.com/Keanu2/Openclaw-A2A)；本树的私有镜像为 [Openclaw-A2A-private](https://github.com/Keanu2/Openclaw-A2A-private)（曾用名 Openclaw-A2A-file-transfer）。

## 版本说明在哪里

插件版本号以 `a2a-plugin/package.json` / `openclaw.plugin.json` 为准。文字说明分三层，**不是每个版本都有 GitHub Release**：

| 版本 | CHANGELOG | 真机验收 | GitHub Release / Tag | 备注 |
|------|-----------|----------|----------------------|------|
| **1.6.2** | [CHANGELOG](./a2a-plugin/CHANGELOG.md#162---2026-09-07) | [验收](./a2a-plugin/docs/FILE-TRANSFER-1.6.2-DEVICE-ACCEPTANCE-2026-09-07.md) | 暂无独立 Release | Docs/OPENCLAW hard-link 回退；见 [PR #2](https://github.com/Keanu2/Openclaw-A2A/pull/2) |
| **1.6.1** | [CHANGELOG](./a2a-plugin/CHANGELOG.md#161---2026-09-04) | [验收](./a2a-plugin/docs/FILE-TRANSFER-1.6.1-DEVICE-ACCEPTANCE-2026-09-04.md) | 暂无独立 Release | `a2a-transfer://` 等 `DATA_COMMITTED`；同上 PR |
| **1.6.0** | [CHANGELOG](./a2a-plugin/CHANGELOG.md#160---2026-09-03) | [验收](./a2a-plugin/docs/FILE-TRANSFER-1.6.0-DEVICE-ACCEPTANCE-2026-09-03.md) | 暂无独立 Release | Unified `mode`+Card；同上 PR |
| **1.5.2** | （并入 TCP 加固说明） | — | 私有仓 [`v1.5.2-tcp-device-fix`](https://github.com/Keanu2/Openclaw-A2A-private/releases/tag/v1.5.2-tcp-device-fix) | TCP 真机加固 |
| **1.5.1** | [CHANGELOG](./a2a-plugin/CHANGELOG.md#151---2026-09-03) | [验收](./a2a-plugin/docs/FILE-TRANSFER-1.5.1-DEVICE-ACCEPTANCE-2026-09-03.md) | 私有仓 [`v1.5.1-file-transfer`](https://github.com/Keanu2/Openclaw-A2A-private/releases/tag/v1.5.1-file-transfer) | 合同层 + `quic-v7` |
| **1.4.3** | （见更早章节 / 冻结包） | — | 公开仓 [`a2a-1.4.3`](https://github.com/Keanu2/Openclaw-A2A/releases/tag/a2a-1.4.3) | 定制安装包基线 |

完整变更列表：[a2a-plugin/CHANGELOG.md](./a2a-plugin/CHANGELOG.md)。  
文件数据面版本快照：[TCP-FILE-STREAM.md](./TCP-FILE-STREAM.md)。  
文档索引：[a2a-plugin/docs/README.md](./a2a-plugin/docs/README.md)。

> Keep a Changelog 的标题锚点在 GitHub 上可能因渲染略有差异；打不开锚点时直接打开 CHANGELOG 搜 `[1.6.2]` 即可。

## 安装

需要直接部署时，请从 [`installer/`](./installer/) 下载
`openclaw-2026.3.13.tgz`，并按照
[`README-安装与使用.md`](./installer/README-安装与使用.md) 操作。  
需要 1.6.x Unified 文件传输时，再用 `a2a-plugin` 覆盖设备上的 `extensions/a2a-gateway`。

只开发 A2A 插件时进入 [`a2a-plugin/`](./a2a-plugin/)；需要重新构建完整
OpenClaw 安装包时进入 [`openclaw-source/`](./openclaw-source/)。
