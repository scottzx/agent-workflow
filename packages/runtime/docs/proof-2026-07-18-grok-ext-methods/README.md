# Live proof: Grok client extensions (2026-07-18T14:16:50.643Z)

## Result: **PASS**

High-confidence live reproduction against real `grok agent stdio` via `AcpClient` on branch `feat/grok-client-ext-methods`.

Host callbacks (`onAskUserQuestion` / `onExitPlanMode`) return canned outcomes; the agent must still invoke the vendor `extMethod`s and accept our JSON-RPC responses without `Method not found`.

### Checks

| Scenario                     | Status | Wire evidence                                                                   |
| ---------------------------- | ------ | ------------------------------------------------------------------------------- |
| `ask_user_question` accepted | PASS   | request → `answers: {"Pick a color?":"Red"}` → tool `UserAnswered` completed    |
| `exit_plan_mode` approved    | PASS   | response `{outcome:"approved"}` → tool completed (EmptyPlan/PlanReady path)     |
| `exit_plan_mode` rejected    | PASS   | response `{outcome:"rejected", comments:"…"}` → tool completed with revise text |
| `exit_plan_mode` abandoned   | PASS   | response `{outcome:"abandoned"}` → tool completed with abandon text             |

`failures: []` · `eventCount: 63` · agent model: `grok-4.5`

### Artifacts

- [`SUMMARY.json`](https://github.com/scottzx/agent-workflow/blob/main/packages/runtime/docs/proof-2026-07-18-grok-ext-methods/SUMMARY.json) — machine-readable pass/fail + request/response highlights
- [`live-transcript.jsonl`](https://github.com/scottzx/agent-workflow/blob/main/packages/runtime/docs/proof-2026-07-18-grok-ext-methods/live-transcript.jsonl) — full event log (session updates + host callbacks)
- [`console.log`](https://github.com/scottzx/agent-workflow/blob/main/packages/runtime/docs/proof-2026-07-18-grok-ext-methods/console.log) — stdout capture of the proof run

### How to re-run

Requires a working `grok` CLI on `PATH` (Grok Build agent).

```bash
pnpm exec tsx scripts/grok-ext-live-proof.mts
# writes into docs/proof-2026-07-18-grok-ext-methods/
```

### What this proves / does not prove

**Proves:** with this PR's `AcpClient.extMethod` handlers registered, Grok's live agent successfully completes `_x.ai/ask_user_question` and `_x.ai/exit_plan_mode` for all four host outcomes (accepted / approved / rejected / abandoned). No `Method not found`.

**Does not prove:** interactive TTY prompt UX (callbacks short-circuit the CLI prompts). Unit tests cover parsers/response builders; this run covers the live agent ↔ host callback path used by embedders.
