# 文件数据面 1.6.1 真机验收记录（notify 竞态）

- 日期：2026-09-04
- 客户端：`openclaw-a2a@1.6.1`（`Openclaw-A2A-file-transfer`）
- 设备：HW-Phone2 ↔ HW-Phone1（HarmonyOS）
- 基线：在 1.6.0 Unified `mode`+Card 选路上修复 `a2a-transfer://` 过早通知

## 1. 问题

发端在收端尚未 `DATA_COMMITTED` 时就发送 `uri: a2a-transfer://…` FilePart，收端解析失败或 Agent 报错；QUIC 路径上 status 查询也可能短暂 404。

## 2. 修复要点（相对 1.6.0）

| 项 | 行为 |
|----|------|
| 发端 | 等收端 store 为 `DATA_COMMITTED` / `COMPLETED` 后再发 `a2a-transfer://`；等待超时则**不**发通知 |
| status | 活动接收中返回 `RECEIVING`，避免假 404 |
| 收端 executor | 解析 `a2a-transfer://` 最多等待约 90s 再判失败 |

## 3. 部署

1. `npm pack` → `openclaw-a2a-1.6.1.tgz`
2. 覆盖设备 `extensions/a2a-gateway`，重启 gateway
3. 日志可见插件版本 `1.6.1`

## 4. 验收结果

| 场景 | 结果 |
|------|------|
| auto + 大图 / HEIC（走 `quic-v7`） | 通过；Agent 回报真实保存路径，无过早 `a2a-file.invalid` / 解析失败 |
| status 轮询（接收进行中） | 可见 `RECEIVING`，随后 `DATA_COMMITTED` |
| 小文件 `inline-base64` | 不受影响（不走 transfer URI） |

## 5. 结论

`1.6.1` 消除「字节未落盘就通知」的竞态；与 1.6.0 选路行为兼容。落盘目录仍由 `fileTransfer.receiveDir` / `fileStorage.tempDir` 决定（真机常用 `Docs/OPENCLAW`）。

## 6. 回滚

恢复 `openclaw.json` 备份，重装 `1.6.0` 扩展包，重启 gateway。
