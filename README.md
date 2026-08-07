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

只开发 A2A 插件时进入 [`a2a-plugin/`](./a2a-plugin/)；需要重新构建完整
OpenClaw 安装包时进入 [`openclaw-source/`](./openclaw-source/)。
