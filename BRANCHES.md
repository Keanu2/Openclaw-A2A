# 分支、Tag、Release 怎么读

先记住三句话：

1. **日常只看 `main`。** 那就是当前代码。
2. **旧版本看 tag**（名字不会丢）。不要靠 `feature/*` 草稿分支记版本。
3. **要在旧代码上开发：从 tag 新建一条分支**，不要改 tag 本身。

`分支` 会往前走；`tag` 钉死某一次提交。所以「哪次提交 = 哪一版」以 tag 为准。

---

## 版本 → 提交（以后回旧代码看这里）

| 版本 | 永久名字 | 提交 | 网页上看代码 |
|------|----------|------|----------------|
| **1.6.2**（当前推荐） | tag `a2a-1.6.2` | `a81ef87` | https://github.com/Keanu2/Openclaw-A2A/tree/a2a-1.6.2 |
| **1.6.1**（含 1.6.0） | tag `a2a-1.6.1` | `5b65213` | https://github.com/Keanu2/Openclaw-A2A/tree/a2a-1.6.1 |
| **1.4.3** 安装包冻结点 | tag `a2a-1.4.3` | `241edd6` | https://github.com/Keanu2/Openclaw-A2A/tree/a2a-1.4.3 |
| 升级前的旧 `main` | 分支 `archive/main-pre-1.6.2` | `31f37cf` | https://github.com/Keanu2/Openclaw-A2A/tree/archive/main-pre-1.6.2 |
| 1.5.1 / 1.5.2 说明 | 私有仓已归档 Release | — | [v1.5.1](https://github.com/Keanu2/Openclaw-A2A-private/releases/tag/v1.5.1-file-transfer) / [v1.5.2](https://github.com/Keanu2/Openclaw-A2A-private/releases/tag/v1.5.2-tcp-device-fix) |

`main` 会继续往前（文档、下个版本）。**某一版的代码以同名 tag 为准**，不要用「当时的 main」当版本号。

---

## 为什么删了 `feature/*`，旧代码还在

删的是**草稿分支的名字**，不是提交，也不是 tag。

| 当时的草稿名 | 它其实是什么 | 现在用什么代替 |
|--------------|--------------|----------------|
| `feature/file-transfer-1.6.2` | 合入 `main` 的 PR 分支 | tag `a2a-1.6.2`（`a81ef87`） |
| `feature/file-transfer-1.6.1` | 1.6.0/1.6.1 发布提交 | tag `a2a-1.6.1`（`5b65213`） |
| `feature/file-transfer-1.6.0` | 1.6.0 中途稿（后来打进 1.6.1） | 看 `a2a-1.6.1`，不要单独找 1.6.0 草稿 |
| `feature/a2a-tcp-file-stream-v1` | 最早 TCP 线 | 已在 `main` 历史里；产品钉是后面的 1.5/1.6 tag |

那些 `feature/*` **不是**版本目录。同一条 feature 分支被推过多次，尖上的提交会变；tag 不会变。

---

## 要在旧代码上开发（不要改 tag）

在 `D:\openclaw\Openclaw-A2A`：

```powershell
git fetch origin --tags
git switch main

# 从某一版钉开一条新维修线（名字自定）
git switch -c hotfix/1.4.3-说明 a2a-1.4.3
# 或
git switch -c hotfix/1.6.1-说明 a2a-1.6.1
# 或
git switch -c hotfix/1.6.2-说明 a2a-1.6.2

git push -u origin HEAD
```

做完回日常：`git switch main`。

不要：`git switch archive/main-pre-1.6.2` 然后直接改（那是只读快照）。要旧安装包线，从 `a2a-1.4.3` 开新分支。

---

## 日常入口

| 名字 | 类型 | 干什么 |
|------|------|--------|
| [`main`](https://github.com/Keanu2/Openclaw-A2A/tree/main) | 默认分支 | **当前推荐线。** 现在等于插件 **1.6.2** 再加之后的文档。新功能往这里合。 |
| [`a2a-1.6.2`](https://github.com/Keanu2/Openclaw-A2A/releases/tag/a2a-1.6.2) | tag + Release | **1.6.2 代码钉。** |

---

## 已归档的私有镜像 [Openclaw-A2A-private](https://github.com/Keanu2/Openclaw-A2A-private)

**不要再当工作仓。** 已 GitHub Archive。只留 1.5.x Release 备查。

---

## 旁边几个仓怎么钉（不要混进本仓 tag）

插件、注册中心、QUIC 是三个仓库。本仓的 `a2a-*` tag **不管** 注册中心版本。

| 仓 | 当前看哪 |
|----|----------|
| 本仓库 | 上面这张表；日常 `main` / tag `a2a-1.6.2` |
| [agent-registry-relay](https://github.com/Keanu2/agent-registry-relay) | [`TAGS.md`](https://github.com/Keanu2/agent-registry-relay/blob/main/TAGS.md)；当前钉 `live-edge-2026-09-08` |
| [a2a-raw-quic-stream](https://github.com/Keanu2/a2a-raw-quic-stream) | tag `v7-2026-09-02`（1.6.x 线协议未改） |

现网边车 `121.37.53.35` 的注册中心已改为本仓 clone：`/home/edge/apps/agent-registry-relay`（systemd `agentregistry`，venv `agentregistry-venv-github`）。旧目录 `/home/edge/apps/agent-protocol/AgentRegistry` 和旧 venv 仍留着回滚。QUIC `8008` 由用户 systemd `quiche-raw-relay-v7` 拉起（`linger=yes`）。

---

要代码日常：`main`。要「那一版长什么样」：上表的 **tag**。要在那一版上改：从 tag **新建分支**。
