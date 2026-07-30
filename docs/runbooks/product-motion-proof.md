# Runbook — the Product Motion Proof

`pnpm aamp:product-motion` renders one short, continuous product demonstration:
real captured Combat Reviews interface pixels composited onto a photographed
handset, moving through event discovery, fighter comparison, prediction
selection and the predictor-rank reward.

It exists to settle one question before the flagship advertisement is rebuilt —
**does the visual language read as a product film, or as a slideshow?** It is a
5–6 second proof, not the finished advertisement, and every artefact it writes
says so.

Zero paid provider calls. No reasoning provider, no generation provider, no
database client, no network request, no credential. That is a property of the
object graph and `product-motion-source-hygiene.test.ts` asserts it.

---

## 1. Running it

```sh
pnpm aamp:product-motion \
  --plan apps/aamp-cli/plans/combat-reviews-product-motion-proof-01.json \
  --plates-root "<folder holding the photographic plates>" \
  --assets-root "<folder holding app-ui/, audio/ and brand/>"
```

Optional: `--output-root <dir>` (default `.aamp-output`), `--json`.

Asset roots are supplied at invocation and never committed. The plan names
files _relative_ to those roots, so the same plan runs on any machine that has
the material.

Exit codes: `0` pass, `2` invalid plan, `3` asset missing, `4` screen not
mappable, `5` incoherent timeline, `6` render failed, `7` QA failed.

---

## 2. What it writes

Under `<output-root>/<plan id>/`:

| File                              | What it is                                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `<id>-PRODUCT_MOTION_PROOF.mp4`   | The proof. 1080×1920, 30 fps, h264/AAC, faststart.                                                                                 |
| `gallery/comparison-gallery.html` | Source plate, calibrated screen area, interface layer and composited output, side by side. **Open this before believing the run.** |
| `calibration.json`                | Per-plate screen verification: interior luma, spread, rim contrast, aspect, area.                                                  |
| `timing-and-transitions.json`     | Every state, accent, shot and cut, with the measured screen-centre displacement across each cut.                                   |
| `defects.json`                    | What is wrong with the result, whether or not QA passed.                                                                           |
| `provenance.json`                 | Staged inputs and their checksums, `paidProviderCalls: 0`, `isRealCampaignRun: false`.                                             |
| `work/ui-layer.mp4`               | The interface layer alone, at canvas resolution. Scrub this when the composite looks wrong.                                        |
| `work/shot-N-*.mp4`               | Each shot before concatenation.                                                                                                    |

---

## 3. How it is put together

Three FFmpeg passes, in an order chosen by what each one protects.

**Pass 1 — the interface layer.** Real captures are turned into scrollable
documents on a 1080×3090 canvas and animated: scroll with cubic deceleration,
push-up state changes, and brand-accent rectangles. Type is rasterised once,
from captured pixels, before anything geometric happens to it.

**Pass 2 — the shots.** Each plate is cover-framed and pushed in with
`zoompan`; the four screen corners are carried through the _same_ zoom
analytically; the interface is then warped onto them with `perspective`
(`sense=destination`, `eval=frame`) and cut to the screen with an alpha field
warped identically. One shot per FFmpeg invocation.

**Pass 3 — the mix and the mux.** Bed plus cues, `loudnorm`, then muxed with
`-c:v copy` so the picture that passed the eye in pass 2 is the picture that
ships.

### Why compositing happens _after_ the camera move

Compositing first and moving the result scales the interface by the camera
move's own zoom factor, and softened type reads as an enlarged screenshot
rather than a screen. Moving first and warping once, at delivery resolution,
keeps every glyph sharp.

The analytic step is what makes this safe: a push-in is a similarity
transform, so a plate point at normalised `(qx, qy)` lands at
`W*(0.5 + Z*(qx-cx))`, `H*(0.5 + Z*(qy-cy))`. The plate's `zoompan` and the
corner expressions are two readings of one formula. If they ever disagreed the
interface would slide off the handset.

---

## 4. Screen calibration

Corner positions are an **operator declaration**, verified against the plate's
own pixels before anything is composited:

- the quadrilateral must be convex, above a minimum area, within a handset
  aspect range, with no near-degenerate corner and no wildly mismatched
  opposite edges;
- every corner must land inside the plate;
- the interior must be **dark** (mean luma under 72) and **uniform** (spread
  under 26) — together, that is what distinguishes an unlit screen from the
  background, from the phone's body, and from a screen that already has an
  interface on it.

A screen that fails is **refused by name**. There is no fallback that lays a
full-frame screenshot over the plate: that produces a file which passes every
technical gate while showing an interface that is not on the handset.

Rim contrast is measured and reported but never gates. On a black-glass handset
photographed against a black set the bezel and the screen genuinely are close
in luma, and a contrast floor there would refuse the very plates this exists
for.

**Calibration cannot prove the placement is creatively right.** That is what
the gallery overlay is for, and it is generated on every run.

---

## 5. Reading the gallery

Three things to check, in this order:

1. **Calibrated screen area** — does the magenta field sit on the glass, with a
   consistent bezel, on every plate?
2. **Product states** — is the interface sharp? Does any glyph warp or shimmer?
3. **Cuts** — put the last frame out beside the first frame in. Does the
   handset's screen stay in the same place? Does either frame show an empty
   screen?

`timing-and-transitions.json` gives the measured screen-centre displacement
across each cut. On the committed proof both cuts measure under two delivery
pixels, which is what makes them read as match cuts rather than as jumps.

---

## 6. Authoring a plan

The plan is committed JSON and holds the creative decisions. Application code
owns the discipline, not the choices.

Rules the parser enforces, each of which exists because breaking it produces a
file that looks plausible and is wrong:

- **Shots and states must both tile the cut exactly.** A gap renders a hole.
- **The first shot is `OPENING`; no later shot may be.**
- **The transition vocabulary is closed** — `OPENING`,
  `SCREEN_POSITION_MATCH_CUT`, `TAP_CUT`. There is deliberately no crossfade:
  dissolving between two product states says they are interchangeable.
- **An accent may not be drawn while its document is moving.** `drawbox`
  cannot animate — its `t` is thickness, not time — so an accent over a
  scrolling list sits still while the row slides out from under it. Accents
  also may not appear during a push-up entrance.
- **An accent may span several consecutive states**, provided they all show the
  same document at the same resting scroll. A selection that survives the tap
  and the confirmation is one mark, not three.
- **A pan must fit inside the plate at the shot's shallowest zoom.** `zoompan`
  silently clamps a window that runs off the edge while the corner expressions —
  being arithmetic — do not, so the interface would drift off the handset. The
  refusal names the zoom that would make the requested pan legal.

### Documents shorter than the screen

A capture taken at a 1080×1920 viewport is shorter than a handset screen whose
glass is proportionally taller. Two fields deal with it:

- `fit` shows the capture larger and crops horizontally. `cropXPx` is explicit
  rather than centred, because these layouts are left-aligned and a centre crop
  keeps the whitespace and loses the titles.
- `headroomPx` extends the document upward **using the capture's own top rows**,
  which measure as a uniform near-black band. A taller screen really does show
  more above the application header. It is also what gives a short capture room
  to scroll.

Stretching a capture to fill the screen is not an option and never will be: it
warps every glyph, which is the one thing this proof exists to avoid.

---

## 7. Things learned the hard way

- **A filter output label may be consumed exactly once.** Two states showing
  one document is the normal case here; without an explicit `split` every state
  after the first renders black _while the graph still succeeds_. The accents
  drew perfectly over an empty screen.
- **A push-up needs the outgoing layer held underneath.** Otherwise the band
  the incoming document has not reached yet is the black base, and the handset
  appears to go blank mid-transition.
- **Do not compile every shot into one `filter_complex`.** Each plate is a
  looped still, so FFmpeg generates frames for later shots while the concat is
  still asking for the first. Measured at 1.5 GB resident for a five-second cut
  at about a tenth of the CPU doing useful work. One invocation per shot, then
  the concat demuxer with the streams copied.
- **The QA descriptor manifest must declare that the picture moves.** QA
  excludes scenes declaring stillness from its frozen-frame walk, so a
  descriptor claiming `STATIC` switches off the one check that would catch this
  proof failing at its own purpose.
- **The alpha warp is not cubic.** Cubic interpolation overshoots at a hard
  edge, haloing the screen with partial transparency. Picture cubic, alpha
  linear; every coordinate identical.

---

## 8. What this proves and what it does not

**Proven:** an ffprobe-verified 1080×1920 h264/yuv420p MP4 at exactly 5.600 s,
AAC stereo 48 kHz, faststart, passing actual-media QA including the
frozen-frame walk; real captured product pixels on a photographed handset with
correct perspective; two cuts whose measured screen-centre displacement is
under two pixels; interface motion that is genuinely animated rather than
stepped.

**Not proven:** creative quality. No measurement here scores it. Whether the
sequence reads as one continuous demonstration is a judgement a person makes
from the frames, and `defects.json` lists the questions to ask.

**Known and recorded every run:** the plates are 941×1672, below the delivery
frame, so the photography is upscaled and softer than native; the audio is the
temporary synthetic work-pack material and is not a mix; the photographic layer
is a still under a camera move, so nothing in the photograph itself moves; and
the interface comes from the existing approved captures, because the live
application was unreachable when this was built.
