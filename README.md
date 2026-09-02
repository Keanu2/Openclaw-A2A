# OpenClaw A2A 代码仓库

本仓库按用途分为三个独立部分：

| 目录 | 内容 |
|------|------|
| [`a2a-plugin/`](./a2a-plugin/) | A2A Gateway 插件源码、脚本、测试与文档 |
| [`installer/`](./installer/) | OpenClaw 2026.3.13 定制安装包及安装说明 |
| [`openclaw-source/`](./openclaw-source/) | 内置 A2A Gateway 的 OpenClaw 定制源码 |

## 安装

需要直接部署时，请从 [`installer/`](./installer/) 下载
`openclaw-2026.3.13.tgz`，并按照
[`README-安装与使用.md`](./installer/README-安装与使用.md) 操作。

当前冻结的插件版本见 tag [`a2a-1.4.3`](https://github.com/Keanu2/Openclaw-A2A/releases/tag/a2a-1.4.3)。TCP 大文件在分支 `feature/a2a-tcp-file-stream-v1`，尚未合入 `main`。

只开发 A2A 插件时进入 [`a2a-plugin/`](./a2a-plugin/)；需要重新构建完整
OpenClaw 安装包时进入 [`openclaw-source/`](./openclaw-source/)。

## 相关仓库

| 仓库 | 用途 |
|------|------|
| 本仓库 | OpenClaw 定制 + A2A 插件 + 安装包 |
| [agent-registry-relay](https://github.com/Keanu2/agent-registry-relay) | 公开的注册中心与隧道代码（tag `v0.3.3`） |
| [agent-registry-relay-server-backup](https://github.com/Keanu2/agent-registry-relay-server-backup) | 私有：线上服务器源码快照 |
| [a2a-raw-quic-stream](https://github.com/Keanu2/a2a-raw-quic-stream) | 私有：当前 raw QUIC 字节流（tag `v7-2026-09-02`） |
| [a2a-nginx-h3-putget](https://github.com/Keanu2/a2a-nginx-h3-putget) 等 | 私有归档：2026-08-27 HTTP/3 对照实验，已冻结 |
