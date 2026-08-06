# 2026-07-29-规范说明-TOOLS与Harness.md — TOOLS.md 修改前后对比与 Harness 规范说明

> 对应 OpenClaw 工作区引导文件 `TOOLS.md`（用户也称 xtool / 工具提示词）  
> 设备路径：`/data/local/.openclaw/workspace/TOOLS.md`  
> 快照：`docs/device/workspace-snapshots/TOOLS-HW-PC1.md` / `TOOLS-HW-Phone1.md`  
> 修改前备份来源：`D:\openclaw\tmp-device-cfg\TOOLS-A.md`（及设备 `TOOLS.md.bak.20260728`）

---

## 1. TOOLS.md 在 Harness 里是什么

OpenClaw 把工作区若干引导文件 **注入每轮 Agent 上下文**（system / Project Context），其中：

| 文件 | 角色 |
|------|------|
| `AGENTS.md` | 行为准则、如何做事 |
| `SOUL.md` / `IDENTITY.md` / `USER.md` | 人设与用户 |
| **`TOOLS.md`** | **本机环境速查：路径、主机、设备昵称、工具用法偏好** |
| `MEMORY.md` | 长期记忆（可选） |
| Skills/`SKILL.md` | 可共享的工具说明书 |

官方模板明确：

- Skills = **怎么用工具（共享）**  
- `TOOLS.md` = **你这台机器独有的具体信息（不共享基础设施细节）**  
- 子 Agent 仍会注入 **`AGENTS.md` + `TOOLS.md`**  
- 文件过长会被 `bootstrapMaxChars` 截断 → **必须短、可执行、无噪声**

因此改 `TOOLS.md` = 改 **Agent Harness 的运行时提示词配置**，不是改业务源码。

---

## 2. 修改前（问题形态）

修改前内容混杂：英文空模板 + 冗长 A2A 说明 + **PowerShell 示例** + 「必须自己 Base64」+ 错误默认保存路径。典型片段：

```markdown
## PowerShell 推荐方式
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("D:\path\to\report.pdf"))
$p = "{`"peer`":`"HW-Phone1`",`"message`":{`"parts`":[{`"kind`":`"file`",`"file`":{`"bytes`":`"$b64`",...
```

```markdown
所有本地文件发送前：必须转换为 Base64。
默认保存：/data/local/.openclaw/workspace
```

### 修改前导致的实际故障

| 现象 | 根因（与旧 TOOLS 的关系） |
|------|---------------------------|
| 聊天发本地文件失败 / SSRF 拒 URI | 未禁止 `a2a_send_file`（只收公网 URI）；Agent 常走错工具 |
| `E2BIG` / 残缺图 | 引导把超长 base64 塞进 `gateway call --params` / 对话，撞 ARG_MAX≈128KB 或上下文截断 |
| 设备上执行 PowerShell 失败 | 真机是 HarmonyOS，旧文档写 Windows PowerShell |
| 「没配对 / 没权限」话术 | SoftBus 与 A2A peer 混淆，TOOLS 未切开 |
| 发错图 / 自己画 SVG | 未钉死桌面/图库绝对路径，允许「找不到就造一个」 |
| 用户只看到「已处理」 | 无强制「发送完成 / 接收成功 + 完整路径」回报规则 |
| 落盘成 `.bin` | 未禁止滥用 `application/octet-stream` |

---

## 3. 修改后（现行形态）

以 PC 端快照为例（手机端结构相同，peer/路径对调）：

```markdown
# TOOLS.md — HW-PC1
本机 HarmonyOS。只用 sh/node/openclaw，禁止 PowerShell。

## 身份
| 本机 | HW-PC1 |
| 对端 peer | HW-Phone1（A2A 名，不是 SoftBus） |

## 路径
桌面 / 图库 / fixtures / 收件 绝对路径表

## 聊天窗口回报规则（必须遵守）
- 发送完成：中文「发送完成」+ peer + **本地 path 的文件名**（与 basename 一致）
- 接收成功：中文「接收成功」+ **原样复制**消息里的「保存路径」绝对路径
- 禁止改写成 `/data/local/tmp/a2a-files/`；禁止「已处理」/ 配对话术

## 发文本 → peer
openclaw gateway call a2a.send ...

## 发本地文件 → peer
必须工具 a2a_send_local_file；**不要传 name**；禁止 a2a_send_file；禁止贴 base64

## 禁止
SoftBus 配对；画图/下载冒充；滥用 octet-stream；编造收件路径
```

收件目录（现行，勿再写旧 tmp）：

| 设备 | A2A 收件 |
|------|----------|
| PC | `/storage/cloud/100/files/Docs/Download/OPENCLAW/` |
| Phone | `/storage/media/100/local/files/Docs/OPENCLAW/` |

手机端额外强调：忽略 SoftBus；图库示例路径；禁止聊天贴完整 base64。  
传输名与路径回报细节见 [`2026-08-03-改动说明-传输文件名与路径回报.md`](./2026-08-03-改动说明-传输文件名与路径回报.md)。

---

## 4. 前后对照表

| 维度 | 修改前 | 修改后 | 为何能解决问题 |
|------|--------|--------|----------------|
| OS/Shell | PowerShell | sh + node + openclaw | 与真机一致，命令可执行 |
| 发本地文件 | 手写 base64 FilePart | **强制 `a2a_send_local_file`** | 绕开 ARG_MAX；插件内读盘；对齐新源码能力 |
| `a2a_send_file` | 未区分 | **明确禁止用于本地路径** | 避免 SSRF/URI 拒收 |
| SoftBus | 易混进排障话术 | **写明 A2A≠SoftBus，禁止配对话术** | 消除「没配对」误导 |
| 路径 | 模糊 / 错误默认 workspace | **表格钉死桌面/图库/收件** | 降低找错文件、幻觉造文件 |
| 对用户话术 | 弱 | **发送完成 / 接收成功+路径** | 与源码工具文案双轨，可验收 |
| MIME | 未约束 | 禁止乱用 `octet-stream` | 减少 `.bin` 落盘 |
| 篇幅 | 很长、重复模板 | 短表格式 | 符合 bootstrap 截断预算，提高遵从率 |

---

## 5. 为什么「改 TOOLS」而不是只改源码

| 层 | 解决什么 | 不解决什么 |
|----|----------|------------|
| 插件源码（`a2a_send_local_file`、MIME 嗅探、中文工具结果） | **能不能做**、工具返回什么 | 模型仍可能不调用、乱解释 |
| `TOOLS.md` / `MEMORY.md` | **会不会做对、怎么对用户说** | 不增加传输能力 |
| 两者一起 | 能力 + 行为对齐 | 换机需重新部署 TOOLS |

本次实测验证：聊天发 tiny / 向日葵时，Agent **确实调用了 `a2a_send_local_file`**，并输出「发送完成，peer=…，文件名=…」——这正是 TOOLS 约束生效的证据。

---

## 6. 满足了哪些 Harness / OpenClaw 规范

对照官方文档与工作区约定（system-prompt / TOOLS 模板 / AGENTS 模板 / token-use）：

| 规范点 | 要求 | 本次如何满足 |
|--------|------|--------------|
| **TOOLS = 环境速查，不是长篇教程** | 放摄像头名、SSH、路径、昵称等本地信息 | 改成短表：身份、路径、命令模板、禁止项 |
| **Skills 与 TOOLS 分离** | Skills 共享 how；TOOLS 保留 yours | 不把协议长文塞进 TOOLS；传输能力在插件/Skill，用法偏好在 TOOLS |
| **Bootstrap 注入有长度上限** | `bootstrapMaxChars` / `bootstrapTotalMaxChars` | 压缩掉重复英文模板与 PowerShell 长例，降低截断风险 |
| **可执行、与运行时一致** | 提示词里的命令应能在本机跑通 | 去掉 PowerShell；写 HarmonyOS 真实路径与 `openclaw` CLI |
| **单一真源、减少幻觉** | 环境事实写死，避免模型猜 | peer 名、收件目录、桌面/图库路径表格化 |
| **安全与策略用硬约束，提示词作引导** | Safety 文案是 advisory；硬能力靠工具策略 | TOOLS 引导正确工具；真正防 SSRF/MIME/大小仍在插件 `file-security` |
| **子 Agent 仍看得到 TOOLS** | 子会话注入 AGENTS+TOOLS | 路径与发文件规则在子任务里仍可用 |
| **学到教训写回 TOOLS**（AGENTS 建议） | 踩坑后更新本地笔记 | 本次正是把「聊天发文件踩坑」固化进 TOOLS |
| **双轨：工具结果文案 + 工作区规则** | 工具返回提示 ≠ 最终对用户话术 | 源码 `【A2A 发送完成】` + TOOLS「必须转述发送完成/路径」 |
| **可观测 / 可验收** | 行为应用明确成功判据 | 「发送完成+peer+文件名」「接收成功+完整路径」可测 |

不声称满足的：TOOLS **不能**单独把中继带宽从 10MB 拉到 50MB；那是传输架构问题，需分块/直传，而不是再加提示词。

---

## 7. 与源码改动的分工（避免误解）

| 能力 | 归属 |
|------|------|
| `a2a_send_local_file` 工具存在 | **源码** |
| 默认 50MB、路径白名单、MIME/魔数 | **源码** + 设备 JSON |
| 聊天时「必须用该工具、禁止 base64/SoftBus」 | **TOOLS.md** |
| 聊天回报措辞 | **TOOLS.md** + 源码工具/入站文案 |

---

## 8. 一句话

**改前的 TOOLS 是一份过时、偏 Windows、诱导 base64 的长说明；改后的 TOOLS 是符合 OpenClaw harness 约定的短环境配置：钉死身份与路径、强制正确工具、强制可验收话术。** 它解决的是聊天路径上的「选错工具 / 说错话 / 找错文件」，与插件源码一起构成完整修复。
