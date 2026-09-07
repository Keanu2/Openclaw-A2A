# 定制版 OpenClaw（内置 A2A）

基于 **v2026.3.13**，内置 `a2a-gateway`（隧道 + 注册中心 + 文件数据面，对齐插件 **1.6.2**）。  
若本地完整 tgz 仍是旧副本，用仓库 `a2a-plugin` / 已同步的 `openclaw-source/extensions/a2a-gateway` 覆盖后重启。

| 项 | 说明 |
|----|------|
| 安装包 | 本目录 `openclaw-2026.3.13.tgz` |
| 安装说明 | [README-安装与使用.md](./README-安装与使用.md) |
| workspace 模板 | 本地 `openclaw-custom/harmony-workspace/`（含设备配置，不上传 GitHub） |

流程：装包 → 环境变量 → `openclaw.json` → workspace → 启动。详见安装说明。
