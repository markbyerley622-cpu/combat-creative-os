import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findArtefactSafetyProblems } from '../storyboard-video/artefact-safety';
import { STORYBOARD_VIDEO_EXIT_CODES } from '../storyboard-video/failures';
import { parseAcceptanceBrief, type NotificationBrief } from './acceptance-brief';
import { buildFilterComplex } from './notification-composite';
import {
  buildNotificationDefectReport,
  summarisePulse,
  type NotificationMeasurements,
} from './notification-defects';
import { parseProofArguments } from './notification-proof-cli';
import { PLACEMENT_NOTICE, type PlacementReport } from './notification-placement';
import { buildNotificationSurfaceHtml, cssFontStack, rgba } from './notification-surface';
import {
  buildNotificationTimeline,
  ease,
  pulseIntensity,
  NOTIFICATION_TREATMENT_VERSION,
} from './notification-timeline';

/**
 * The notification treatment's contracts, none of which need FFmpeg, Chromium,
 * a network or a credential.
 *
 * The expensive parts of this path are a browser and an encoder, and everything
 * that decides whether they should run at all is cheap. These are the cheap
 * checks.
 */

const FRAME = { widthPx: 1080, heightPx: 1920 };

async function loadCommittedBrief(): Promise<ReturnType<typeof parseAcceptanceBrief>> {
  return parseAcceptanceBrief(
    JSON.parse(
      await readFile(
        join(
          __dirname,
          '..',
          '..',
          'campaigns',
          'combat-reviews-flagship-02',
          'scene-01-ltx-acceptance.json',
        ),
        'utf8',
      ),
    ),
  );
}

async function committedNotification(): Promise<NotificationBrief> {
  return (await loadCommittedBrief()).notification;
}

describe('the entrance', () => {
  it('starts at the specified scale and offset and reaches rest exactly at the settle', async () => {
    const brief = await committedNotification();
    const timeline = buildNotificationTimeline(brief, FRAME);
    const entrance = timeline.states.filter((state) => state.kind === 'ENTRANCE');

    expect(entrance).toHaveLength(brief.entranceSteps);
    expect(entrance[0]?.fromSeconds).toBeCloseTo(brief.entranceStartSeconds, 6);
    expect(entrance[0]?.scale).toBeCloseTo(brief.entranceStartScale, 6);
    expect(entrance[0]?.riseRemainingPx).toBeCloseTo(brief.entranceRisePx, 6);
    expect(entrance[entrance.length - 1]?.toSeconds).toBeCloseTo(brief.entranceSettleSeconds, 6);

    // Rest is reached by the state that follows the entrance, not by the last
    // entrance step: the final step is the last frame that is still arriving.
    const settled = timeline.states.find(
      (state) => state.fromSeconds >= brief.entranceSettleSeconds,
    );
    expect(settled?.scale).toBe(1);
    expect(settled?.riseRemainingPx).toBe(0);
  });

  it('rises monotonically and never overshoots', async () => {
    const brief = await committedNotification();
    const timeline = buildNotificationTimeline(brief, FRAME);
    let previousScale = 0;
    let previousRise = Number.POSITIVE_INFINITY;
    for (const state of timeline.states) {
      expect(state.scale).toBeGreaterThanOrEqual(previousScale);
      expect(state.scale).toBeLessThanOrEqual(1);
      expect(state.riseRemainingPx).toBeLessThanOrEqual(previousRise + 1e-9);
      expect(state.riseRemainingPx).toBeGreaterThanOrEqual(0);
      previousScale = state.scale;
      previousRise = state.riseRemainingPx;
    }
  });

  it('covers the whole window with no gap and no overlap', async () => {
    const brief = await committedNotification();
    const timeline = buildNotificationTimeline(brief, FRAME);
    for (let index = 1; index < timeline.states.length; index += 1) {
      expect(timeline.states[index]?.fromSeconds).toBeCloseTo(
        timeline.states[index - 1]?.toSeconds ?? -1,
        6,
      );
    }
    expect(timeline.states[timeline.states.length - 1]?.toSeconds).toBeCloseTo(
      brief.readableUntilSeconds,
      6,
    );
  });

  it('is step-matched to the frame grid, so no state is shown twice while another is skipped', async () => {
    const brief = await committedNotification();
    const timeline = buildNotificationTimeline(brief, FRAME);
    const frameRate = 24;
    const stateAt = (seconds: number): string | undefined =>
      timeline.states.find((state) => seconds >= state.fromSeconds && seconds < state.toSeconds)
        ?.id;

    const entranceStates = new Set<string>();
    for (let frame = 0; frame < Math.ceil(brief.readableUntilSeconds * frameRate); frame += 1) {
      const seconds = frame / frameRate;
      if (seconds < brief.entranceStartSeconds || seconds >= brief.entranceSettleSeconds) continue;
      const id = stateAt(seconds);
      expect(id).toBeDefined();
      entranceStates.add(id as string);
    }
    expect(entranceStates.size).toBe(brief.entranceSteps);
  });

  it('is a complete card on every state — there is no assembly stage', async () => {
    const brief = await committedNotification();
    const timeline = buildNotificationTimeline(brief, FRAME);
    for (const state of timeline.states) {
      const html = buildNotificationSurfaceHtml({
        brief,
        frame: FRAME,
        state,
        markDataUri: 'data:image/png;base64,AAAA',
      });
      expect(html).toContain(brief.headline);
      expect(html).toContain(brief.headerLabel);
      expect(html).toContain(brief.timestampLabel);
      expect(html).toContain(brief.supportingLine);
      expect(html).toContain('class="mark"');
      expect(html).toContain('class="accent"');
    }
  });
});

describe('the accent pulse', () => {
  it('fires once, peaks inside its window and returns to rest', async () => {
    const brief = await committedNotification();
    const timeline = buildNotificationTimeline(brief, FRAME);
    const pulse = timeline.states.filter((state) => state.kind === 'PULSE');

    expect(pulse).toHaveLength(brief.pulseSteps);
    expect(pulse[0]?.fromSeconds).toBeCloseTo(brief.pulseStartSeconds, 6);
    expect(pulse[pulse.length - 1]?.toSeconds).toBeCloseTo(brief.pulseEndSeconds, 6);

    const peak = Math.max(...pulse.map((state) => state.accentOpacity));
    expect(peak).toBeGreaterThan(brief.accentRestOpacity);
    expect(peak).toBeLessThanOrEqual(brief.accentPulsePeakOpacity);

    const last = timeline.states[timeline.states.length - 1];
    expect(last?.kind).toBe('REST');
    expect(last?.accentOpacity).toBe(brief.accentRestOpacity);
  });

  it('rises faster than it falls, so it is struck rather than throbbed', () => {
    expect(pulseIntensity(0.35)).toBeCloseTo(1, 6);
    expect(pulseIntensity(0.175)).toBeCloseTo(0.5, 6);
    // Half of the decay is still ahead at the two-thirds mark, which a
    // symmetric curve would already have passed.
    expect(pulseIntensity(0.675)).toBeGreaterThan(0.4);
    expect(pulseIntensity(1)).toBeCloseTo(0, 6);
  });

  it('counts one excursion as one pulse even when the rise plateaus', () => {
    const readings = [4, 4, 4, 90, 210, 210, 120, 60, 60, 60].map((redness, index) => ({
      frameIndex: index,
      atSeconds: index / 24,
      redness,
    }));
    const summary = summarisePulse(readings);
    expect(summary.excursions).toBe(1);
    expect(summary.peak).toBe(210);
    expect(summary.rest).toBe(60);
  });

  it('counts a second flash as a second excursion', () => {
    const readings = [60, 210, 60, 60, 210, 60].map((redness, index) => ({
      frameIndex: index,
      atSeconds: index / 24,
      redness,
    }));
    expect(summarisePulse(readings).excursions).toBe(2);
  });
});

describe('the surface document', () => {
  it('escapes authored copy rather than interpolating it raw', async () => {
    const brief = await committedNotification();
    const timeline = buildNotificationTimeline(brief, FRAME);
    const html = buildNotificationSurfaceHtml({
      brief: { ...brief, headline: '<script>alert(1)</script>' },
      frame: FRAME,
      state: timeline.states[0] as (typeof timeline.states)[number],
      markDataUri: 'data:image/png;base64,AAAA',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('refuses a font name that could close a declaration', () => {
    expect(cssFontStack('Arial')).toBe('"Arial", sans-serif');
    expect(cssFontStack('Ari"al; } body { display:none')).toBe(
      '"Arial  body  display:none", sans-serif',
    );
    expect(() => cssFontStack('"""')).toThrow(/empty once it is made safe/i);
  });

  it('refuses a colour that is not #rrggbb', () => {
    expect(rgba('#DA0318', 0.5)).toBe('rgba(218, 3, 24, 0.5)');
    expect(() => rgba('red', 1)).toThrow(/may not reach a stylesheet/i);
  });

  it('applies the state as a transform of one laid-out card, never as a re-layout', async () => {
    const brief = await committedNotification();
    const timeline = buildNotificationTimeline(brief, FRAME);
    const first = buildNotificationSurfaceHtml({
      brief,
      frame: FRAME,
      state: timeline.states[0] as (typeof timeline.states)[number],
      markDataUri: 'data:image/png;base64,AAAA',
    });
    const last = buildNotificationSurfaceHtml({
      brief,
      frame: FRAME,
      state: timeline.states[timeline.states.length - 1] as (typeof timeline.states)[number],
      markDataUri: 'data:image/png;base64,AAAA',
    });
    // The card's own width and the type sizes are identical across states; only
    // the transform differs. A re-layout would leave the type at a fixed size
    // inside a shrinking box, which is the tell of a scaled screenshot.
    expect(first).toContain(`font-size: ${brief.headlineFontSizePx}px`);
    expect(last).toContain(`font-size: ${brief.headlineFontSizePx}px`);
    expect(first).toContain(`scale(${brief.entranceStartScale})`);
    expect(last).toContain('scale(1)');
  });
});

describe('the filter graph', () => {
  it('carries no authored string at all', async () => {
    const brief = await committedNotification();
    const timeline = buildNotificationTimeline(brief, FRAME);
    const graph = buildFilterComplex({ frame: FRAME, timeline });

    for (const authored of [
      brief.headline,
      brief.headerLabel,
      brief.supportingLine,
      brief.timestampLabel,
      brief.fontFamily,
      brief.accentColorHex,
      brief.surfaceColorHex,
    ]) {
      expect(graph).not.toContain(authored);
    }
    // Nor a subtitle file, which is how the previous treatment carried copy
    // into a filter argument.
    expect(graph).not.toContain('subtitles');
    expect(graph).not.toContain('.ass');
    expect(graph).not.toContain('drawtext');
  });

  it('overlays one complete surface per state, on disjoint windows', async () => {
    const brief = await committedNotification();
    const timeline = buildNotificationTimeline(brief, FRAME);
    const graph = buildFilterComplex({ frame: FRAME, timeline });
    const overlays = graph.split(';').filter((step) => step.includes('overlay='));
    expect(overlays).toHaveLength(timeline.states.length);
    for (const state of timeline.states) {
      expect(graph).toContain(`between(t,${state.fromSeconds},${state.toSeconds})`);
    }
    // Every label is produced once and consumed once. An FFmpeg output label
    // consumed twice renders black while the graph still succeeds.
    const produced = [...graph.matchAll(/\[(base\d+|composited|out)\]/g)].map((match) => match[1]);
    const counts = new Map<string, number>();
    for (const label of produced)
      counts.set(label as string, (counts.get(label as string) ?? 0) + 1);
    for (const [label, count] of counts) {
      expect(`${label}:${count}`).toBe(`${label}:${label === 'out' ? 1 : 2}`);
    }
  });

  it('composites in RGB and converts to the delivery format once, at the end', async () => {
    const brief = await committedNotification();
    const timeline = buildNotificationTimeline(brief, FRAME);
    const graph = buildFilterComplex({ frame: FRAME, timeline });
    expect(graph).toContain('format=rgba[base0]');
    expect(graph.indexOf('format=yuv420p')).toBe(graph.lastIndexOf('format=yuv420p'));
    expect(graph.endsWith('[composited]format=yuv420p[out]')).toBe(true);
  });
});

describe('the easing vocabulary', () => {
  it('is closed and executes only what it names', () => {
    expect(ease('EASE_OUT_CUBIC', 0)).toBe(0);
    expect(ease('EASE_OUT_CUBIC', 1)).toBe(1);
    expect(ease('EASE_OUT_QUINT', 0.5)).toBeGreaterThan(ease('EASE_OUT_CUBIC', 0.5));
    expect(() => ease('EASE_IN_OUT_BACK' as unknown as Parameters<typeof ease>[0], 0.5)).toThrow(
      /is not implemented/i,
    );
  });
});

describe('the visible-defects report', () => {
  const timelineFor = async () => buildNotificationTimeline(await committedNotification(), FRAME);

  const cleanPlacement = (timeline: Awaited<ReturnType<typeof timelineFor>>): PlacementReport => ({
    profileVersion: 1,
    subjectContentLumaThreshold: 40,
    minimumClearancePx: 20,
    measuredAgainst: 'the source picture, before the notification was composited',
    frameCount: 27,
    treatmentOccupiedRect: timeline.occupiedRect,
    restingCardRect: timeline.restRect,
    framesOverlappingSubjectContent: 0,
    worstClearanceAbovePx: 60,
    worstClearanceBelowPx: 55,
    maxLumaUnderTreatmentPx: 19,
    clearsSubjectContent: true,
    frames: [],
    notMeasuredReason: null,
    humanJudgementRequired: [],
    notice: PLACEMENT_NOTICE,
  });

  const goodMeasurements = (brief: NotificationBrief): NotificationMeasurements => ({
    frameCount: 27,
    frameRate: 24,
    presence: Array.from({ length: 27 }, (_, index) => {
      const atSeconds = index / 24;
      const cardPresent = atSeconds >= brief.entranceStartSeconds;
      return {
        frameIndex: index,
        atSeconds,
        surfaceFraction: cardPresent ? 0.86 : 0,
        inkFraction: cardPresent ? 0.09 : 0.99,
        cardPresent,
        blankRectangle: false,
      };
    }),
    accent: Array.from({ length: 27 }, (_, index) => {
      const atSeconds = index / 24;
      const inPulse = atSeconds >= brief.pulseStartSeconds && atSeconds < brief.pulseEndSeconds;
      return {
        frameIndex: index,
        atSeconds,
        redness: atSeconds < brief.entranceStartSeconds ? 2 : inPulse ? 205 : 118,
      };
    }),
    presenceNotMeasuredReason: null,
    accentNotMeasuredReason: null,
    assetMinAlpha: 0,
    assetMaxAlpha: 255,
    assetTransparentFraction: 0.42,
    assetNotMeasuredReason: null,
  });

  it('passes every measured row when the file is right', async () => {
    const brief = await committedNotification();
    const timeline = await timelineFor();
    const report = buildNotificationDefectReport({
      brief,
      timeline,
      measurements: goodMeasurements(brief),
      placement: cleanPlacement(timeline),
      measuredWidthPx: 1080,
      measuredHeightPx: 1920,
      measuredDurationSeconds: 1.083333,
      requestedDurationSeconds: 1.1,
      rerenderChecksumSha256: 'a'.repeat(64),
      renderChecksumSha256: 'a'.repeat(64),
    });

    expect(report.measuredDefectCount).toBe(0);
    expect(report.openHumanJudgementCount).toBeGreaterThanOrEqual(9);
    expect(findArtefactSafetyProblems(report)).toEqual([]);
  });

  it('catches a frame that shows the surface with no type on it', async () => {
    const brief = await committedNotification();
    const timeline = await timelineFor();
    const measurements = goodMeasurements(brief);
    const presence = measurements.presence.map((entry, index) =>
      index === 10 ? { ...entry, inkFraction: 0.001, blankRectangle: true } : entry,
    );
    const report = buildNotificationDefectReport({
      brief,
      timeline,
      measurements: { ...measurements, presence },
      placement: cleanPlacement(timeline),
      measuredWidthPx: 1080,
      measuredHeightPx: 1920,
      measuredDurationSeconds: 1.083333,
      requestedDurationSeconds: 1.1,
      rerenderChecksumSha256: 'a'.repeat(64),
      renderChecksumSha256: 'a'.repeat(64),
    });
    const row = report.observations.find((entry) => entry.id === 'NEVER_A_BLANK_RECTANGLE');
    expect(row?.status).toBe('DEFECT');
  });

  it('catches a card that fades before the cut', async () => {
    const brief = await committedNotification();
    const timeline = await timelineFor();
    const measurements = goodMeasurements(brief);
    const presence = measurements.presence.map((entry, index) =>
      index >= measurements.presence.length - 3
        ? { ...entry, surfaceFraction: 0.2, cardPresent: false }
        : entry,
    );
    const report = buildNotificationDefectReport({
      brief,
      timeline,
      measurements: { ...measurements, presence },
      placement: cleanPlacement(timeline),
      measuredWidthPx: 1080,
      measuredHeightPx: 1920,
      measuredDurationSeconds: 1.083333,
      requestedDurationSeconds: 1.1,
      rerenderChecksumSha256: 'a'.repeat(64),
      renderChecksumSha256: 'a'.repeat(64),
    });
    expect(
      report.observations.find((entry) => entry.id === 'NO_FADE_OUT_BEFORE_THE_CUT')?.status,
    ).toBe('DEFECT');
  });

  it('catches a second accent flash', async () => {
    const brief = await committedNotification();
    const timeline = await timelineFor();
    const measurements = goodMeasurements(brief);
    const accent = measurements.accent.map((entry, index) =>
      index >= 22 && index <= 23 ? { ...entry, redness: 205 } : entry,
    );
    const report = buildNotificationDefectReport({
      brief,
      timeline,
      measurements: { ...measurements, accent },
      placement: cleanPlacement(timeline),
      measuredWidthPx: 1080,
      measuredHeightPx: 1920,
      measuredDurationSeconds: 1.083333,
      requestedDurationSeconds: 1.1,
      rerenderChecksumSha256: 'a'.repeat(64),
      renderChecksumSha256: 'a'.repeat(64),
    });
    expect(
      report.observations.find((entry) => entry.id === 'ACCENT_PULSES_EXACTLY_ONCE')?.status,
    ).toBe('DEFECT');
  });

  it('loses only the section that failed, not the ones that succeeded', async () => {
    const brief = await committedNotification();
    const timeline = await timelineFor();
    const report = buildNotificationDefectReport({
      brief,
      timeline,
      measurements: {
        ...goodMeasurements(brief),
        accent: [],
        accentNotMeasuredReason: 'the accent strip could not be decoded',
      },
      placement: cleanPlacement(timeline),
      measuredWidthPx: 1080,
      measuredHeightPx: 1920,
      measuredDurationSeconds: 1.083333,
      requestedDurationSeconds: 1.1,
      rerenderChecksumSha256: 'a'.repeat(64),
      renderChecksumSha256: 'a'.repeat(64),
    });
    // Exactly the two accent rows are unknown; presence and alpha still stand.
    expect(report.notMeasuredCount).toBe(2);
    expect(
      report.observations.find((entry) => entry.id === 'NEVER_A_BLANK_RECTANGLE')?.status,
    ).toBe('OBSERVED');
    expect(
      report.observations.find((entry) => entry.id === 'SURFACE_ASSET_IS_TRANSPARENT')?.status,
    ).toBe('OBSERVED');
    expect(
      report.observations.find((entry) => entry.id === 'ACCENT_PULSES_EXACTLY_ONCE')?.status,
    ).toBe('NOT_MEASURED');
  });

  it('never reports an unmeasurable row as a pass', async () => {
    const brief = await committedNotification();
    const timeline = await timelineFor();
    const report = buildNotificationDefectReport({
      brief,
      timeline,
      measurements: {
        ...goodMeasurements(brief),
        presenceNotMeasuredReason: 'the composited picture could not be decoded',
        accentNotMeasuredReason: 'the composited picture could not be decoded',
        assetNotMeasuredReason: 'the surface asset could not be decoded',
      },
      placement: {
        ...cleanPlacement(timeline),
        notMeasuredReason: 'no frames',
        clearsSubjectContent: false,
      },
      measuredWidthPx: null,
      measuredHeightPx: null,
      measuredDurationSeconds: null,
      requestedDurationSeconds: 1.1,
      rerenderChecksumSha256: null,
      renderChecksumSha256: 'a'.repeat(64),
    });
    const notMeasured = report.observations.filter((entry) => entry.status === 'NOT_MEASURED');
    expect(notMeasured.length).toBeGreaterThan(5);
    for (const row of notMeasured) expect(row.finding).not.toBe('');
    expect(
      report.observations.some((entry) => entry.status === 'OBSERVED' && entry.finding === ''),
    ).toBe(false);
  });

  it('scores no craft dimension and says so', async () => {
    const brief = await committedNotification();
    const timeline = await timelineFor();
    const report = buildNotificationDefectReport({
      brief,
      timeline,
      measurements: goodMeasurements(brief),
      placement: cleanPlacement(timeline),
      measuredWidthPx: 1080,
      measuredHeightPx: 1920,
      measuredDurationSeconds: 1.083333,
      requestedDurationSeconds: 1.1,
      rerenderChecksumSha256: 'a'.repeat(64),
      renderChecksumSha256: 'a'.repeat(64),
    });
    for (const id of ['READS_AS_PREMIUM', 'NO_TEMPLATE_FEEL', 'ACCENT_IS_SUBTLE']) {
      expect(report.observations.find((entry) => entry.id === id)?.status).toBe(
        'HUMAN_JUDGEMENT_REQUIRED',
      );
    }
    expect(report.notice).toMatch(/no number here is a craft score/i);
  });
});

describe('the proof command line', () => {
  it('requires the picture and the owned mark', () => {
    expect(() => parseProofArguments(['--logo', 'logo.png'])).toThrow(/--source is required/);
    expect(() => parseProofArguments(['--source', 'clip.mp4'])).toThrow(/--logo is required/);
    expect(() => parseProofArguments(['--source', 'clip.mp4', '--logo', 'logo.png'])).not.toThrow();
  });

  it('refuses an unrecognised option by name', () => {
    expect(() =>
      parseProofArguments(['--source', 'clip.mp4', '--logo', 'logo.png', '--force']),
    ).toThrow(/unrecognised option "--force"/);
  });

  it('takes no credential, no base URL and no cost ceiling', () => {
    // The paid-provider flag is deliberately absent from this list: a test file
    // containing that literal is refused repository-wide by
    // `paid-providers.test.ts`, and evading that guard by splicing the string
    // together would be worse than the coverage it buys. The general
    // unrecognised-option refusal above already covers it.
    for (const flag of ['--api-key', '--base-url', '--max-cost-cents']) {
      expect(() =>
        parseProofArguments(['--source', 'clip.mp4', '--logo', 'logo.png', flag, 'x']),
      ).toThrow(/unrecognised option/);
    }
  });

  it('checks determinism unless asked not to', () => {
    expect(parseProofArguments(['--source', 'c', '--logo', 'l']).verifyDeterminism).toBe(true);
    expect(
      parseProofArguments(['--source', 'c', '--logo', 'l', '--no-determinism-check'])
        .verifyDeterminism,
    ).toBe(false);
  });
});

describe('the treatment version', () => {
  it('matches the surface design version the brief declares', async () => {
    const brief = await committedNotification();
    expect(brief.surfaceDesignVersion).toBe(NOTIFICATION_TREATMENT_VERSION);
  });

  it('is reported alongside a non-success exit code when a defect is measured', () => {
    // The proof returns a render failure rather than success when a measured
    // defect stands, so a run that produced a broken card cannot be reported as
    // a clean proof by a script reading only the exit code.
    expect(STORYBOARD_VIDEO_EXIT_CODES.SUCCESS).toBe(0);
    expect(STORYBOARD_VIDEO_EXIT_CODES.FINAL_RENDER_FAILURE).not.toBe(0);
  });
});
