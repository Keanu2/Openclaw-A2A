# 分支、Tag、Release 怎么读

先记住三句话：

1. **日常只看 `main`。** 那就是当前代码。
2. **版本号看 tag / GitHub Release**（`a2a-1.6.2`、`a2a-1.4.3`）。
3. **其它分支都是历史或开发中途，不要当「当前产品」。**

`分支` ≠ `版本`。分支会动；tag 钉死某一个提交。

---

## 日常入口

| 名字 | 类型 | 干什么 |
|------|------|--------|
| [`main`](https://github.com/Keanu2/Openclaw-A2A/tree/main) | 默认分支 | **当前推荐线。** 现在等于插件 **1.6.2**。以后新功能也往这里合。 |
| [`a2a-1.6.2`](https://github.com/Keanu2/Openclaw-A2A/releases/tag/a2a-1.6.2) | tag + Release | **当前版本钉。** 「1.6.2 是哪次提交、说明在哪」看这个。 |

---

## 旧版本（不要和 `main` 搞混）

| 名字 | 类型 | 干什么 |
|------|------|--------|
| [`a2a-1.4.3`](https://github.com/Keanu2/Openclaw-A2A/releases/tag/a2a-1.4.3) | tag + Release | **1.4.3 产品版本钉。** 旧定制安装包/插件冻结点。要「当年发的 1.4.3 是什么」看这个。 |
| [`archive/main-pre-1.6.2`](https://github.com/Keanu2/Openclaw-A2A/tree/archive/main-pre-1.6.2) | 只读分支 | **把 `main` 改成 1.6.2 之前，默认分支的最后样子。** 比 `a2a-1.4.3` 多一笔后来加的仓库地图文档。只用来对照旧 `main`，**不要基于它开发。** |

关系：

```text
tag a2a-1.4.3          1.4.3 冻结点
        │
        │  + 一笔 README（相关仓库地图）
        ▼
archive/main-pre-1.6.2   升级前的旧 main
        │
        │  + 整段 1.5 / 1.6 文件传输
        ▼
main / tag a2a-1.6.2     现在的推荐线
```

---

## 已删掉的开发草稿分支

这些 `feature/*` 已从公开仓删除，**不影响回档**。内容早在 `main` / tag 里。

曾存在：`feature/file-transfer-1.6.0`、`1.6.1`、`1.6.2`，以及 `feature/a2a-tcp-file-stream-v1`。

---

## 已归档的私有镜像 [Openclaw-A2A-private](https://github.com/Keanu2/Openclaw-A2A-private)

**不要再当工作仓。** 已 GitHub Archive（只读）。和公开仓曾是同一棵树；现在只为保留 1.5.x Release。

| 名字 | 干什么 |
|------|--------|
| `v1.5.1-file-transfer` | 1.5.1 文件传输第一次验收线（只读 Release） |
| `v1.5.2-tcp-device-fix` | TCP 真机加固（只读 Release） |
| `main` / `release/1.6.2` | 归档瞬间与公开仓同 tip，**不要再推** |
| `release/1.6.1` | 1.6.1 发布时的钉 |

---

## Tag / Release 一览

| Tag / Release | 仓库 | 含义 |
|---------------|------|------|
| `a2a-1.6.2` | 公开 | 当前推荐版本 |
| `a2a-1.4.3` | 公开 | 旧安装包基线 |
| `v1.5.1-file-transfer` | 已归档私有仓 | 1.5.1 文件传输第一次验收线 |
| `v1.5.2-tcp-device-fix` | 已归档私有仓 | TCP 真机加固 |

---

## 不要用这些当「当前」

- 任意已删除的 `feature/*`、私有仓上的 `release/1.6.1`
- `archive/*`（只读历史）
- 本地未推送的 `wip/*`（只是某次对齐前的临时保存）

要代码：`main`。要版本说明：对应的 **GitHub Release**。
