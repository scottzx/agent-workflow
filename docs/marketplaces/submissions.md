# DSH marketplace submissions

Updated: **2026-10-11 19:09 Asia/Shanghai**. Submission does not mean acceptance or public availability.

The repository is now [scottzx/agent-workflow](https://github.com/scottzx/agent-workflow). Links below are the 2026-10-09 submission record and still name `scottzx/1acp`, the repository that was submitted. Receipts and evidence files are unchanged.

Public package: **`@1agents/acp-service@0.6.0`**. Source package: [`packages/service`](../../packages/service). The repository root and `packages/dsh-plugin` are private development modules, not the advertised installation targets.

## Published materials

- Repository topics: `dsh-plugin`, `deepseek-harness`, `acp`, `a2a`.
- About description, user installation guides, prerequisites and two real screenshots published in commit [`3275792`](https://github.com/scottzx/1acp/commit/327579286420ffc3e152e3e6ce006375daec4c42).
- [Release 0.6.0](https://github.com/scottzx/1acp/releases/tag/acp-service-v0.6.0), pinned to published source `5e3fb147f185c083e51b21d6497752cba55a60c8`.
- [Release tarball](https://github.com/scottzx/1acp/releases/download/acp-service-v0.6.0/1agents-acp-service-0.6.0.tgz) is identical to npm, with `SHA256SUMS` attached. SHA-256: `c9092fd7bd29f18beebfe38e58105b671bb7166bddc6795825feac885249bee1`.
- [Installation and loading verification](verification-2026-10-09.md): 32 installed-artifact tests and the real DSH profile/Loader/browser/service lifecycle smoke passed; a separate fresh interactive profile loaded the plugin and connected to native Codex capabilities.

## Submission status

| Channel | Submission / receipt | Current status | Remaining acceptance check |
| --- | --- | --- | --- |
| Canonical awesome → dsh-market | [PR #6950](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/6950) | Open, both official CI checks passed; not merged or listed at the 2026-10-10 12:04 check | Wait for merge/feed refresh; search, inspect install target, install/load in a fresh profile |
| DSH Marketplace | [Form](https://dshmarketplace.dev/submit), [receipt JSON](evidence/1acp-marketplace-receipt-20261009T155356Z.json), [screenshot](evidence/1acp-marketplace-receipt-20261009T155356Z.png) | **Received**, 2026-10-09 23:53:56 Asia/Shanghai; HTTP 200, `ok=true`, `duplicate=false`; manual review pending | Await review, then check the public package name, install target and fresh-profile loading |
| DSH Plugin Store | [Form](https://dshpluginstore.com/submit), [receipt](evidence/1acp-pluginstore-receipt-20261009.png) | **Received**, 2026-10-09 17:52 Asia/Shanghai; manual review pending, no submission ID | Search after acceptance, verify npm name and fresh-profile install/load |
| DSH STORE | [Submission #1345](https://github.com/AI-Scarlett/DSH-Store/issues/1345) | [Precheck failed](https://github.com/AI-Scarlett/DSH-Store/actions/runs/37914061906): `SUBMISSION_SOURCE_HTTP`, HTTP 404 for the generated patch; security scan did not run. [Exact failure and artifact compatibility follow-up](https://github.com/AI-Scarlett/DSH-Store/issues/1345#issuecomment-6078641824) posted | Obtain a supported artifact validation route; do not advertise unbuilt GitHub installation |
| dsplugin | [Submission #333](https://github.com/vbarter/dsh-plugin-registry/issues/333), [bot PR #334](https://github.com/vbarter/dsh-plugin-registry/pull/334), [correction PR #335](https://github.com/vbarter/dsh-plugin-registry/pull/335) | Actual metadata fix submitted against `submission/333`: correct public package, subpath and npm install target; honest `not_validated` / `not_checked` / `not_tested` states retained | Merge correction #335 before bot PR #334; then verify the resulting public entry and fresh installation |
| dsh.pub | [Compatibility request #131](https://github.com/dsh-pub/dsh-pub/issues/131) | **Not a plugin submission**: requested monorepo + npm/Release support | Wait for a supported contract, then submit and validate |

Plugin Store search before submission returned zero matches for `1acp` ([evidence](evidence/1acp-pluginstore-search-before-20261009.png)). The initial canonical public feed also had no entry. No channel has yet been recorded as passing public-listing acceptance.

## Source-validation compatibility

The actual sources are committed, while release builds embed generated JavaScript and the bundle patch into the npm artifact:

| Published surface | Committed source |
| --- | --- |
| Public package manifest | `packages/service/package.json` |
| Public runtime entry | `packages/service/src/package.ts` |
| DSH bundle patch | `packages/dsh-plugin/cordis.patch.yml` |
| DSH host plugin | `packages/dsh-plugin/src/index.ts` |
| DSH browser entry | `packages/dsh-plugin/src/client.js` |
| Build mapping | `scripts/embed-dsh.mjs`, `scripts/embed-runtime.mjs`, `scripts/release-artifacts.mjs` |
| Component MIT licenses | `packages/runtime/LICENSE`, `packages/dsh-plugin/LICENSE` |

DSH STORE supports a subpackage path but expects the generated manifest paths to exist in Git. dsplugin currently discovers only the root manifest; its existing schema supports a custom install string, so PR #335 concretely fixes this entry's metadata and npm target without claiming registry validation. Full and lite catalogs were regenerated and checked to change only the target entry. dsh.pub's public submission JSON permits only `repository` and `schemaVersion`, forces the root directory, and requires committed runtime/browser/patch files. Thus adding topics alone cannot complete these three routes. Source-validation support and acceptance remain **pending**.

## Acceptance procedure

After each channel accepts or publishes the entry:

1. Search for `1acp` and `@1agents/acp-service` in its actual public catalog. Record the public detail URL and date.
2. Verify repository/subpath, package name and the advertised installation command. Prefer npm; the pinned Release tarball is the fallback. Report any command that points at the private workspace root or unbuilt GitHub sources.
3. Create a separate temporary `DSH_HOME`, `ACP_STATE_DIR` and fresh profile for that channel. Install exactly the advertised target, address only the specific pnpm script prompt if present, and confirm the bundle is enabled.
4. Check profile patch loading, Cordis/plugin activation, browser registration, service health and shutdown. Native capability discovery is separate from a paid model turn or proof of every Agent's credentials.
5. Mark that channel accepted only with evidence for search, correct install target and fresh-profile loading. Keep unmerged PRs, review queues, failed prechecks and compatibility requests explicitly pending.

An active thread follow-up checks every six hours. It stays quiet while nothing changes and reports acceptance, actionable maintainer feedback, a failure requiring action, or completed verification. Avoid duplicate submissions and repeated rate-limited requests.

## Follow-up — 2026-10-09 23:56 Asia/Shanghai

The Marketplace rate limit cleared. This heartbeat performed one repository inspection and one normal form submission. The page confirms `scottzx/1acp is queued for review`. Notes explicitly identify `@1agents/acp-service@0.6.0`, `packages/service`, and the pinned Release tarball; they tell reviewers not to advertise the private root or unbuilt GitHub installation. GitHub's repository-level licence field remains null; the note points to the existing component licences instead of claiming a root licence.

Both official canonical CI checks are successful. PR6950, dsplugin PR334 and PR335 remain open; the correction still has to reach `submission/333` before the bot PR is merged. No maintainer feedback or new source-contract support was received. Source validation blockers remain unchanged.

Current exact-repository Marketplace search returns zero plugins; Plugin Store's complete 79-entry server-rendered directory has no exact identity. Canonical, STORE, dsplugin and dsh.pub public catalogs also have no exact repository/npm identity. No channel-specific acceptance profile was started. Existing artifact smoke evidence remains separate.

Current structured state is in [ledger.json](ledger.json). Evidence paths beginning with `/Users/scott/` identify local follow-up records on the operator's machine; they are not public URLs. Public submission links and the receipt attachments above are accessible separately. Historical rate-limit evidence and the original application URLs are retained. The active six-hour follow-up now treats the Marketplace form as received and will not submit it again.

## Follow-up — 2026-10-10 06:03 Asia/Shanghai

No exact `scottzx/1acp` / `@1agents/acp-service` entry was found in the canonical feed, Marketplace, Plugin Store, STORE, dsplugin or dsh.pub catalogs. Existing GitHub requests and PRs remain open with no new feedback; both canonical CI checks remain successful. Marketplace and Plugin Store receipts remain valid and neither form was inspected or resubmitted. No 1acp market acceptance profile was started.

The current STORE source contract changed only its response-size bridge and legacy assurance handling; its Git-source precheck and dsh.pub parser still do not add the required npm/Release artifact route. The source compatibility blockers therefore remain pending. The existing correction #335 must still reach `submission/333` before #334 is merged; no maintainer PR was merged by this task.

The parallel session-reader follow-up found a dsplugin automatic-discovery entry and completed a separate market-specific acceptance; this does not establish 1acp compatibility or acceptance. Structured observations, source diffs and the separate reader evidence are in the [heartbeat report](/Users/scott/.agents/skills/dsh-marketplace-publish-workspace/heartbeat-20261009T215058Z/report.md). Original receipts and earlier evidence remain preserved in this ledger and its history.

## Follow-up — 2026-10-10 12:04 Asia/Shanghai

No exact installable 1acp entry is present in the checked public catalogs. All existing requests and PRs remain open, both canonical CI checks remain successful, and no new maintainer feedback arrived. No form was inspected or resubmitted, no maintainer PR was merged, and no 1acp acceptance profile was started.

The dsh.pub topic scanner newly records `rejected / missing_bundle_manifest` for the repository root, at commit `4cb26e0934c295953ae6faedfc10e0f868fc2316`: root package.json does not declare dsh.bundle.patch. This is an automatic source scan reflecting the already documented root-only compatibility blocker, not a rejection of the open compatibility request #131 and not an installable entry. STORE precheck/catalog and dsh.pub parser sources are byte-identical to the prior heartbeat; no npm/Release route was added.

session-reader separately completed its new Marketplace npm-route acceptance and retains its previous dsplugin acceptance; neither is counted for 1acp. Original form receipts and #335-before-#334 dependency remain intact. See the [current heartbeat report](/Users/scott/.agents/skills/dsh-marketplace-publish-workspace/heartbeat-20261010T035154Z/report.md) and [ledger](ledger.json).


<!-- heartbeat-20261011T100845Z-final -->
## 2026-10-11续跑

本轮公开目录尚未发现1acp精确身份；canonicalPR6950、STORE1345、dsplugin333/334/335仍待审，原两个表单回执保留且未重复投稿。dsplugin仍须维护者先合并335修正再合并334，agent不代为合并。

dsh.pub Issue131出现[维护者反馈](https://github.com/dsh-pub/dsh-pub/issues/131#issuecomment-6103964957)：计划支持bounded directory、verified npm/Release产物、静态校验及真实安装器使用验证产物；尚无实现或时间承诺。已[回复](https://github.com/dsh-pub/dsh-pub/issues/131#issuecomment-6107952113)，提供公开@1agents/acp-service@0.6.0/packages/service及feature-blueprint0.4.1的固定fixture，确认精确npm为主、同字节固定Release为可审计兜底，并承诺在可测试分支做全新profile验收。保持“待兼容”，不把计划当作支持完成。STORE/pub固定核心代码检查均未出现artifact安装实现。

本轮证据：/Users/scott/.agents/skills/dsh-marketplace-publish-workspace/heartbeat-20261011T100845Z/github-status/summary.json、/Users/scott/.agents/skills/dsh-marketplace-publish-workspace/heartbeat-20261011T100845Z/catalog-status/acp-summary.json、/Users/scott/.agents/skills/dsh-marketplace-publish-workspace/heartbeat-20261011T100845Z/contracts/assessment.json。未修改DSH或现有profile，未新增插件安装测试（尚无新收录）。
