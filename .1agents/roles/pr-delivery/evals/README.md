# pr-delivery L3 黄金 CR 基准

用本仓已经合并的 PR #11–#14 衡量一次 CR 提示词或模型路由改动的召回和误报。负样本是异模型 CR 当时拦住的提交，正样本是修复后签字通过的下一提交。打分读的是审查报告，不重新实现缺陷检测。

`manifest.json` 的 `schemaVersion` 固定为 1，`roleId` 必须等于同目录 `profile.json` 的 `id`。提交写 7–40 位十六进制 SHA。`baseCommit` 必须是 `headCommit` 的祖先。

## 样本

| id | PR | 种类 | 范围 | 期望 |
| --- | --- | --- | --- | --- |
| `pr11-neg-non-atomic-notify` | 11 | 负 | `69c136b5` → `cc1b0ac3` | `CHANGES_REQUESTED` |
| `pr11-pos-atomic-notify` | 11 | 正 | `cc1b0ac3` → `46153655` | `PASS` |
| `pr12-neg-sandbox-and-inherit` | 12 | 负 | `dc53c181` → `57df97e6` | `CHANGES_REQUESTED` |
| `pr12-neg-worktree-abs-path` | 12 | 负 | `57df97e6` → `4c282757` | `CHANGES_REQUESTED` |
| `pr12-pos-relpath-fix` | 12 | 正 | `4c282757` → `3e01f7a2` | `PASS` |
| `pr13-neg-schema-symlink-ignore` | 13 | 负 | `a9cc0d57` → `8bf5c0cf` | `CHANGES_REQUESTED` |
| `pr13-pos-projection-hardened` | 13 | 正 | `8bf5c0cf` → `83b32e48` | `PASS` |
| `pr14-neg-forged-git-and-config` | 14 | 负 | `23bb0d37` → `e648d09b` | `CHANGES_REQUESTED` |
| `pr14-pos-verified-worktree-fix` | 14 | 正 | `e648d09b` → `9bda36fe` | `PASS` |

负样本的 `requiredDefects` 每条有 `anyFilePatterns` 和 `anyTextPatterns`。二者都是大小写不敏感的字面量子串，不是正则。一条 MUST 要同时命中至少一个文件子串和至少一个文本子串，才算命中该缺陷。文件名写在 `file`、正文或 `evidence` 里都可以。

## 口径

- 负样本通过：结论是 `CHANGES_REQUESTED`，且该样本每一条 `requiredDefects` 都被至少一条 MUST 命中。
- 正样本通过：结论是 `PASS`，且 MUST 为空。`SHOULD` 不计误报。
- `negativeRecall` = 通过的负样本 / 负样本数。`defectRecall` = 命中的缺陷 / 缺陷总数。
- `falsePositiveRate` = 未通过的正样本 / 正样本数。正样本给出 `CHANGES_REQUESTED`，或给出 `PASS` 但 MUST 非空，都算 1 条误报。
- 缺样本记入 `missingCases`，整套不通过。重复 `caseId`、未知 `caseId`、以及 Markdown 里提不出唯一的 `PASS` 或 `CHANGES_REQUESTED`，直接失败，不把缺结论当成通过。

`promotionReady` 还要求负样本和正样本都至少有 1 个。因此空清单不能晋升。

## trial → formal

晋升门槛是 `promotionReady === true`：负样本 100% 召回（`negativeRecall === 1`，因而每条必检缺陷都被命中），正样本 0% 误报（`falsePositiveRate === 0`）。只做清单和 git 历史校验时不声明晋升。

## 命令

在仓库根执行。`--repo` 可省略，此时从 `--role` 向上找最近的 `.git`。

```sh
node --import tsx packages/service/bin/acp-service.ts rsi eval-cr \
  --role .1agents/roles/pr-delivery --repo . --json

node .1agents/roles/pr-delivery/checks/run-l3-eval.mjs \
  --role-dir .1agents/roles/pr-delivery --repo . --json
```

带 `--results` 时读取 JSON 数组，或 `{ "results": [...] }`。每项可以是结构化结果 `{ caseId, verdict, must }`，也可以是 `{ caseId, markdown }`。未通过时退出码为 1。

`evalDigest` 是 `evals/manifest.json`、`QA.md`、`checklist.json` 以及存在的 `routing.json` 按路径排序后的 SHA-256。评估报告要带上它，避免拿旧清单的分数去放行新提示词。
