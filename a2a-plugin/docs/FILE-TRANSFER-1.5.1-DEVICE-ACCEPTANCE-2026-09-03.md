# 文件数据面 1.5.1 真机验收记录

- 日期：2026-09-03（Asia/Shanghai）
- 客户端：`openclaw-a2a@1.5.1`（`Openclaw-A2A-tcp-file-stream`）
- 设备：电脑 `53V0224C19002918`（tunnel `HW-Phone2`）、手机 `FMR0223926019410`（tunnel `HW-Phone1`）
- 控制面：A2A WebSocket tunnel → `ws://121.37.53.35:8001`
- TCP 数据面：TLS File Relay → `121.37.53.35:8001`（SNI `a2a-file.invalid`）
- QUIC 数据面：`rcp-raw-stream-v7` → UDP `121.37.53.35:8008`

## 1. 自测（开发机）

| 套件 | 结果 |
|------|------|
| `tsx --test tests/file-transfer-contract.test.ts` | 6/6 通过 |
| `tsx --test tests/file-transfer-stream.test.ts` | 5/5 通过 |
| `node --test server/file-relay.test.cjs` | 4/4 通过 |

## 2. 部署

1. `npm pack` → `artifacts/openclaw-a2a-1.5.1.tgz`
2. 解压覆盖两端 `/data/local/npm/lib/node_modules/openclaw/extensions/a2a-gateway/`
3. 配置增加静态 peer + `fileTransfer.quic.enabled=true`
4. `openclaw gateway run --bind loopback --port 18789 --force` 重启

## 3. 真机矩阵

调用：`openclaw gateway call a2a.send_file --params '{peer,path,transport,mimeType}'`

| 方向 | 大小 | transport | 结果 | 源 SHA-256 | 说明 |
|------|------|-----------|------|------------|------|
| PC→手机 | 1 MiB | `tcp-v1` | **通过** | `1d2c4eab…8cbe6d` | 收端路径一致，哈希一致；`attemptId` 已返回 |
| 手机→PC | 1 MiB | `tcp-v1` | **通过** | `0b200ac8…9db7d4` | 哈希一致；`a2a-transfer://` 通知成功 |
| PC→手机 | 1 MiB | `quic-v7` | **通过**（第 2 次） | `1d2c4eab…8cbe6d` | 首次因 notify/store 竞态失败，已修轮询后复测通过 |
| 手机→PC | 1 MiB | `quic-v7` | **通过** | `0b200ac8…9db7d4` | `dataCommitted: true` |
| PC→手机 | 10 MiB | `tcp-v1` | **通过** | `63986392…3d2d3e` | `transferMs ≈ 4.45 s` |

## 4. 已知限制（本版接受）

- `application/octet-stream` 不在设备默认 MIME 白名单；真机用例使用 `text/plain`。
- QUIC helper 尚无 JSONL `registered` 事件；prepare 用短启动等待 + status 轮询。
- prepare 入站认证（TCP-002）与 WSS 控制面（TCP-003）仍未关闭，仅受控环境可用。
- PC 无 RCP 的纯 Windows 主机不在本矩阵内（两端均为鸿蒙 + v7 helper）。

## 5. 回滚

恢复 `openclaw.json.bak-before-1.5.1`，重装 1.5.0 扩展包，重启 gateway。
