# 定制版 OpenClaw（内置 A2A）

基于 **v2026.3.13**，内置 `a2a-gateway`（隧道 + 注册中心，安装包基线 **1.4.3**）。  
需要 Unified 文件传输（`fileTransfer.mode` / tcp-v1 / quic-v7）时，用仓库 `a2a-plugin` 当前版 **1.6.2** 覆盖 `extensions/a2a-gateway` 后重启。

| 项 | 说明 |
|----|------|
| 安装包 | 本目录 `openclaw-2026.3.13.tgz` |
| 安装说明 | [README-安装与使用.md](./README-安装与使用.md) |
| workspace 模板 | 本地 `openclaw-custom/harmony-workspace/`（含设备配置，不上传 GitHub） |

流程：装包 → 环境变量 → `openclaw.json` → workspace → 启动。详见安装说明。
