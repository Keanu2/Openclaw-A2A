# 文件数据面 1.6.0 真机验收记录（Unified mode+Card）

- 日期：2026-09-03（Asia/Shanghai）
- 客户端：`openclaw-a2a@1.6.0`（`Openclaw-A2A-file-transfer`）
- 设备：电脑 `53V0224C19002918`（tunnel `HW-Phone2`）、手机 `FMR0223926019410`（tunnel `HW-Phone1`）
- 配置：`fileTransfer.mode=auto`，`inlinePreferredBelowBytes=1048576`，QUIC helper `/data/local/tmp/a2a-rcp/rcp-raw-stream-v7`
- 控制面：A2A WebSocket tunnel → `ws://121.37.53.35:8001`
- TCP 数据面：TLS File Relay → `121.37.53.35:8001`（SNI `a2a-file.invalid`）
- QUIC 数据面：`rcp-raw-stream-v7` → UDP `121.37.53.35:8008`
- TLS pin（实测）：`439e94b1c0b6cf14fabcc0224e5b921ae583518e0838ea8a9b8e642538fd929a`

## 1. 部署

1. `npm pack` → `openclaw-a2a-1.6.0.tgz`
2. `install-to-harmony-device.ps1 -SkipRestart` 覆盖两端 bundled `extensions/a2a-gateway/`
3. `fileTransfer.mode=auto` + 保留 `quic.extraEnv.LD_LIBRARY_PATH`
4. `sh /data/local/tmp/start-openclaw.sh` 重启；日志可见 `a2a.send_file (unified mode+Card selection)`，版本 `1.6.0`

## 2. 真机矩阵

调用：`openclaw gateway call a2a.send_file --params '{peer,path,mimeType[,transport]}'`（未强制 transport 时走 auto）

| 方向 | 大小 | 选择 | transport | 结果 | 源 SHA-256 | 说明 |
|------|------|------|-----------|------|------------|------|
| PC→手机 | 64 KiB | auto | `inline-base64` | **通过** | `6204ee52…cb3b18` | `statusCode=200`；落盘 Docs/OPENCLAW |
| 手机→PC | 64 KiB | auto | `inline-base64` | **通过** | `cab440ef…31b778` | 同上 |
| PC→手机 | 1 MiB | auto | `inline-base64` | **通过** | `b39158e1…b05e29` | `size <= inlinePreferredBelowBytes`（含等于）→ 仍走 inline |
| PC→手机 | 2 MiB | auto | `quic-v7` | **通过** | `e3fada61…35ffcd` | `transferMs≈3.1s`，`dataCommitted=true` |
| 手机→PC | 2 MiB | auto | `quic-v7` | **通过** | `f8651b92…bc9349` | `transferMs≈3.0s` |
| PC→手机 | 2 MiB | force | `tcp-v1` | **通过**（修 pin 后） | `e3fada61…35ffcd` | `transferMs≈2.3s`；收端哈希一致 |
| 手机→PC | 2 MiB | force | `tcp-v1` | **通过** | `f8651b92…bc9349` | `transferMs≈2.2s`；收端哈希一致 |
| PC→手机 | 2 MiB | force | `quic-v7` | **通过** | `e3fada61…35ffcd` | `transferMs≈3.0s` |
| PC→手机 | 10 MiB | auto | `quic-v7` | **通过** | `b538eb14…b91b6f` | `transferMs≈5.0s`，`dataCommitted=true` |
| 手机→PC | 10 MiB | auto | `quic-v7` | **通过** | `940b1d55…1c7316` | `transferMs≈5.1s` |
| PC→手机 | 10 MiB | force | `tcp-v1` | **通过** | `b538eb14…b91b6f` | `transferMs≈4.3s` |
| 手机→PC | 10 MiB | force | `tcp-v1` | **通过** | `940b1d55…1c7316` | `transferMs≈3.7s` |
| PC→手机 | 100 MiB | auto | `quic-v7` | **通过** | `b453a0ad…989671` | `transferMs≈24.4s` |
| 手机→PC | 100 MiB | auto | `quic-v7` | **通过** | `813f42fb…05b96e` | `transferMs≈23.5s` |
| PC→手机 | 100 MiB | force | `tcp-v1` | **通过** | `b453a0ad…989671` | `transferMs≈22.3s` |
| 手机→PC | 100 MiB | force | `tcp-v1` | **通过** | `813f42fb…05b96e` | `transferMs≈20.8s` |

收端校验（TCP/QUIC 落盘目录 `/data/local/tmp/a2a-tcp-received/`；同名冲突时落为 `name (N).ext`）：

- `ft-2m.txt` = `e3fada618bee9b63d9eb9123a2828cc275f39420351564bc33e9dce17235ffcd`
- `ft-phone-2m.txt` = `f8651b9282dcdf0fb801998c90767ffa9eedd66a94b50e003c6a30fb7abc9349`
- `ft-10m (1)/(2).txt` = `b538eb143b6a085358205f8129a2f5addcf466d781923cb47383653ad0b91b6f`（auto + tcp）
- `ft-phone-10m.txt` / `ft-phone-10m (1).txt` = `940b1d55340f403fa3e94b876486b0a7c69a51345d1fef6f671b1396cc1c7316`
- `ft-100m.txt` / `ft-100m (1).txt` = `b453a0ad477b2e45d0f2e3985fd35b1a8d286d573ea8cff3a4f967acf6989671`
- `ft-phone-100m.txt` / `ft-phone-100m (1).txt` = `813f42fb9ccceaa8f75ef5e39cc5baf8993b84ec0b0afb26aa243ffdc005b96e`

## 3. 过程问题与处置

1. **TLS pin 过期**：首次 force `tcp-v1` 报 `certificate pin mismatch: 439e94b1…`（配置仍为旧 pin `6086a975…`）。已将两端 `certificateSha256` 与 `configure-file-transfer.cjs` 默认值更新为当前中继证书指纹后复测通过。
2. **auto 阈值**：`1 MiB` 文件因 `size <= inlinePreferredBelowBytes` 走 inline；要验证 quic/tcp 自动选择需 `> 1 MiB`（本矩阵用 2 MiB）。
3. MIME：真机继续使用 `text/plain`（设备默认白名单不含 `application/octet-stream`）。

## 4. 网络状况

测前、测后 `hidumper -s WifiDevice` 一致：

- 两端均连接 `Huawei-Guest`
- BSSID 相同：`9c:50:**:**:**:52`
- 频段相同：`5GHz`
- 频率相同：`5785 MHz`
- IPv4：电脑 `100.125.153.186/23`，手机 `100.125.153.228/23`

结论：两台设备在 **同一 SSID、同一 BSSID、同一 5 GHz 信道** 上，不是分属不同 AP 或不同频点。

## 5. 结论

`openclaw-a2a@1.6.0` 在 HW-Phone2 ↔ HW-Phone1 上：

- **auto**：小文件 → `inline-base64`；大文件（双方均有 QUIC helper）→ `quic-v7`
- **强制** `tcp-v1` / `quic-v7` 双向可用，哈希与 `dataCommitted` 正常
- 100 MiB 实测：`quic-v7` 约 `23.5-24.4s`，`tcp-v1` 约 `20.8-22.3s`

## 6. 回滚

恢复 `openclaw.json` 备份，重装上一版扩展包，重启 gateway。

## 7. 后续补丁

- **1.6.1**：notify 竞态 — [FILE-TRANSFER-1.6.1-DEVICE-ACCEPTANCE-2026-09-04.md](./FILE-TRANSFER-1.6.1-DEVICE-ACCEPTANCE-2026-09-04.md)
- **1.6.2**：Docs/OPENCLAW hard-link — [FILE-TRANSFER-1.6.2-DEVICE-ACCEPTANCE-2026-09-07.md](./FILE-TRANSFER-1.6.2-DEVICE-ACCEPTANCE-2026-09-07.md)
