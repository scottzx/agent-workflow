# 仓库知识层（`docs/solutions/`）

本目录是本仓库的统一结构化经验与避坑知识层（对应架构 `A5` 知识层），供开工前检索节点 `learnings_lookup` 与人工排障复用，避免同类缺陷在多个 PR 或角色迭代中反复复发。

## 目录结构

```text
docs/solutions/
├── README.md                  # 本约定说明（不作为知识条目索引）
├── <module>/<slug>.md         # 经验卡片（YAML frontmatter + 正文）
├── rejected-edits.jsonl       # 正文只追加不回滚的失败教训 / 退化记录
├── backlog.jsonl              # 持久化演进优化清单（待排期改造项，不进入 learnings_lookup 约束召回）
└── index-meta.json            # 可选：索引元数据（如将历史条目标记为 stale）
```

## 经验卡片 Frontmatter 约定

每个 `docs/solutions/<module>/<slug>.md` 顶部必须声明 YAML frontmatter：

```yaml
---
module: packages/service/src/rsi
tags: [rsi, l1-gate, worktree]
problem_type: regression
status: active
source: PR #25 CR-M1
paths:
  - packages/service/src/rsi/
---
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `module` | 是 | 所属模块路径或逻辑域（如 `scripts/local-deployment`、`packages/service/src/rsi`） |
| `tags` | 是 | 关键词列表，用于路径与主题匹配 |
| `problem_type` | 是 | 问题类别（如 `regression`、`security`、`compatibility`、`performance`、`governance`） |
| `status` | 是 | `active` 或 `stale`；`stale` 条目不会在开工检索中被召回 |
| `source` | 是 | 证据来源（如 PR 编号、CR 意见编号、线上故障记录） |
| `paths` | 否 | 适用的仓库相对路径前缀列表；省略时按 `module` 参与匹配 |

## `rejected-edits.jsonl` 只追加约束

- `rejected-edits.jsonl` 按行存储被拒绝、打回或回滚的改动教训（每行一条独立 JSON，包含 `id`、`module`、`tags`、`problem_type`、`rule`、`source`、`createdAt` 以及可选 `paths`）。
- **正文只追加，不回滚、不原地删除**：哪怕某次角色改动因回归被不对称回滚，`rejected-edits.jsonl` 里的历史正文也必须完整保留。
- **标记过时仅改索引元数据**：当一条历史约束不再适用时，通过 `markKnowledgeStale` 写入 `docs/solutions/index-meta.json`（记录 `status: "stale"`、`reason`、`updatedAt`），绝不改写或截断 `rejected-edits.jsonl` 原文。

## `backlog.jsonl` 演进优化清单约定

- `backlog.jsonl` 按行持久化跨会话待排期的系统改造与程序化硬锁优化项（每行一条独立 JSON，包含 `id`、`title`、`kind`、`layer`、`priority`、`status`、`source`、`createdAt`、`acceptance` 以及可选 `linkedPr`）。
- 与经验卡片（活跃避坑约束）严格分离：`compileKnowledgeIndex` / `learnings_lookup` **不索引** `backlog.jsonl`，避免把尚未实现的待办需求误召回为开工约束。
- 对应 PR 合入 `main` 后将条目标记为 `status: "done"` 并记录 `linkedPr`，同时把新固化的约束沉淀为经验卡片或 L1 检查。

## 开工前检索

在开始修改目标文件前，总管或执行者可调用 CLI 检索最多 3 条高相关活跃约束：

```sh
acp-service rsi lookup --paths packages/service/src/rsi/outline-run.ts,packages/service/src/execution/ticket.ts --json
```

在工作流引擎（`workflow.json`）中，前置节点 `learnings_lookup`（`type: "learnings_lookup"`）位于 `implement` 之前，召回结果上限固定为 3 条，避免向执行者注入长篇噪声。
