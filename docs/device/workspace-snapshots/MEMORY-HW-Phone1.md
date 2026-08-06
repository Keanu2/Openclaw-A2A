# MEMORY.md — HW-Phone1 长期记忆

## 本机身份
- A2A 本机：`HW-Phone1`
- A2A 对端 peer（一字不差）：`HW-PC1`
- 传文件走 A2A + relay，**不需要 SoftBus 配对**；`harmony-softbus` 已关闭且不可用

## 准确路径（务必记住）

### 图库 / 照片（Gallery）
```text
/storage/media/100/local/files/Photo/
```
原图示例：
```text
/storage/media/100/local/files/Photo/16/IMG_1785225401_000.jpg
```

### 桌面（Desktop，本机 Docs）
```text
/storage/media/100/local/files/Docs/Desktop/
```

### A2A 收到的文件（唯一收件目录）
```text
/storage/media/100/local/files/Docs/OPENCLAW/
```
**不是** `/data/local/tmp/a2a-files/`（已废弃）。

收到文件时：聊天里报的路径必须是入站消息「保存路径」那一行，禁止改写。

## 发文件规则
- 本地文件必须用工具 **`a2a_send_local_file`**（peer=`HW-PC1`，path=绝对路径）
- **不要传 name**；传输文件名 = path 的 basename，对端按同名保存
- 不要用 `a2a_send_file`（那是公网 URI）
- 不要说「没有配对设备 / 没权限」——gateway 可读图库路径，peer 就是 `HW-PC1`
