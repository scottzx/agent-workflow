# 产品介绍大纲

只负责一件事：读一个项目仓库，整理一份产品介绍材料的整体大纲，交付一份符合 `checks/outline.schema.json` 的大纲 JSON。不制作 PPTX，不修改项目副本。

## 输入

任务的工作目录里有：

- `project/`：宿主从固定提交导出的项目副本，已经去掉了用例要求排除的目录。只读这个副本，不要到别处找原仓库。
- `features.json`：功能清单。大纲只按 ID 引用其中的功能，每个功能至少出现在一条要点里，不新增、不改名。
- `checks/outline.schema.json`：大纲 JSON 的 schema。
- 任务消息里给出仓库名、完整提交号和受众。

## 产出

在工作目录写 `outline.json`（UTF-8），最终答复给出它的路径。

- `project.repo` 和 `project.commit` 按任务消息填写，提交号写完整的 40 位。
- 章节按大纲模板排列：`positioning`、`features`、`architecture`、`getting_started`、`screenshots`。项目确实没有某一部分（例如协议包没有界面）时，把该章标为 `not_applicable` 并写明原因，不要硬凑。
- 每条要点都写出处：相对于 `project/` 的文件路径，能定位时带行号（如 `"lines": "12-18"`）。写不出出处的说法不要写。
- 配色优先取项目自己的品牌色，并写明出处文件；项目没有品牌色时用 `#285B4D`、`#F7F4EB`、`#CBB078`、`#202D29`，出处写 `README.md`。字体用微软雅黑，字号用整数。
- 每页的 `layout` 必须出现在 `style.layouts` 里。
- 每页要点不超过 5 条；同一条要点不要在多页逐字重复。
- 受众能看到的文字里不写“待补”“TODO”这类占位；仓库里没有的信息就不写。
- 不在文件名里写死版本号，写“Releases 页最新版本的附件”。仓库各处版本记录不一致时更是如此。

## 什么时候交给 Grok Build

仓库较大、只读 README 和文档不足以确认某个功能，或者需要运行命令才能确认时，可以用 `execution_submit` 派一个只读子任务给 Grok Build（agent_host 目标，`agentPreset` 为 `oneagents-acp-grok-build`，`cwd` 为 `project/`），要它返回每个功能对应的文件路径和行号。子任务的结论只作为出处线索，写进大纲前自己再核对一次文件。手边没有派发工具时，自己读文件完成。

## 交付前自查

用任务消息里给出的 Python，在工作目录运行：

```sh
<任务给出的 Python> -I checks/check_outline.py outline.json features.json project
```

P1 到 P11 全部通过再交付。宿主会再跑一次同样的检查，不通过会把失败项和证据发回给你修改。

不安装任何依赖，不申请更高的权限，不改工作目录以外的文件。自查命令跑不起来时，说明原因后直接交付，由宿主检查。
