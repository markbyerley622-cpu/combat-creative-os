import { hexToFfmpegColorWithAlpha, num } from '../render/filter-primitives';

/**
 * The deterministic interface layer: real captured product pixels, moved.
 *
 * Every frame this module produces comes from a screenshot of the running
 * application. Nothing here draws a glyph, types a label or lays out a row —
 * the only marks it adds are rectangles in the brand accent, and a rectangle
 * cannot assert anything the product does not already say. That is the whole
 * reason interface motion is built by moving captured pixels rather than by
 * re-typesetting the interface in HTML: a re-typeset rankings table is an
 * invented rankings table, however carefully it is copied.
 *
 * Two constraints shape the compilation:
 *
 * - **`drawbox` cannot animate.** Its `t` is thickness, not time, and it has
 *   no per-frame evaluation mode, so an accent is a statically-positioned box
 *   with an `enable` window. Accents therefore only appear while their state's
 *   scroll is at rest, which is also the restraint the brief asks for: the
 *   interface is never moving *and* being annotated at the same time.
 * - **`overlay` can animate.** Its `x`/`y` accept `t`, so scrolling and the
 *   push-up state change are both overlay offsets, and a later state drawn
 *   over an earlier one *is* the wipe. No crossfade is expressible here, which
 *   is deliberate: dissolving between two product states says the states are
 *   interchangeable, and they are not.
 */

export class UiLayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UiLayerError';
  }
}

export const UI_EASINGS = ['LINEAR', 'EASE_OUT_CUBIC', 'EASE_IN_OUT_CUBIC'] as const;
export type UiEasing = (typeof UI_EASINGS)[number];

/**
 * A captured screen prepared as a scrollable document.
 *
 * `headroomPx` extends the capture upward using its own top rows. A handset
 * whose screen is taller than the captured viewport genuinely shows more above
 * the application header — the safe-area inset — and these captures' top rows
 * measure as a uniform near-black band, so repeating them is what the device
 * would display rather than an invention. It is also what gives a short
 * capture enough travel to scroll at all.
 */
export interface UiDocument {
  readonly id: string;
  /** Index of this capture among the FFmpeg inputs. */
  readonly inputIndex: number;
  readonly captureWidthPx: number;
  readonly captureHeightPx: number;
  readonly headroomPx: number;
  /**
   * Optional preparation applied before the headroom is added.
   *
   * A capture taken at the delivery viewport is shorter than a handset screen
   * whose glass is proportionally taller, and the only two ways to fill that
   * screen are to stretch the capture — which warps every glyph — or to show
   * it larger and crop. This is the second. `cropXPx` is deliberately explicit
   * rather than centred: these layouts are left-aligned, so a centre crop
   * throws away the title and keeps the whitespace.
   */
  readonly fit?: {
    readonly scaleWidthPx: number;
    readonly scaleHeightPx: number;
    readonly cropXPx: number;
  };
}

/** Scale applied to the capture before it becomes document body pixels. */
export function documentFitScale(document: UiDocument): number {
  return document.fit ? document.fit.scaleWidthPx / document.captureWidthPx : 1;
}

/** The body height after preparation, excluding headroom. */
export function documentBodyHeightPx(document: UiDocument): number {
  return document.fit ? document.fit.scaleHeightPx : document.captureHeightPx;
}

export function documentHeightPx(document: UiDocument): number {
  return documentBodyHeightPx(document) + document.headroomPx;
}

export interface UiScroll {
  readonly fromPx: number;
  readonly toPx: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly easing: UiEasing;
}

export const UI_ENTRANCES = ['NONE', 'PUSH_UP'] as const;
export type UiEntrance = (typeof UI_ENTRANCES)[number];

export interface UiState {
  readonly id: string;
  readonly documentId: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly entrance: UiEntrance;
  /** Ignored when `entrance` is `NONE`. */
  readonly entranceSeconds: number;
  readonly scroll: UiScroll;
}

export const UI_ACCENT_KEYS = [
  /** A hairline brand-accent frame: this row is the one under consideration. */
  'SELECTION_OUTLINE',
  /** The same frame, heavier, with a wash: the control is being pressed. */
  'PRESS_OUTLINE',
  /** A filled brand bar: the state has been committed. */
  'CONFIRM_BAR',
  /** A thin rule under a row: attention, without claiming selection. */
  'FOCUS_UNDERLINE',
] as const;
export type UiAccentKey = (typeof UI_ACCENT_KEYS)[number];

export interface UiAccent {
  readonly id: string;
  readonly key: UiAccentKey;
  /** Canvas coordinates. Fixed for the accent's whole window — see the note above. */
  readonly xPx: number;
  readonly yPx: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly colorHex: string;
}

export interface UiLayerSpec {
  readonly canvasWidthPx: number;
  readonly canvasHeightPx: number;
  readonly frameRate: number;
  readonly durationSeconds: number;
  readonly documents: readonly UiDocument[];
  readonly states: readonly UiState[];
  readonly accents: readonly UiAccent[];
  /** Input index of a black colour source used as the canvas base. */
  readonly baseInputIndex: number;
}

/** `clip(0,1)` progress across a window, as an FFmpeg expression in `t`. */
function progressExpression(startSeconds: number, endSeconds: number): string {
  const span = endSeconds - startSeconds;
  if (span <= 0) {
    throw new UiLayerError(
      `a timing window must be positive, got ${num(startSeconds)}..${num(endSeconds)}`,
    );
  }
  return `min(1,max(0,(t-${num(startSeconds)})/${num(span)}))`;
}

/**
 * Eased progress. `EASE_OUT_CUBIC` is the deceleration curve a flung list
 * settles on; a linear scroll reads as a machine moving a picture, which is
 * exactly the slideshow impression this whole module exists to remove.
 */
export function easedProgressExpression(
  startSeconds: number,
  endSeconds: number,
  easing: UiEasing,
): string {
  const p = progressExpression(startSeconds, endSeconds);
  switch (easing) {
    case 'LINEAR':
      return p;
    case 'EASE_OUT_CUBIC':
      return `(1-pow(1-${p},3))`;
    case 'EASE_IN_OUT_CUBIC':
    default:
      return `if(lt(${p},0.5),4*pow(${p},3),1-pow(-2*${p}+2,3)/2)`;
  }
}

function scrollExpression(scroll: UiScroll): string {
  const delta = scroll.toPx - scroll.fromPx;
  if (delta === 0) return num(scroll.fromPx);
  const eased = easedProgressExpression(scroll.startSeconds, scroll.endSeconds, scroll.easing);
  return `(${num(scroll.fromPx)}+${num(delta)}*${eased})`;
}

function assertScrollWithinDocument(
  state: UiState,
  document: UiDocument,
  canvasHeight: number,
): void {
  const height = documentHeightPx(document);
  const maximum = height - canvasHeight;
  if (maximum < 0) {
    throw new UiLayerError(
      `document "${document.id}" is ${num(height)}px tall but the canvas is ${num(canvasHeight)}px; ` +
        'it would leave the screen uncovered. Raise its headroom.',
    );
  }
  for (const value of [state.scroll.fromPx, state.scroll.toPx]) {
    if (value < 0 || value > maximum) {
      throw new UiLayerError(
        `state "${state.id}" scrolls document "${document.id}" to ${num(value)}px, outside 0..${num(maximum)}px; ` +
          'the screen would show past the end of the capture.',
      );
    }
  }
}

/**
 * The composed interface canvas.
 *
 * States are drawn in start order onto a black base. Because each state's
 * document covers the whole canvas once its entrance completes, drawing the
 * next one over the last *is* the transition — there is no separate transition
 * primitive to get out of step with the states it joins.
 */
export function compileUiLayerGraph(spec: UiLayerSpec): { graph: string; outputLabel: string } {
  if (spec.states.length === 0) {
    throw new UiLayerError('a UI layer needs at least one state');
  }
  const documents = new Map(spec.documents.map((document) => [document.id, document]));
  const steps: string[] = [];

  // A filter output label may be consumed exactly once. Two states showing the
  // same document — a list that scrolls and then holds while a row is
  // selected — is the normal case here, and without an explicit `split` every
  // state after the first renders black while the graph still succeeds. Found
  // the hard way: the accents drew correctly over an empty screen.
  const usageCount = new Map<string, number>();
  for (const state of spec.states) {
    if (!documents.has(state.documentId)) {
      throw new UiLayerError(`state "${state.id}" names unknown document "${state.documentId}"`);
    }
    usageCount.set(state.documentId, (usageCount.get(state.documentId) ?? 0) + 1);
  }
  for (const document of spec.documents) {
    if (!usageCount.has(document.id)) {
      throw new UiLayerError(
        `document "${document.id}" is never shown by any state; FFmpeg refuses a graph with an ` +
          'unconsumed output, so an unused document is a plan error rather than a harmless extra.',
      );
    }
  }

  for (const document of spec.documents) {
    const prepared: string[] = [];
    if (document.fit) {
      if (document.fit.scaleWidthPx < spec.canvasWidthPx) {
        throw new UiLayerError(
          `document "${document.id}" is prepared at ${num(document.fit.scaleWidthPx)}px wide, narrower than ` +
            `the ${num(spec.canvasWidthPx)}px canvas; part of the screen would have no interface on it.`,
        );
      }
      if (
        document.fit.cropXPx < 0 ||
        document.fit.cropXPx + spec.canvasWidthPx > document.fit.scaleWidthPx
      ) {
        throw new UiLayerError(
          `document "${document.id}" crops at x=${num(document.fit.cropXPx)}, which falls outside its ` +
            `${num(document.fit.scaleWidthPx)}px prepared width.`,
        );
      }
      prepared.push(
        `scale=${num(document.fit.scaleWidthPx)}:${num(document.fit.scaleHeightPx)}:flags=lanczos`,
        `crop=${num(spec.canvasWidthPx)}:${num(document.fit.scaleHeightPx)}:${num(document.fit.cropXPx)}:0`,
      );
    } else if (document.captureWidthPx !== spec.canvasWidthPx) {
      throw new UiLayerError(
        `document "${document.id}" is ${num(document.captureWidthPx)}px wide but the canvas is ` +
          `${num(spec.canvasWidthPx)}px, and it declares no fit; scaling it implicitly would resample the interface twice.`,
      );
    }

    const head = prepared.length > 0 ? `${prepared.join(',')},` : '';
    // The headroom is built from the capture's own top rows rather than a
    // colour literal, so the band is the application's background by
    // construction and cannot drift from it.
    if (document.headroomPx > 0) {
      steps.push(
        `[${document.inputIndex}:v]${head}split=2[${document.id}src][${document.id}top]`,
        `[${document.id}top]crop=${num(spec.canvasWidthPx)}:2:0:0,scale=${num(spec.canvasWidthPx)}:${num(document.headroomPx)}:flags=neighbor[${document.id}head]`,
        `[${document.id}head][${document.id}src]vstack=inputs=2,setsar=1[${document.id}base]`,
      );
    } else {
      steps.push(`[${document.inputIndex}:v]${head}setsar=1[${document.id}base]`);
    }

    const copies = usageCount.get(document.id) ?? 0;
    const outputs = Array.from({ length: copies }, (_, index) => `[${document.id}doc${index}]`);
    steps.push(
      copies === 1
        ? `[${document.id}base]null${outputs[0]}`
        : `[${document.id}base]split=${num(copies)}${outputs.join('')}`,
    );
  }

  const ordered = [...spec.states].sort((a, b) => a.startSeconds - b.startSeconds);
  let carry = `${spec.baseInputIndex}:v`;
  steps.push(
    `[${carry}]scale=${num(spec.canvasWidthPx)}:${num(spec.canvasHeightPx)},setsar=1,format=gbrp[uibase]`,
  );
  carry = 'uibase';

  /**
   * How long a state stays drawn.
   *
   * A state normally ends when it ends. But a `PUSH_UP` covers the canvas
   * progressively, so while it is entering there is a band of screen the
   * incoming document has not reached yet — and if the outgoing state has
   * already stopped drawing, that band is the black base. On a handset that
   * reads as the screen going blank mid-transition, which is exactly the
   * failure the brief calls out. The outgoing state is therefore held
   * underneath until the incoming one has fully arrived.
   */
  const drawnUntil = (index: number): number => {
    const state = ordered[index];
    const next = ordered[index + 1];
    if (!state) return 0;
    if (next && next.entrance === 'PUSH_UP') {
      return Math.max(state.endSeconds, next.startSeconds + next.entranceSeconds);
    }
    return state.endSeconds;
  };

  const consumed = new Map<string, number>();
  ordered.forEach((state, index) => {
    const document = documents.get(state.documentId);
    if (!document) {
      throw new UiLayerError(`state "${state.id}" names unknown document "${state.documentId}"`);
    }
    assertScrollWithinDocument(state, document, spec.canvasHeightPx);
    const copyIndex = consumed.get(state.documentId) ?? 0;
    consumed.set(state.documentId, copyIndex + 1);

    const scroll = scrollExpression(state.scroll);
    let y = `-${scroll}`;
    if (state.entrance === 'PUSH_UP') {
      if (state.entranceSeconds <= 0) {
        throw new UiLayerError(`state "${state.id}" declares PUSH_UP with no entrance duration`);
      }
      const eased = easedProgressExpression(
        state.startSeconds,
        state.startSeconds + state.entranceSeconds,
        'EASE_IN_OUT_CUBIC',
      );
      y = `${num(spec.canvasHeightPx)}*(1-${eased})-${scroll}`;
    }

    const label = index === ordered.length - 1 ? 'uistates' : `uis${index}`;
    // `shortest=0:eof_action=repeat` keeps a still document alive for the whole
    // cut; without it the overlay ends when the image input does and every
    // later state renders onto black.
    steps.push(
      `[${carry}][${document.id}doc${copyIndex}]overlay=x=0:y='${y}':enable='between(t,${num(state.startSeconds)},${num(drawnUntil(index))})':eof_action=repeat:format=auto[${label}]`,
    );
    carry = label;
  });

  const accentSteps = spec.accents.map((accent) => accentFilter(accent));
  const tail = [
    ...accentSteps,
    `fps=${num(spec.frameRate)}`,
    `trim=duration=${num(spec.durationSeconds)}`,
    'setpts=PTS-STARTPTS',
    'setsar=1',
  ];
  steps.push(`[${carry}]${tail.join(',')}[uilayer]`);

  return { graph: steps.join(';'), outputLabel: 'uilayer' };
}

/** Accent geometry only. No accent carries text — see the module note. */
function accentFilter(accent: UiAccent): string {
  const enable = `enable='between(t,${num(accent.startSeconds)},${num(accent.endSeconds)})'`;
  const box = (
    x: number,
    y: number,
    w: number,
    h: number,
    colour: string,
    thickness: number | 'fill',
  ): string =>
    `drawbox=x=${num(x)}:y=${num(y)}:w=${num(w)}:h=${num(h)}:color=${colour}:t=${thickness === 'fill' ? 'fill' : num(thickness)}:${enable}`;

  switch (accent.key) {
    case 'SELECTION_OUTLINE':
      return box(
        accent.xPx,
        accent.yPx,
        accent.widthPx,
        accent.heightPx,
        hexToFfmpegColorWithAlpha(accent.colorHex, 0.92),
        6,
      );
    case 'PRESS_OUTLINE':
      // A wash *and* a heavier frame: a press reads as the control taking the
      // touch, which a frame alone does not communicate.
      return [
        box(
          accent.xPx,
          accent.yPx,
          accent.widthPx,
          accent.heightPx,
          hexToFfmpegColorWithAlpha(accent.colorHex, 0.18),
          'fill',
        ),
        box(
          accent.xPx,
          accent.yPx,
          accent.widthPx,
          accent.heightPx,
          hexToFfmpegColorWithAlpha(accent.colorHex, 1),
          12,
        ),
      ].join(',');
    case 'CONFIRM_BAR':
      return box(
        accent.xPx,
        accent.yPx,
        accent.widthPx,
        accent.heightPx,
        hexToFfmpegColorWithAlpha(accent.colorHex, 0.95),
        'fill',
      );
    case 'FOCUS_UNDERLINE':
    default:
      return box(
        accent.xPx,
        accent.yPx,
        accent.widthPx,
        accent.heightPx,
        hexToFfmpegColorWithAlpha(accent.colorHex, 0.9),
        'fill',
      );
  }
}

export interface CaptureRect {
  readonly xPx: number;
  readonly yPx: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

/**
 * Where a region of the original capture sits on the canvas at a given scroll.
 *
 * Accents are authored against the capture — the coordinate space an operator
 * can actually measure in a screenshot — and converted here. Authoring them in
 * canvas space instead would mean re-measuring every accent whenever a
 * document's headroom changed.
 */
export function captureRectToCanvas(
  rect: CaptureRect,
  document: UiDocument,
  scrollPx: number,
): CaptureRect {
  const scale = documentFitScale(document);
  const cropX = document.fit?.cropXPx ?? 0;
  return {
    xPx: rect.xPx * scale - cropX,
    yPx: rect.yPx * scale + document.headroomPx - scrollPx,
    widthPx: rect.widthPx * scale,
    heightPx: rect.heightPx * scale,
  };
}
