# TOOLS.md — HW-Phone1

本机 HarmonyOS 手机。只用 sh/node/openclaw，禁止 PowerShell。

## 身份
| | |
|--|--|
| 本机 | `HW-Phone1` |
| 对端 peer | `HW-PC1`（A2A 名，不是 SoftBus） |

## 路径
| 用途 | 路径 |
|------|------|
| 图库 | `/storage/media/100/local/files/Photo/` |
| 图库示例 | `/storage/media/100/local/files/Photo/16/IMG_1785225401_000.jpg` |
| 桌面 | `/storage/media/100/local/files/Docs/Desktop/` |
| 工作区样例 | `/data/local/.openclaw/workspace/a2a-fixtures/` |
| **A2A 收件（唯一）** | `/storage/media/100/local/files/Docs/OPENCLAW/` |

## 聊天窗口回报规则（必须遵守）
- **发送完成**：工具成功后，用中文明确说「发送完成」，并带上 peer 名与**本地 path 的文件名**（与磁盘 basename 一致）。
- **接收成功**：看到入站含「A2A 文件接收成功」时，用中文明确说「接收成功」，并**原样完整复制**消息里的「保存路径」整行绝对路径。
- **禁止**把保存路径改写成 `/data/local/tmp/a2a-files/` 或其它目录；以消息内路径为准。
- 不要只说「已处理」；不要省略路径；不要说配对/没权限。

## 发文本 → peer
`exec`（timeout ≥ 300000）：

```bash
openclaw gateway call a2a.send --timeout 300000 --params '{"peer":"HW-PC1","message":{"text":"正文"}}'
```

成功后转告用户：文本已发送。

## 发本地文件 → peer
**必须**工具 `a2a_send_local_file`：`peer=HW-PC1`，`path=绝对路径`。
- **不要传 `name` 参数**（插件会用 path 的 basename 作为传输文件名）。
- 支持：jpg/png、txt/md/csv/json、pdf、pptx/docx/xlsx、音视频。
- 忽略 SoftBus；不要用 `a2a_send_file`；不要贴 base64。

## 收消息 / 收文件
入站会进本机 Agent；文件落在 `Docs/OPENCLAW`。回报时只复述消息里的「保存路径」。

## 禁止
SoftBus 配对话术；找不到文件就画图/下载冒充；聊天贴完整 base64；编造收件路径。
