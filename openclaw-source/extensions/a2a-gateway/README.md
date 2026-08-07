# `@openclaw/a2a-gateway`（定制包内置）

OpenClaw **stock** 插件：A2A 消息/文件 + 嵌入 Tunnel + 可选注册中心。

| 项 | 值 |
|----|-----|
| 插件 ID | `a2a-gateway` |
| 对齐版本 | Openclaw-A2A **1.4.3** |
| 真相源仓库 | `D:\openclaw\Openclaw-A2A` |

## 怎么装、怎么互通

本目录会打进 `openclaw-2026.3.13.tgz`。设备侧请看仓库根目录：

- [README-安装与使用.md](../../README-安装与使用.md) — 安装、配置、隧道、registry、workspace  
- [CUSTOM-A2A.md](../../CUSTOM-A2A.md) — 定制差异摘要  
- [harmony-workspace/](../../harmony-workspace/) — 鸿蒙 PC/Phone workspace 快照  

插件开发细节、兼容性与变更历史见 `Openclaw-A2A` 仓库的 `docs/`、`INSTALL.md`、`CHANGELOG.md`。

## 常用 gateway methods

- `a2a.send` / `a2a.send_local_file`
- `a2a.registry.register` / `a2a.registry.list`
- Agent 工具：`a2a_send_local_file` 等（见 `skill/`）

## 注意

- **不要**再 `plugins install` 外挂一份 `a2a-gateway`，也不要写 `plugins.load.paths` 指向 `/workspace/plugins/a2a-gateway`。
- 同步插件：从 `Openclaw-A2A` 拷到本目录后再重新 `pnpm pack`。
