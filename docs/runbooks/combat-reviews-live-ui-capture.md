# Runbook — read-only Combat Reviews UI capture

Turning approved public Combat Reviews screens into rights-controlled
production assets, and rendering an advertisement from them. No GPU, no API
key, no paid provider, no login.

---

## 1. The rights boundary, first

**A URL is not a licence.** Reaching a page over HTTP establishes that the page
is public and nothing else. It says nothing about who owns the interface, who
owns the imagery on it, or whether either may appear in a paid advertisement.

So capture has two modes, and the difference is a document:

|                       | **Inspection only** (no `--rights`)              | **Declared** (`--rights <file>`)       |
| --------------------- | ------------------------------------------------ | -------------------------------------- |
| Screenshots written   | yes                                              | yes                                    |
| Eligibility           | `REVIEW_REQUIRED`                                | `OUTPUT_ELIGIBLE`                      |
| Rights classification | none                                             | `OWNED` or `LICENSED_FOR_OUTPUT`       |
| Can reach a render    | **no** — the merge refuses it by name            | yes, subject to the existing preflight |
| Banner                | `NOT OUTPUT ELIGIBLE` / `RIGHTS REVIEW REQUIRED` | states the basis, declarer and term    |

`OWNED_UI_CAPTURE` and `LICENSED_UI_CAPTURE` are the _bases_ on which a person
claims the rights. They are **not** new rights classifications: they project
onto the two existing output-permitting classes in `production-assets.ts`, and
the production manifest never learns a capture was involved. Capture therefore
inherits every rights rule the renderer already enforces, unchanged.

A declaration is refused when it names a different host, has expired, is dated
in the future, or carries a version the specification does not expect. There is
no partial credit and no default — an absent declaration is a complete answer,
and the answer is no.

---

## 2. The privacy boundary

- **No raw DOM is ever saved.** There is no artefact that holds page text,
  markup, headers, cookies or storage. The reports carry selectors and counts.
- **Account identity is redacted on every screen** — avatars, profile and
  notification controls, username elements, `[data-account-name]`.
- **User-written content is redacted on every screen** except one whose role is
  `APP_DISCUSSION_SANITISED`, and that role is **disabled unless a
  specification enables it by name**. Omitting `enabled` leaves it off.
- Redaction **covers** rather than removes: an opaque block at the element's own
  rectangle, so the page's real layout is preserved and the redaction is
  visible as one.
- A **required** redaction selector that matches nothing fails the screen. The
  page changed shape and something that must be hidden was not.
- `assertCaptureArtefactSafe` walks every artefact before it is written and
  fails closed on email addresses, bearer tokens, JWTs, credential query
  strings, session-cookie names and a list of forbidden keys that includes
  `html`, `outerHTML` and `textContent`.
- Query strings are **dropped, never filtered**. Provenance records a pathname
  and a `queryPresent` boolean.

Follow-state controls are deliberately **not** redacted. Capture never
authenticates, so every capture is anonymous and those controls read at their
logged-out default; hiding them would conceal a fact about the product rather
than a fact about a person.

---

## 3. The read-only guarantees

Each is structural — a property of the object graph, not of the code
remembering to behave.

| Guarantee               | How                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| GET and HEAD only       | one route handler over every request; anything else is aborted and counted                                    |
| No off-host traffic     | the same handler refuses any host outside `allowedHosts`                                                      |
| No clicking             | `FOLLOW_LINK` reads an anchor's `href`, verifies it, and navigates directly. No page handler ever runs.       |
| No form submission      | an init script cancels `submit` in the capture phase and neutralises `HTMLFormElement.submit`/`requestSubmit` |
| No popups, no beacons   | `window.open` and `navigator.sendBeacon` are neutralised; a page with an opener is closed and recorded        |
| No downloads            | `acceptDownloads: false`; a download event is cancelled and recorded                                          |
| No persisted state      | a fresh context per screen, no `userDataDir`, no `storageState`, service workers blocked                      |
| No TLS or CSP weakening | both left at Playwright's defaults; nothing in this milestone relaxes either                                  |
| Cleanup always          | the browser closes in a `finally`, on success, failure and cancellation                                       |

The public site fires its own `POST /api/track` and a presence beacon on load.
Those are aborted and the page still renders — that is where this guard earns
its keep. The host allowlist also blocks third-party image CDNs, which doubles
as third-party-imagery removal.

Navigation is refused when a target is not an anchor, leaves the allowed host,
lands somewhere other than the declared `expectPathPrefix`, resolves to a route
whose **path segment** is a control (`/predictions/submit`), or carries a
control-shaped accessible name. Segment matching, not substring matching — a
substring rule refuses `/events/post-fight-analysis` for containing "post".

---

## 4. Commands

### Capture — inspection only

```powershell
pnpm.cmd aamp:capture-app `
  --spec apps/aamp-cli/examples/combat-reviews-capture.spec.json `
  --output-dir .aamp-capture/inspection
```

Prints `NOT OUTPUT ELIGIBLE` / `RIGHTS REVIEW REQUIRED` before doing any work.

### Capture — with a rights declaration

Copy the template, replace every `TODO`, and delete the `_comment` field (the
schema is strict and refuses it, which is why the template cannot be used
unedited):

```powershell
Copy-Item apps/aamp-cli/examples/combat-reviews-capture-rights.template.json my-rights.json
notepad my-rights.json
```

Then capture straight into the asset root the preview already uses, so the
captured screens land beside the existing `brand/`, `combat-clips/` and
`audio/` directories:

```powershell
pnpm.cmd aamp:capture-app `
  --spec apps/aamp-cli/examples/combat-reviews-capture.spec.json `
  --rights my-rights.json `
  --output-dir packages/media/fixtures/preview-asset-root
```

Screenshots are written to `<output-dir>/app-ui/`, content-addressed as
`<assetId>-<first 16 of sha256>.png`. A re-capture producing identical bytes
lands on the same path; one producing different bytes lands on a new path.
Nothing is ever overwritten with different content.

### Merge into a production asset manifest

```powershell
pnpm.cmd aamp:capture-app merge `
  --captured packages/media/fixtures/preview-asset-root/captured-assets.json `
  --manifest apps/aamp-cli/examples/combat-reviews-preview-assets.json `
  --output packages/media/fixtures/preview-asset-root/merged-assets.json
```

The merge is keyed by **asset id** and **replaces**, never appends. It takes
`path`, `checksumSha256` and the measured dimensions from the capture, and
leaves `role`, `beats` and `tags` — the bindings the creative plan reads —
exactly as they were. A captured id matching nothing is reported as
`notMerged`, not added.

> The committed manifest's paths point at `packages/media/fixtures/…` relative
> to the examples directory. When merging into an asset root of your own,
> supply a base manifest whose paths are already relative to that root; the
> merge re-expresses preserved paths relative to the output manifest, and the
> existing preflight refuses anything that resolves outside the root.

### Render the preview from captured UI

Unchanged from the zero-cost preview — the captured screens are ordinary owned
stills as far as it is concerned:

```powershell
pnpm.cmd aamp:generate `
  --request apps/aamp-cli/examples/combat-reviews-preview.request.json `
  --assets packages/media/fixtures/preview-asset-root/merged-assets.json `
  --asset-root packages/media/fixtures/preview-asset-root `
  --plan-file apps/aamp-cli/examples/combat-reviews-preview.plan.json `
  --output-dir .aamp-output/captured-ui-preview
```

### Open the results

```powershell
$run = Get-ChildItem '.aamp-output/captured-ui-preview' -Directory |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
Start-Process (Get-ChildItem $run.FullName -Filter '*.mp4' -File | Select-Object -First 1).FullName
Start-Process (Join-Path $run.FullName 'storyboard.html')
Start-Process 'packages/media/fixtures/preview-asset-root/capture-contact-sheet.png'
```

---

## 5. Output files

Written to `--output-dir`:

| File                                | What it is                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app-ui/<assetId>-<checksum16>.png` | the approved screenshots, content-addressed                                                                                                       |
| `capture-session.json`              | host, rights mode, screens, assets, failures, browser and Playwright versions, `paidProviderCalls: 0`, `requiresHumanApproval: true`              |
| `capture-report.json`               | the read-only record: permitted methods, every blocked request aggregated by `(method, host, path, reason)`, per-screen configuration and outcome |
| `redaction-report.json`             | per screen: which selectors were applied, how many elements each matched, how many were covered, and any required selector that failed            |
| `captured-assets.json`              | the assets plus full capture provenance; the input to `merge`                                                                                     |
| `capture-contact-sheet.png`         | one tile per approved screenshot (needs FFmpeg; its absence costs the sheet, not the capture)                                                     |

Provenance per asset: source host and **pathname only**, capture instant,
viewport preset and geometry, device scale factor, specification name and
version, rights-declaration version, checksum, redacted-element count, browser
engine and version, Playwright version, and whether a crop was used.

None of it is committed. `.gitignore` covers the capture output by name.

---

## 6. Exit codes

| Code | Meaning                                                           |
| ---- | ----------------------------------------------------------------- |
| 0    | captured; requires human approval                                 |
| 2    | the specification is invalid, or a required argument is missing   |
| 3    | a host outside the allowlist                                      |
| 4    | a declared navigation step was a control rather than a link       |
| 5    | navigation failed                                                 |
| 6    | a readiness selector never appeared                               |
| 7    | a required redaction selector matched nothing                     |
| 8    | the screenshot failed                                             |
| 9    | rights: no valid declaration for this host, term or version       |
| 10   | ingestion: empty, undersized, undecodable or duplicate screenshot |

When several screens fail, the reported code is the most actionable one:
rights, then mutation, then host, then redaction, then ingestion, then the
browser-side kinds.

---

## 7. Updating selectors when Combat Reviews changes

The specification is the only place selectors live. Nothing is hard-coded in
the adapter, and `baseUrl` is configurable — the fixture site and the live site
differ only in that field.

Symptoms and fixes:

- **Exit 6, "readiness selector never appeared"** — the anchor was renamed or
  the route moved. Re-check the page and update `readinessSelector`, or `path`.
- **Exit 7, "required redaction selectors matched nothing"** — the element that
  had to be hidden was renamed. Update `requiredRedactionSelectors`. Do **not**
  delete the entry to make the error go away; that is the check working.
- **Exit 10, "identical to …"** — two screens photographed the same pixels,
  usually because one route now redirects to the other.
- **Exit 4** — a `FOLLOW_LINK` selector now resolves to a control. Point it at
  a real anchor.

Selectors verified against the live site on 2026-07-27: `#main` (every page),
`section[aria-label="Recent events"]` (`/events`), `#card`, `#card-talk`,
`#coverage` (`/events/<slug>`), `[aria-label="Account menu"]` (every page).
Routes observed: `/events`, `/events/<slug>`, `/leaderboard`, `/forums`,
`/news`, `/fighters`, `/map`.

The committed specification reaches the event detail page by **following the
first link in the events list**, not by naming a slug, so it does not go stale
when this weekend's card is replaced.

---

## 8. Tests

Ordinary CI never contacts the deployed site. Every browser-side guarantee is
proven against a deterministic local fixture server
(`src/capture/fixture-site.ts`) that reproduces the shapes observed on the real
site, including a page that POSTs on load and one that tries to submit its own
form three ways.

```powershell
pnpm --filter aamp-cli test           # contracts, rights, redaction, merge, browser, CLI, render
```

The browser suites skip loudly when no Chromium build is installed
(`npx playwright install chromium`).

### The opt-in live acceptance test

```powershell
$env:AAMP_LIVE_CAPTURE = '1'
pnpm --filter aamp-cli run test:live-capture
```

It reports `LIVE_CAPTURE_PROVEN` on stdout **only** after real screenshots of
the host in the committed specification have been written and measured, and it
asserts the captured host matches. Every other outcome names its exact blocker
instead. It runs inspection-only: no rights declaration is supplied, so nothing
it produces could reach a render.

---

## 9. Limitations

- **Rights are a human judgement.** This tool records a declaration and enforces
  its host, term and version. It cannot verify that the declaration is true.
- **Third-party imagery on the page is blocked, not cleared.** The host
  allowlist stops promo art from third-party CDNs loading at all, which is why
  those regions are empty in a capture. A screen whose _own_ imagery is
  third-party still needs the declaration's `thirdPartyImagery` answer to be
  honest.
- **Public pages only.** There is no login flow, no credential store and no
  private-page path in this milestone, by design.
- **Creative quality is not assessed.** The preview this feeds is still a
  `HUMAN_ASSISTED_PREVIEW`: a person wrote the plan, and `PASS` means the file
  is technically what it claims to be.
- The captured screens replace stills in a plan whose authored captions were
  written for the synthetic library. Update the plan's copy if it no longer
  describes what the real screens show.
