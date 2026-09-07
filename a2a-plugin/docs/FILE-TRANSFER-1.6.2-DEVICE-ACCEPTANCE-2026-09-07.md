# 文件数据面 1.6.2 真机验收记录（Docs/OPENCLAW hard-link）

- 日期：2026-09-07（Asia/Shanghai）
- 客户端：`openclaw-a2a@1.6.2`（`Openclaw-A2A-file-transfer`）
- 基线：`openclaw-a2a@1.6.1`（notify 合同已修）
- 设备：电脑 `53V0224C19002918`（tunnel `HW-Phone2`）、手机 `FMR0223926019410`（tunnel `HW-Phone1`）
- 配置：两端临时 `fileTransfer.mode=tcp`；`receiveDir=/storage/media/100/local/files/Docs/OPENCLAW`（文件管理「文档/OPENCLAW」）；测完改回 `mode=auto`
- QUIC helper：`/data/local/tmp/a2a-rcp/rcp-raw-stream-v7`（回归 `auto`/`base64` 时使用）
- 控制面：A2A WebSocket tunnel → `ws://<relay-host>:8001`
- TCP 数据面：TLS File Relay → `<relay-host>:8001`（SNI `a2a-file.invalid`）
- QUIC 数据面：`rcp-raw-stream-v7` → UDP `<relay-host>:8008`
- TLS pin：与 1.6.0 验收相同

> 边车地址与 1.6.0 实验室相同；对外摘录可用占位符 `<relay-host>`。

## 1. 问题（相对 1.6.1）

`tcp-v1` 收端提交对 `.part` 使用同目录 `link(2)` 做 no-clobber。HarmonyOS 共享媒体 FS
（hmdfs/sharefs）上的 `Docs/OPENCLAW` **拒绝 hard link**，典型错误：

```text
EPERM: operation not permitted, link '.../*.part' -> '.../*.heic'
```

症状：两端强制 `fileTransfer.mode=tcp` 时传输失败；`quic-v7` / `inline-base64` 不受影响
（QUIC 直接写最终文件，不走该 `link` 提交路径）。

## 2. 修复要点

`commitPartNoClobber`（`src/file-transfer-store.ts`）：

1. 仍优先 `link(2)`（同 inode、原子占名）
2. `EPERM` / `ENOTSUP` / `EXDEV` / `EACCES` → 尝试 `rename(.part → candidate)`
3. 再失败 → `copyFile` + 删除 `.part`
4. 全程保持 no-clobber（`EEXIST` 换名重试）；成功占名后 `fsync` 父目录

成功定义不变：size + SHA-256 校验后进入 `DATA_COMMITTED`，再按 1.6.1 合同发 `a2a-transfer://`。

## 3. 自测（开发机）

| 套件 | 结果 |
|------|------|
| 合同 / stream 单测 harness | 与 1.6.1 相同；本版改动集中在提交原语 |
| 真机复现 | 升级前：`mode=tcp` + `Docs/OPENCLAW` → `EPERM`；升级后见下表 |

## 4. 部署

1. `npm pack` → `openclaw-a2a-1.6.2.tgz`
2. 覆盖两端 bundled `extensions/a2a-gateway/`，确认 `openclaw.plugin.json` / 日志版本 `1.6.2`
3. 两端：

```json
"fileTransfer": {
  "enabled": true,
  "mode": "tcp",
  "receiveDir": "/storage/media/100/local/files/Docs/OPENCLAW"
}
```

4. 重启 gateway 后互发；验收通过后两端改回 `"mode": "auto"`

## 5. 真机矩阵

调用：`openclaw gateway call a2a.send_file --params '{peer,path,mimeType[,transport]}'`  
（`mode=tcp` 时即使不写 `transport` 也走 `tcp-v1`；亦可显式 `transport:"tcp-v1"`）

| 方向 | 样本 | 选择 | transport | 结果 | 说明 |
|------|------|------|-----------|------|------|
| 手机→电脑 | 实拍 HEIC（`IMG_1788748345_008.heic`） | force `mode=tcp` | `tcp-v1` | **通过** | 收端 `COMPLETED`；落盘电脑侧 `Docs/OPENCLAW`；无 `link` EPERM |
| 电脑→手机 | 实拍 / 对照样本 | force `mode=tcp` | `tcp-v1` | **通过** | 双向对称；落盘手机侧 `Docs/OPENCLAW` |
| 任一侧 | 小文件 | force `mode=base64` 或 auto 小文件 | `inline-base64` | **通过** | 回归；不经 TCP commit |
| 任一侧 | 大文件（双方有 QUIC helper） | `mode=auto`（测完恢复） | `quic-v7` | **通过** | 选路回归；不依赖 hard-link 回退 |

本版**未**重跑 1.6.0 全量 10/100 MiB 吞吐矩阵；焦点是「用户可见目录 + 强制 TCP」。

收端核对：

- 路径前缀：`/storage/media/100/local/files/Docs/OPENCLAW/`
- 状态：发端可见 `dataCommitted` / 任务完成；Agent 回报上述绝对路径
- 升级前对照：同配置下 `link(...part → ...heic)` 报 `EPERM`

## 6. 过程问题与处置

1. **根因隔离**：先强制 `mode=tcp` 复现，排除 QUIC/Agent 提示词干扰。
2. **与 1.6.1 目录策略**：1.6.1 为测 notify 曾落到 `.openclaw/a2a-files`；产品路径仍要 `Docs/OPENCLAW`，故单独开 1.6.2。
3. **回退顺序**：`link` → `rename` → `copyFile`，尽量保留同 inode 语义；跨设备/`EXDEV` 才复制。
4. MIME / HEIC：设备侧可按既有规则转码或原样落盘；本记录以传输与提交成功为准。

## 7. 网络状况

与 1.6.0 验收同拓扑（同一实验室 Wi‑Fi / 同一边车）。本版未单独重采 `hidumper`；若网络变更需重记 BSSID/信道。

## 8. 结论

`openclaw-a2a@1.6.2` 在 HW-Phone2 ↔ HW-Phone1 上：

- 强制 `tcp-v1` 可在 **`Docs/OPENCLAW`** 落盘，不再因 hard-link `EPERM` 失败
- 不改变 `DATA_COMMITTED` / `a2a-transfer://` 合同（继承 1.6.1）
- 建议现网：`mode=auto`，`receiveDir=…/Docs/OPENCLAW`

## 9. 回滚

- 重装 `openclaw-a2a@1.6.1`；或
- 保留 1.6.1 且必须 TCP 时，将 `receiveDir` 改回支持 hard-link 的本机目录（如 `…/.openclaw/a2a-files`），代价是文件管理器不易打开

## 10. 相关文档

- notify 竞态：[FILE-TRANSFER-1.6.1-DEVICE-ACCEPTANCE-2026-09-04.md](./FILE-TRANSFER-1.6.1-DEVICE-ACCEPTANCE-2026-09-04.md)
- Unified 全量矩阵：[FILE-TRANSFER-1.6.0-DEVICE-ACCEPTANCE-2026-09-03.md](./FILE-TRANSFER-1.6.0-DEVICE-ACCEPTANCE-2026-09-03.md)
- 提交策略补记：[TCP-FILE-STREAM-URGENT-FIXES-2026-09-02.md](./TCP-FILE-STREAM-URGENT-FIXES-2026-09-02.md) §7
- 变更摘要：[../CHANGELOG.md](../CHANGELOG.md) `[1.6.2]`
