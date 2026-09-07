# 文件数据面 1.6.1 真机验收记录（notify 竞态）

- 日期：2026-09-04～2026-09-06（Asia/Shanghai；插件日 09-04，真机复测至 09-06）
- 客户端：`openclaw-a2a@1.6.1`（`Openclaw-A2A-file-transfer`）
- 基线：`openclaw-a2a@1.6.0` Unified `mode`+Card 选路
- 设备：电脑 `53V0224C19002918`（tunnel `HW-Phone2`）、手机 `FMR0223926019410`（tunnel `HW-Phone1`）
- 配置：流式开启；真机复测阶段 `fileTransfer.receiveDir=/data/local/.openclaw/a2a-files`（避开共享媒体 FS，聚焦 notify 合同）；QUIC helper `/data/local/tmp/a2a-rcp/rcp-raw-stream-v7`
- 控制面：A2A WebSocket tunnel → `ws://<relay-host>:8001`
- TCP 数据面：TLS File Relay → `<relay-host>:8001`（SNI `a2a-file.invalid`）
- QUIC 数据面：`rcp-raw-stream-v7` → UDP `<relay-host>:8008`
- TLS pin：与 1.6.0 验收相同（中继证书指纹未轮换）

> 边车地址与 1.6.0 实验室相同；对外摘录可用占位符 `<relay-host>`。

## 1. 问题（相对 1.6.0）

发端在收端 store 尚未进入 `DATA_COMMITTED` / `COMPLETED` 时即发送
`uri: a2a-transfer://<transferId>` FilePart。收端 executor / Agent 可能报校验失败；
QUIC 路径上 status 查询也可能在接收进行中短暂 404，诱使发端过早判定失败或重复通知。

## 2. 修复要点

| 项 | 行为 |
|----|------|
| 发端 notify | 轮询收端直至 `DATA_COMMITTED` / `COMPLETED` 后再发 `a2a-transfer://`；等待超时则**不**发通知 |
| status | 活动接收中返回 `state: "RECEIVING"`（含 `transferId` / `attemptId` / `transport`），避免假 404 |
| 收端 executor | 解析 `a2a-transfer://` 最多等待约 **90s** 再判任务失败 |

代码主要涉及：`index.ts`（status / notify 等待）、`src/executor.ts`（URI 解析等待）。

## 3. 自测（开发机）

| 套件 | 结果 |
|------|------|
| `tsx --import ./tests/os-userinfo-shim.cjs --test tests/file-transfer-contract.test.ts` | 与 1.6.0 同 harness；本版未改合同字段 |
| `tsx --import ./tests/os-userinfo-shim.cjs --test tests/file-transfer-stream.test.ts` | 同左 |
| 变更点 | notify 等待与 `RECEIVING` 属集成路径；以真机强制 `quic-v7` 为准 |

## 4. 部署

1. `npm pack` → `openclaw-a2a-1.6.1.tgz`
2. 覆盖两端 `/data/local/npm/lib/node_modules/openclaw/extensions/a2a-gateway/`（或等价 bundled 路径）
3. 将 `fileTransfer.receiveDir` 设为 `/data/local/.openclaw/a2a-files`（本版复测目录）
4. `sh /data/local/tmp/start-openclaw.sh`（或等价）重启；日志可见插件版本 `1.6.1`

## 5. 真机矩阵

调用：`openclaw gateway call a2a.send_file --params '{peer,path,mimeType,transport}'`

| 方向 | 大小 / 样本 | 选择 | transport | 结果 | 说明 |
|------|-------------|------|-----------|------|------|
| 手机→电脑 | 2 MiB（`ft-race-2m.txt`） | force | `quic-v7` | **通过** | `notificationOk: true`；任务 `completed`，无 URI validation failed；落盘 `/data/local/.openclaw/a2a-files/ft-race-2m.txt`；收端哈希与源一致 |
| 手机→电脑 | 实拍 JPG（历史卡住样本 `IMG_1785225401_000.jpg`） | force / auto | `quic-v7` | **通过** | 同目录落盘；Agent 回报真实绝对路径（此前竞态下易失败） |
| 任一侧 | ≤1 MiB | auto | `inline-base64` | **通过** | 不走 `a2a-transfer://`；回归无回归 |
| status 探针 | 接收进行中 | — | `quic-v7` | **通过** | HTTP status 可见 `RECEIVING`，随后升至 `DATA_COMMITTED` / `COMPLETED` |

本版**未**重跑 1.6.0 全量 10/100 MiB 吞吐矩阵；选路行为声明与 1.6.0 相同，本记录只覆盖 notify 合同。

## 6. 过程问题与处置

1. **竞态根因**：字节面已 `DATA_COMMITTED` 前发 FilePart → 收端 store 查无记录。改为“先等再通知”。
2. **落盘目录**：本版复测刻意使用 `.openclaw/a2a-files`（本机 FS，支持 hard-link），避免与 Docs/OPENCLAW 的 TCP `EPERM` 问题缠在一起（该问题在 **1.6.2** 单独验收）。
3. MIME：真机继续优先 `text/plain` / 设备白名单内类型。

## 7. 结论

`openclaw-a2a@1.6.1` 在 HW-Phone2 ↔ HW-Phone1 上：

- 消除「字节未落盘就通知」的竞态；`notificationOk` 与任务完成一致
- status `RECEIVING` 可观测，避免假 404 干扰发端
- 与 1.6.0 Unified 选路兼容；inline 路径不受影响

## 8. 回滚

恢复 `openclaw.json` 备份，重装 `openclaw-a2a@1.6.0`，重启 gateway。

## 9. 相关文档

- 上一版矩阵：[FILE-TRANSFER-1.6.0-DEVICE-ACCEPTANCE-2026-09-03.md](./FILE-TRANSFER-1.6.0-DEVICE-ACCEPTANCE-2026-09-03.md)
- 下一版（Docs/OPENCLAW TCP）：[FILE-TRANSFER-1.6.2-DEVICE-ACCEPTANCE-2026-09-07.md](./FILE-TRANSFER-1.6.2-DEVICE-ACCEPTANCE-2026-09-07.md)
- 变更摘要：[../CHANGELOG.md](../CHANGELOG.md) `[1.6.1]`
