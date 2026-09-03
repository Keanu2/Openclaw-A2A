# TLS/TCP 字节流双真机测试报告

- 测试日期：2026-09-03（Asia/Shanghai）
- 被测设备：Huawei Mate 70 Pro（HW-Phone2）、Huawei Mate 60 Pro（HW-Phone1）
- 数据路径：手机 → 公网云端 TLS/TCP File Relay → 手机
- 控制路径：现有 A2A WebSocket tunnel
- 测试矩阵：双向 × 10 MiB/100 MiB × 每组 5 次，共 20 次正式样本
- 范围：按要求不评价认证、凭据和证书治理；本次仍实际启用了 TLS 与证书指纹固定

## 1. 验收结论

修复后的同一版本完成 **20/20** 次正式传输，成功率 **100%**。每次均同时满足：

1. sender 返回 `dataCommitted=true`；
2. 最终 A2A 通知返回 `completed`；
3. receiver 持久记录为 `COMPLETED`；
4. receiver 实际落盘文件重新执行 SHA-256，与发送端预期值一致；
5. 20 个 transfer ID 全部唯一。

本次结果支持“当前 TLS/TCP 数据面在两台真机、10–100 MiB、单并发连续传输下可用且未发现数据损坏”。它不是弱网、断电、磁盘满、多并发或 1 GiB 长稳验收。

正式测试前，旧修订在 Phone2 → Phone1 的第 5 次 100 MiB 传输中出现一次真实失败：接收端 `.part` 在提交前消失，`link()` 返回 `ENOENT`。现场确认磁盘尚余 429 GiB，且没有形成第 5 个最终文件。修复了提交碰撞异常边界和启动恢复屏障后，全部正式样本从头重跑，原失败场景通过。

## 2. 指标定义

- `payload`：sender 把文件字节写入 TLS socket 的时间。
- `transfer`：receiver 已 ready 后，从 sender 建立 TLS/发送 metadata 到收到 receiver 最终 ACK 的时间；包含 `payload`、receiver 写盘/同步/校验/提交及 ACK 等待。
- `end-to-end`：真机测试命令启动到 `a2a.send_file` 返回；还包含 OpenClaw CLI 启动、发送端预哈希、控制面 prepare，以及文件提交后的 A2A agent 通知/处理。
- 吞吐按 MiB/s 计算；下表吞吐为五次“单次吞吐”的算术平均。

## 3. 分组汇总

| 方向 | 大小 | 成功 | payload 均值 | payload 吞吐 | transfer 均值 / 中位 / 范围 | transfer 吞吐 | end-to-end 均值 / 中位 / 范围 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Phone2 → Phone1 | 10 MiB | 5/5 | 0.654 s | 15.40 MiB/s | 3.967 / 4.144 / 3.347–4.265 s | 2.54 MiB/s | 19.974 / 18.452 / 17.185–26.692 s |
| Phone1 → Phone2 | 10 MiB | 5/5 | 0.749 s | 13.58 MiB/s | 4.457 / 4.201 / 3.908–5.971 s | 2.30 MiB/s | 34.612 / 18.582 / 18.084–96.444 s |
| Phone2 → Phone1 | 100 MiB | 5/5 | 33.623 s | 3.82 MiB/s | 69.598 / 63.821 / 23.236–134.054 s | 2.32 MiB/s | 91.348 / 84.590 / 38.313–159.915 s |
| Phone1 → Phone2 | 100 MiB | 5/5 | 53.368 s | 1.90 MiB/s | 106.434 / 105.371 / 75.888–141.904 s | 0.98 MiB/s | 124.111 / 123.696 / 93.904–159.409 s |

`payload` 只测 sender 写入本机 TLS socket 的耗时，会受到 socket/内核缓冲影响，不等于线上带宽；端到端数据面应以 `transfer` 为主。测试后半段公网链路明显降速，100 MiB 的 `transfer` 从 23.236 s 波动到 141.904 s，但两方向都持续完成，无 stall timeout、摘要错误或状态分裂。

## 4. 每次正式结果

| 方向 | 大小 | 次数 | 状态 | end-to-end ms | transfer ms | payload ms | ACK wait ms | receiver | SHA-256 |
|---|---:|---:|---|---:|---:|---:|---:|---|---|
| Phone2 → Phone1 | 10 | 1 | PASS | 17534 | 4143.5 | 741.8 | 2637.5 | COMPLETED | PASS |
| Phone2 → Phone1 | 10 | 2 | PASS | 26692 | 4265.1 | 606.5 | 2995.4 | COMPLETED | PASS |
| Phone2 → Phone1 | 10 | 3 | PASS | 17185 | 3879.2 | 652.8 | 2685.0 | COMPLETED | PASS |
| Phone2 → Phone1 | 10 | 4 | PASS | 20008 | 4198.7 | 592.5 | 2517.2 | COMPLETED | PASS |
| Phone2 → Phone1 | 10 | 5 | PASS | 18452 | 3347.4 | 675.1 | 2134.5 | COMPLETED | PASS |
| Phone1 → Phone2 | 10 | 1 | PASS | 21459 | 5971.2 | 881.8 | 4062.4 | COMPLETED | PASS |
| Phone1 → Phone2 | 10 | 2 | PASS | 96444 | 4280.5 | 682.1 | 3038.7 | COMPLETED | PASS |
| Phone1 → Phone2 | 10 | 3 | PASS | 18582 | 3908.3 | 656.9 | 2665.5 | COMPLETED | PASS |
| Phone1 → Phone2 | 10 | 4 | PASS | 18084 | 4201.1 | 862.3 | 2759.0 | COMPLETED | PASS |
| Phone1 → Phone2 | 10 | 5 | PASS | 18490 | 3922.9 | 662.8 | 2649.1 | COMPLETED | PASS |
| Phone2 → Phone1 | 100 | 1 | PASS | 41600 | 25138.2 | 17379.0 | 7120.8 | COMPLETED | PASS |
| Phone2 → Phone1 | 100 | 2 | PASS | 38313 | 23235.8 | 16141.9 | 6118.0 | COMPLETED | PASS |
| Phone2 → Phone1 | 100 | 3 | PASS | 132322 | 101739.5 | 46734.4 | 52382.8 | COMPLETED | PASS |
| Phone2 → Phone1 | 100 | 4 | PASS | 84590 | 63820.7 | 30337.3 | 29420.6 | COMPLETED | PASS |
| Phone2 → Phone1 | 100 | 5 | PASS | 159915 | 134054.1 | 57524.7 | 71803.0 | COMPLETED | PASS |
| Phone1 → Phone2 | 100 | 1 | PASS | 159409 | 141904.0 | 61257.9 | 75829.9 | COMPLETED | PASS |
| Phone1 → Phone2 | 100 | 2 | PASS | 123696 | 105370.6 | 52451.1 | 48879.5 | COMPLETED | PASS |
| Phone1 → Phone2 | 100 | 3 | PASS | 93904 | 75888.2 | 52500.0 | 18944.3 | COMPLETED | PASS |
| Phone1 → Phone2 | 100 | 4 | PASS | 114985 | 97643.6 | 56721.8 | 36358.0 | COMPLETED | PASS |
| Phone1 → Phone2 | 100 | 5 | PASS | 128563 | 111365.0 | 43909.5 | 63405.5 | COMPLETED | PASS |

原始逐样本 JSONL 保存在 `test-data/TCP-REAL-DEVICE-2026-09-03.jsonl`，包含 transfer ID、阶段指标、持久状态、接收路径和两端摘要，便于复算。

## 5. 测试中发现并修复的问题

### P0：提交碰撞处理的异常边界过宽

`commitPartNoClobber()` 原先把 `link()`、目录同步、删除 `.part` 和再次目录同步放在同一个 `try/catch` 中。任何后处理阶段的 `EEXIST` 都会被误判为“候选文件名已存在”并重试；如果 `.part` 已删除，下一次 `link()` 会产生虚假的 `ENOENT`。现在只捕获 `link()` 自身的 `EEXIST`，后处理错误不再进入重名循环。

### P0：启动恢复与新接收之间缺少屏障

`recoverInterrupted()` 原先 fire-and-forget。理论上新请求可在恢复扫描尚未结束时进入，恢复逻辑可能把活动 `.part` 当成上次进程遗留项处理。现在 prepare 必须等待一次性恢复完成；恢复失败时不接受新传输。

### P0：hard-link 已成功后的错误可能被降级为确认失败

若最终文件 hard-link 已创建，但后续目录同步或 `.part` 清理失败，最终文件是否持久存在属于不确定状态，不能标记为 `FAILED_CONFIRMED` 后自动重传。现在 `link()` 成功后会记录内存提交边界；后续异常保留持久 `COMMITTING`、候选路径和 `.part`，交给状态查询/重启恢复核对，不删除也不宣称失败。

### P1：关机清理引用了不存在的字段

活动接收结构只有 `cancel` 和 `completed`，stop 路径却解构 `receive`。已改为直接调用活动项的字段，TypeScript 全量检查通过。

### P2：QUIC helper 子进程类型在当前 Node 类型定义下不一致

`stdin: ignore` 返回的子进程类型与声明的 `ChildProcessWithoutNullStreams` 不符。统一为三路 pipe，协议仍不写 stdin；这是类型/版本兼容修复，不改变 QUIC 数据协议。

## 6. 仍需关注的真实风险

一次 Phone1 → Phone2 的 10 MiB 正式样本中，数据面 `transfer` 仅 4.280 s，文件已经正确提交，但完整调用耗时 96.444 s；额外时间来自落盘后的 A2A agent 通知/处理。这不是 TCP 传输卡住，也没有导致数据重复或损坏，但会放大 `a2a.send_file` 的端到端尾延迟。

此外，100 MiB 样本在测试后半段出现双向数据面降速，`transfer` 最大 141.904 s，ACK wait 最大 75.830 s。由于 sender 写入 socket 缓冲结束不代表公网数据已到 receiver，ACK wait 同时包含链路排空、receiver 同步/校验/提交。两方向同步变慢且全部通过，更符合测试时段链路波动；仍建议后续增加 relay 字节进度/时间戳和网络采样，以精确区分公网、云端转发和设备落盘。

建议列为 **P1 控制面演进项**：把“文件已提交/通知已受理”的快速确认与“agent 完成文件处理”解耦，提供可查询 task ID；同时给通知阶段单独的有界超时。不能简单在不确定状态下 fallback 或重传文件。

后续仍需补充：断网/ACK 丢包注入、进程在 `COMMITTING` 各阶段被杀、磁盘满/只读、并发额度、1 GiB、弱网与 100+ 次长稳。认证与凭据按本轮范围未审。

## 7. 版本与验证证据

两台设备的被测文件 SHA-256 完全一致：

- `a2a-plugin/index.ts`: `1a62426aeadcf6bf2a837ec6fad80a8d07f1be4414df6049f7e98842efe1e336`
- `file-transfer-store.ts`: `415e00ed6e57602aa07b8087c4f43528443d9f66f92da67e42749e78982df12b`
- `file-transfer.ts`: `d3e16b29f197e7d8bac59a6ce385dfd05e0e48dc1d6e745b849aa9fe7400a418`
- `quic-provider.ts`: `a9a5c54a1545cce401f268674f6ec3a802d1827237fcc6b779e137db35da2711`
- 云端 `file-relay.js`: `390952481b3c98079b75b7479d47d02870321fe5b37596b55298597007c97c51`

本地验证：

- `tsc --noEmit`: PASS
- `node --check server/file-relay.js`: PASS
- 两个测试采集脚本 `node --check`: PASS
- `git diff --check`: PASS，仅显示 Git 的 LF/CRLF 转换提示
- `tsx --test tests/file-transfer-stream.test.ts`: 宿主 Node 24 直接启动时会在 tsx 初始化阶段因 `uv_os_get_passwd ENOMEM` 失败；预加载仅替代 `os.userInfo()` 的测试 shim 后实际执行 **6/6 PASS**，包括多重文件名碰撞、no-clobber 和崩溃恢复用例。真机连续同名落盘也覆盖了最终行为。
