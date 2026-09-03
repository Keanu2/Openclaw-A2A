# 安装说明（简版）

| 包 | 用途 |
|----|------|
| **`openclaw-2026.3.13-a2a-1.4.3.tgz`**（~29MB） | 设备上装这个 |
| `openclaw-a2a-*.tgz`（~115KB） | 仅插件，不是主安装包 |

完整步骤见：

- [`../installer/README-安装与使用.md`](../installer/README-安装与使用.md)
- 或 [`../openclaw-source/README-安装与使用.md`](../openclaw-source/README-安装与使用.md)

## 鸿蒙最快路径

```bash
hdc file send openclaw-2026.3.13-a2a-1.4.3.tgz /data/local/tmp/openclaw-2026.3.13-a2a-1.4.3.tgz
```

设备上：

```bash
export PATH="/usr/local/npm/bin:/usr/local/bin:/data/local/npm/bin:/data/local/tools/node-v24.2.0-openharmony-arm64/bin:$PATH"
export HOME=/data/local
export OPENCLAW_HOME=/data/local
export OPENCLAW_STATE_DIR=/data/local/.openclaw
export OPENCLAW_CONFIG_PATH=/data/local/.openclaw/openclaw.json

npm install -g --omit=dev /data/local/tmp/openclaw-2026.3.13-a2a-1.4.3.tgz
```

然后按完整说明写配置、拷 workspace、启动。`HOME` 不要设成 `/data/local/.openclaw`。
