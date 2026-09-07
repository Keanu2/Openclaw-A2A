# 文件数据面 1.6.2 真机验收记录（Docs/OPENCLAW hard-link）

- 日期：2026-09-07
- 客户端：`openclaw-a2a@1.6.2`（`Openclaw-A2A-file-transfer`）
- 设备：HW-Phone2 ↔ HW-Phone1（HarmonyOS）
- 收件目录：`/storage/media/100/local/files/Docs/OPENCLAW`（文件管理「文档/OPENCLAW」）

## 1. 问题

`tcp-v1` 提交阶段对 `.part` 使用同目录 `link(2)` 做 no-clobber。鸿蒙共享媒体 FS（hmdfs/sharefs）上 `Docs/OPENCLAW` 常返回 `EPERM`，强制 `fileTransfer.mode=tcp` 时传输失败。`quic-v7` / `inline-base64` 不受该提交路径影响。

## 2. 修复要点

`commitPartNoClobber`（`src/file-transfer-store.ts`）：

1. 仍优先 `link(2)`（同 inode、原子占名）
2. `EPERM` / `ENOTSUP` / `EXDEV` / `EACCES` → 尝试 `rename(.part → candidate)`
3. 再失败 → `copyFile` + 删除 `.part`，并保持 no-clobber（`EEXIST` 换名重试）
4. 每次成功占名后仍 `fsync` 父目录

## 3. 部署

1. `npm pack` → `openclaw-a2a-1.6.2.tgz`
2. 覆盖两端 `extensions/a2a-gateway`，确认 `package.json` / 日志版本 `1.6.2`
3. `fileTransfer.receiveDir`（或与之对齐的落盘目录）指向 `Docs/OPENCLAW`
4. 复测后两端可改回 `fileTransfer.mode=auto`

## 4. 验收结果

| 方向 | 模式 | 结果 | 备注 |
|------|------|------|------|
| Phone2 → Phone1 | `tcp` | **通过** | 落盘 `Docs/OPENCLAW`，无 hard-link EPERM |
| Phone1 → Phone2 | `tcp` | **通过** | 同上 |
| 任一侧 | `base64` | **通过** | 回归 |
| 任一侧 | `auto` | **通过** | 测完恢复默认；大文件仍优先 quic |

## 5. 结论

`1.6.2` 使强制 TCP 可在用户可见的 `Docs/OPENCLAW` 落盘；不改变 `DATA_COMMITTED` 成功定义与 `a2a-transfer://` 合同。建议现网：`mode=auto`，`receiveDir=…/Docs/OPENCLAW`。

## 6. 回滚

重装 `1.6.1`；若必须 TCP 且不能升 1.6.2，将 `receiveDir` 改到支持 hard-link 的本机目录（如 `…/.openclaw/a2a-files`），代价是文件管理器不易打开。
