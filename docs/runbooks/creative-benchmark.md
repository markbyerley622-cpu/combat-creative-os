# Runbook — controlled Creative Memory benchmark

`pnpm aamp:benchmark` runs the **same campaign twice** — Creative Memory `off`,
then `required` — and compares what came out.

It answers one question: _does governed benchmark intelligence change the plan
and the output?_ It does not answer whether the change is an improvement.
Nothing in this system makes that claim; that is what the human scorecard (§7)
is for, and publication still requires the three human approval gates.

## 1. What makes it controlled

| Held constant                           | How                                                     |
| --------------------------------------- | ------------------------------------------------------- |
| Campaign prompt and factual constraints | one `CampaignRequest`, loaded once, deep-frozen, hashed |
| Production assets                       | the manifest's **bytes** are hashed, not its path       |
| Platform, duration, CTA                 | fields of that same request                             |
| Reasoning model and profile             | one selection, applied to both arms                     |
| Agent prompt versions                   | recorded on the experiment                              |
| Render settings and QA configuration    | recorded on the experiment                              |

Each arm records the hashes it _actually received_, and
`assertArmsWereControlled` refuses to produce a comparison when they disagree —
comparing two different briefs is worse than not comparing, because it looks
like evidence.

Nothing mutable crosses the arm boundary: separate run directories, separate
workflow run ids, a fresh `CreativeMemoryInjector` per arm (so audits never
accumulate) and a fresh reasoning provider per arm. The PostgreSQL and Qdrant
handles are shared, which is correct — they are read-only here.

## 2. The command

```powershell
pnpm aamp:benchmark run `
  --request apps/aamp-cli/examples/combat-reviews-weekend.request.json `
  --workspace 6f1d5f6c-6d3a-4a2e-9c5f-0f2a1b3c4d5e `
  --benchmark-profile combat-reviews-benchmark `
  --execution-mode local-production
```

| Option                   | Meaning                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `--request`              | the campaign request both arms receive                         |
| `--workspace`            | whose approved references and profiles govern the REQUIRED arm |
| `--benchmark-profile`    | the approved profile expected to govern this campaign          |
| `--assets`               | override the request's production asset manifest               |
| `--execution-mode`       | minimum infrastructure tier (generation runbook §10)           |
| `--output-dir`           | default `.aamp-output/benchmarks`                              |
| `--allow-paid-providers` | permit real model calls — see §5                               |
| `--max-cost-cents`       | refuse if the estimated maximum exceeds this                   |
| `--plan-only`            | stop after planning both arms                                  |
| `--skip-render`          | build both render manifests but invoke no FFmpeg               |
| `--json`                 | machine-readable result                                        |

Exit codes: `0` success, `2` invalid arguments, `3` dependencies unavailable,
`4` an arm failed, `5` the arms were not controlled, `6` blocked by a HIGH
originality result.

## 3. Fixture benchmark (no infrastructure, no spend)

```powershell
pnpm aamp:benchmark run --request <request.json> --skip-render
```

Stops at the render manifest and uses the **deterministic context-aware
fixture** for reasoning. That fixture derives its output from the retrieved
_measurements_, which is what makes an ON/OFF comparison meaningful at all —
the golden-replay fixture ignores its input entirely and would produce two
identical plans.

It is a mechanism demonstration. It says nothing about how a real model would
use the context, and every report says so.

## 4. Local-production benchmark (live services, real MP4s)

```powershell
docker compose -f infrastructure/docker-compose.yml up -d postgres qdrant
$env:FFMPEG_PATH = "<...>\bin\ffmpeg.exe"; $env:FFPROBE_PATH = "<...>\bin\ffprobe.exe"
$ws = "6f1d5f6c-6d3a-4a2e-9c5f-0f2a1b3c4d5e"

pnpm aamp:doctor --execution-mode local-production --creative-memory required --workspace $ws
pnpm aamp:benchmark run --request apps/aamp-cli/examples/combat-reviews-weekend.request.json `
  --workspace $ws --benchmark-profile combat-reviews-benchmark `
  --execution-mode local-production
```

See the generation runbook §12 for the one-time setup: workspace, references,
approvals, benchmark profiles and the index.

## 5. The first real Claude-powered benchmark

Four separate yeses are required; the absence of any one means no paid call
happens.

```powershell
$env:REASONING_PROVIDER = "claude"
$env:ANTHROPIC_API_KEY  = "<your key>"            # never committed, never logged
$env:BENCHMARK_INPUT_COST_CENTS_PER_MTOK  = "<what you believe input costs>"
$env:BENCHMARK_OUTPUT_COST_CENTS_PER_MTOK = "<what you believe output costs>"

pnpm aamp:doctor --execution-mode production --creative-memory required --workspace $ws
pnpm aamp:benchmark run --request apps/aamp-cli/examples/combat-reviews-weekend.request.json `
  --workspace $ws --benchmark-profile combat-reviews-benchmark `
  --execution-mode production `
  --allow-paid-providers --max-cost-cents 500
```

1. a real provider must be configured;
2. `--allow-paid-providers` must be supplied on this invocation;
3. an estimated **maximum** cost must be computable — which is why the two rate
   variables are required and deliberately not defaulted. Paid work is never
   authorised against an unknown number, and a hardcoded price table in this
   repository would go stale silently;
4. the authorisation — who, when, which model, what ceiling — is written into
   `experiment.json`.

The ceiling is printed **before** the first call. It is a declared-rate
estimate, not a quote and not a measurement: this command reserves no budget
and writes no `BudgetLedger` row, so `actualCostCents` stays `null`.

Tests and CI are structurally incapable of a paid call: a test asserts that no
test file passes the flag, and that the runner reaches a real provider only
inside the `paidProviders.authorised` branch.

## 6. Reading the output

```
.aamp-output/benchmarks/<experiment-id>/
  experiment.json                          sealed, self-checksummed record
  comparison-report.json                   structured comparison
  comparison-report.md                     the readable one
  human-scorecard.off.template.json        empty templates — never scores
  human-scorecard.required.template.json
  arm-off/       campaign-request, agent-outputs, render-manifest, source-selection,
  arm-required/  asset-provenance, creative-memory-provenance, originality-report,
                 creative-scorecard, run-summary, aamp-run-provenance,
                 the MP4 and its QA report
```

Both MP4s: `arm-off/*.mp4` and `arm-required/*.mp4`. Open
`comparison-report.md` in any Markdown viewer.

Nineteen dimensions are compared — hook strategy, hook latency, narrative arc,
beat count, beat timing, shot count, shot durations, camera movement, motion
design, transitions, caption density, CTA timing, CTA duration, reference
roles, reference diversity, originality risk, manifest, actual-media QA and
cost. Each is marked `structural` (from the plan or the manifest) or `measured`
(read off the produced file). **A changed row is a difference, not an
improvement**, and the report says so at the top and at the bottom.

## 7. Submitting a human judgement

```powershell
copy <experiment>\human-scorecard.required.template.json my-review.json
# fill it in, then:
pnpm aamp:benchmark score --scorecard my-review.json --experiment-dir <experiment>
```

Fourteen dimensions — first-second stopping power, product comprehension,
combat authenticity, visual hierarchy, pacing, shot quality, motion and
transitions, edit coherence, sound impact, brand distinctiveness, CTA clarity,
platform fit, originality, publish readiness — each scored 1–5, each requiring
a reviewer id, a note of at least twenty characters, evidence (a timestamp in
the cut or a shot index), a blocking/non-blocking classification and a
timestamp. A submission missing any dimension, any evidence or any attribution
is refused.

**No automated process fills this in.** There is no function in this repository
that produces a score; the runner may only emit the empty template, and a test
holds that.

## 8. Interpreting blockers and execution labels

| You see                                                  | It means                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `DEMONSTRATION: --allow-paid-providers was not supplied` | the deterministic fixture ran; nothing was spent; nothing here is evidence about a real model   |
| `LOCAL_PRODUCTION — PARTIALLY SIMULATED`                 | live infrastructure, but at least one provider was substituted; the caveat names which          |
| exit `5`                                                 | the arms did not receive identical inputs; the comparison was withheld deliberately             |
| exit `6`                                                 | a HIGH originality result stopped the experiment; the blocked arm has no render manifest at all |
| `OFF retrievals: n` where n > 0                          | a defect — the OFF arm must perform none                                                        |

## 9. Current limitations

- `actualCostCents` is always `null`: the CLI meters no spend and writes no
  ledger row. The estimate is a declared-rate ceiling.
- `deterministicSeed` is `null` because neither the fixture (a pure function of
  its input) nor the reasoning provider exposes one through this path.
- A real Claude benchmark has never been run here — no key is configured.
- The comparison is between two arms of one campaign. It is not a sample, and
  a single experiment is not a finding.
