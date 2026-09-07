# openclaw-2026.3.13

定制 OpenClaw（内置 A2A **1.6.2** 源树；已发布的 `openclaw-2026.3.13.tgz` 若未重打包仍可能是旧副本）。

| 文件 | 说明 |
|------|------|
| `openclaw-2026.3.13.tgz` | 安装包（约 29MB） |
| [README-安装与使用.md](./README-安装与使用.md) | 安装与配置说明 |
| [CUSTOM-A2A.md](./CUSTOM-A2A.md) | 定制差异摘要 |

**流程：** 装包 → 环境变量 → `openclaw.json`（含注册中心）→ workspace → 启动。

```bash
hdc file send openclaw-2026.3.13.tgz /data/local/tmp/openclaw-2026.3.13.tgz
# 设备上先设环境变量（见安装说明），再：
npm install -g --omit=dev /data/local/tmp/openclaw-2026.3.13.tgz
```
