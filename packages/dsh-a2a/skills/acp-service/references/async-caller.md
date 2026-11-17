# Codex 主会话：现稿 PPT 只验收与计步

`scripts/a2a-caller.py` 专用于现稿 PPT 的独立只验收测试：需要冻结产物摘要、制作会话、验收报告及 Codex 主会话 transcript，结论固定为保留原稿和问题报告，不接受或改写原 PPT。普通角色、临时任务和完整 PPT 制作/交付按 [统一 API 路由](roles-and-tasks.md) 调用；这些任务遵守同样的异步边界，但不使用本脚本的 PPT 专属字段或结论。

此入口落实“开发部署先完成 → 一次派单 → 立即结束本轮 → 真实通知唤醒 → 回执/结论/ack”。网关后台核对可以继续；主会话不主动 get/list/inbox、等待、读子会话日志或重复产物验收。它不是全局禁用查询 API 的权限系统；明确的单次状态请求和排障应单独授权、单独记录。

使用本技能 `scripts/a2a-caller.py`，Python 3 标准库即可。当前计步器读取 **Codex 主会话自己的**原生 transcript，只读取工具 ID、通知与轮次边界，不输出推理、不读取任何子会话。其他宿主应遵守同一交接纪律，但不能套用 Codex 记录格式宣称计步通过。

## 开发部署阶段

技能、目标、绑定、执行宿主、输入冻结、网络预检、部署测试、合同与目录都在正式派单前完成。不得派单后继续开发或部署并将这些步骤从统计中删除。不要用主会话等待函数代替结束轮次。

一次性准备私有 RUN.json（路径和值必须来自真实环境）：

```json
{
  "phase": "prepared",
  "developmentReady": {"sourceCommit": "实际代码版本", "deploymentReceipt": "/absolute/receipt.json"},
  "gatewayUrl": "http://127.0.0.1:36814",
  "originSessionId": "原主会话归属ID",
  "rootTranscript": "/absolute/current-root-rollout.jsonl",
  "request": {
    "targetId": "已登记的独立验收目标",
    "title": "现稿只验收",
    "clientRequestId": "本次稳定请求编号",
    "input": {"prompt": "自包含合同与边界，报告保存到本轮独立目录", "preflight": {"jobDirectory": "/absolute/new-job"}, "resultContract": {"jobId": "本次关联编号", "artifactManifestPath": "/absolute/new-job/report-manifest.json"}}
  },
  "review": {
    "reportPath": "/absolute/new-job/review-report.json",
    "artifactDigest": "冻结的原PPT产物清单SHA256",
    "producerSessionId": "原制作会话ID",
    "links": [{"title": "现稿PPT", "url": "http://actual-host/existing.pptx"}, {"title": "预览", "url": "http://actual-host/preview.png"}]
  }
}
```

报告契约为 `verdict: passed|changes_requested`、`artifactDigest`、`factsChecked`、`allSlidesViewed`、`issues`、`limitations`、`evidence`。由独立验收 Agent 自己核验事实、实际读图、检查冻结原文件未变，报告加入本轮宿主验证的 artifact manifest。旧 PPT 不移动、不重导出；manifest 只登记本轮新报告。报告与任务完成不自动代表 PPT 业务接受。

## 正式调用：预期四次主会话工具调用

1. `python3 SKILL/scripts/a2a-caller.py dispatch --run RUN.json`。入口保存当前原生调用 ID，再执行一次 execution_submit；返回 mustEndTurn=true 后**立即 final 结束本轮**，仅说明已派单、等待通知。不能为了取状态、等完成、验证模型、检查日志或统计步骤再调用工具。受理不确定也落盘并结束，不自动重派。
2. 真实任务通知到达后的新轮次：`... inspect --run RUN.json --notice-id 实际NOTICE`。入口必须在本主会话派单后的 user message 中找到匹配的 origin 与 job/task；否则拒绝查询。仅调用一次 execution_get，核对宿主 producer、task/session、报告摘要和冻结 PPT 版本，读取本轮新报告；不读 PPT/PNG、不重新 HTTP/hash/读图、不读子日志。
3. `... record --run RUN.json`。按本次“不改稿、只验收”合同，保存结论和问题，不重派、不记录原 PPT 业务通过。只有真实完成且有版本/digest 的业务接受合同才使用 execution_review；本入口不伪造不存在的接受记录。
4. `... ack --run RUN.json`。确认实际通知；同一操作统计派单至当前调用的全部唯一主会话工具 ID，包含等待、调试和额外调用，不重置窗口；然后立即 final 答复用户，不再单独查 inbox、审计或提交文档。

每次命令对应一次主会话工具调用，不等于底层 RPC/文件操作数。若工具传输需要等待同一尚未返回的调用，该等待也照实计步，不能删除。步骤数、派单后无额外操作、真实通知与此前已结束轮次必须同时通过，不能只挑四个业务操作证明达标。`step-count.json` 与 `processing-conclusion.json` 自动保存在 RUN.json 同目录。

开发部署成本另计，不混入日常测试。质量不通过如实写 changes_requested；即使调用步数达标，也不能据此宣称 PPT 已通过。异常回传后不继续循环处理。脚本失败或收到重复旧通知时沿用已有持久记录，不重置请求、窗口或原结论。
