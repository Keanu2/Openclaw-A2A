# MEMORY.md — HW-PC1 长期记忆

## 本机身份
- A2A 本机：`HW-PC1`
- A2A 对端 peer（一字不差）：`HW-Phone1`
- 传文件走 A2A + relay，**不需要 SoftBus 配对**

## 准确路径（务必记住）

### 电脑桌面（Desktop）
```text
/storage/media/100/local/files/Docs/Desktop/
```

### 图库 / 照片
```text
/storage/media/100/local/files/Photo/
```

### A2A 收到的文件（唯一收件目录）
```text
/storage/cloud/100/files/Docs/Download/OPENCLAW/
```
说明：文件管理器 UI 可能显示成「下载/OPENCLAW」；shell/配置用上面 cloud 路径。  
**不是** `/data/local/tmp/a2a-files/`（已废弃）。

收到文件时：聊天里报的路径必须是入站消息「保存路径」那一行，禁止改写。

## 发文件规则
- 本地文件必须用工具 **`a2a_send_local_file`**（peer=`HW-Phone1`，path=绝对路径）
- **不要传 name**；传输文件名 = path 的 basename，对端按同名保存
- 不要用 `a2a_send_file`（那是公网 URI）
- 不要说「没有配对设备 / 没权限」
