import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { MediaProbeResult } from '../types';
import {
  buildRenderPlan,
  buildTypographyFile,
  CAPTION_ASS_FILENAME,
  FilterGraphError,
  OUTPUT_TEMP_FILENAME,
} from './filter-graph';
import { parseRenderManifest, type RenderManifest } from './manifest';
import type { ResolvedSource } from './source-resolution';

const FIXTURE_MANIFEST_PATH = resolve(
  __dirname,
  '..',
  '..',
  'fixtures',
  'combat-reviews-15s.manifest.json',
);

let fixture: RenderManifest;

beforeAll(async () => {
  fixture = parseRenderManifest(JSON.parse(await readFile(FIXTURE_MANIFEST_PATH, 'utf8')));
});

/**
 * Stand-in resolved sources. The graph builder is pure over these, so every
 * assertion below runs offline — which is the point: a filter-graph
 * regression is caught here, not by a forty-second encode.
 */
function fakeSources(manifest: RenderManifest): ReadonlyMap<string, ResolvedSource> {
  const probeFor = (kind: string): MediaProbeResult => {
    if (kind === 'IMAGE') {
      return { mediaType: 'IMAGE', widthPx: 1080, heightPx: 1920, format: 'png' };
    }
    if (kind === 'AUDIO') {
      return {
        mediaType: 'AUDIO',
        durationSeconds: 20,
        codec: 'pcm_s16le',
        channels: 2,
        sampleRateHz: 48000,
      };
    }
    return {
      mediaType: 'VIDEO',
      durationSeconds: 6,
      widthPx: 1920,
      heightPx: 1080,
      frameRate: 30,
      videoCodec: 'h264',
      hasAudio: true,
      audioCodec: 'aac',
    };
  };

  return new Map(
    manifest.sources.map((source) => [
      source.id,
      {
        id: source.id,
        kind: source.kind,
        absolutePath: `C:\\media\\${source.id}`,
        sizeBytes: 1024,
        checksumSha256: 'f'.repeat(64),
        probe: probeFor(source.kind),
        license: source.license,
        description: source.description,
      },
    ]),
  );
}

function planFor(manifest: RenderManifest): ReturnType<typeof buildRenderPlan> {
  return buildRenderPlan({ manifest, sources: fakeSources(manifest) });
}

function filterComplexOf(args: readonly string[]): string {
  const index = args.indexOf('-filter_complex');
  expect(index).toBeGreaterThan(-1);
  return args[index + 1] ?? '';
}

describe('FFmpeg argument construction', () => {
  it('passes every argument as its own array element — nothing is a shell string', () => {
    const plan = planFor(fixture);
    // A single argv element containing an unquoted `&&`, `;` or `|` would be
    // the signature of string-built commands. The filter graph legitimately
    // contains `|` in `adelay`, so it is checked separately.
    for (const arg of plan.args) {
      if (arg === filterComplexOf(plan.args)) continue;
      expect(arg).not.toMatch(/&&|\|\||;/);
    }
    // Every planned input is introduced by its own `-i`, including the
    // generated CTA colour source.
    expect(plan.args.filter((a) => a === '-i').length).toBe(plan.inputs.length);
  });

  it('never puts caption, overlay or CTA copy into an argument', () => {
    const plan = planFor(fixture);
    const copy = [
      ...(fixture.captions?.cues.map((cue) => cue.text) ?? []),
      ...fixture.overlays.flatMap((overlay) => (overlay.kind === 'TEXT' ? [overlay.text] : [])),
      fixture.cta?.headline ?? '',
      fixture.cta?.subline ?? '',
    ].filter(Boolean);

    expect(copy.length).toBeGreaterThan(0);
    for (const text of copy) {
      for (const arg of plan.args) {
        expect(arg).not.toContain(text);
      }
    }
    // It all lives in the ASS file instead, referenced by a bare filename.
    const ass = plan.jobFiles.find((file) => file.name === CAPTION_ASS_FILENAME);
    expect(ass).toBeDefined();
    for (const text of copy) {
      expect(ass?.contents.toUpperCase()).toContain(text.toUpperCase());
    }
  });

  it('references the ASS file by bare filename, so no Windows drive letter enters the filter grammar', () => {
    const plan = planFor(fixture);
    const graph = filterComplexOf(plan.args);
    expect(graph).toContain(`ass=filename=${CAPTION_ASS_FILENAME}`);
    expect(graph).not.toMatch(/[A-Za-z]:\\/);
  });

  it('writes its output to a job-relative filename, never an absolute path', () => {
    const plan = planFor(fixture);
    expect(plan.args[plan.args.length - 1]).toBe(OUTPUT_TEMP_FILENAME);
    expect(plan.outputFileName).toBe(OUTPUT_TEMP_FILENAME);
  });

  it('encodes to the delivery contract: H.264 high, yuv420p, 30 fps, AAC, faststart', () => {
    const args = planFor(fixture).args;
    const valueAfter = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
    expect(valueAfter('-c:v')).toBe('libx264');
    expect(valueAfter('-profile:v')).toBe('high');
    expect(valueAfter('-pix_fmt')).toBe('yuv420p');
    expect(valueAfter('-r')).toBe('30');
    expect(valueAfter('-fps_mode')).toBe('cfr');
    expect(valueAfter('-c:a')).toBe('aac');
    expect(valueAfter('-ar')).toBe('48000');
    expect(valueAfter('-movflags')).toBe('+faststart');
  });

  it('pins the exact requested duration on the output, not just on the filter chain', () => {
    const args = planFor(fixture).args;
    expect(args[args.indexOf('-t') + 1]).toBeDefined();
    // The last `-t` is the output duration; earlier ones bound each input.
    expect(args.lastIndexOf('-t')).toBeGreaterThan(args.indexOf('-filter_complex'));
    expect(args[args.lastIndexOf('-t') + 1]).toBe('15');
  });

  it('strips metadata and sets bitexact flags, so identical inputs can produce identical bytes', () => {
    const args = planFor(fixture).args;
    expect(args[args.indexOf('-map_metadata') + 1]).toBe('-1');
    expect(args).toContain('-fflags');
    expect(args[args.indexOf('-fflags') + 1]).toBe('+bitexact');
  });

  it('builds byte-identical argv for the same manifest', () => {
    expect(planFor(fixture).args).toEqual(planFor(fixture).args);
    expect(planFor(fixture).filterComplex).toBe(planFor(fixture).filterComplex);
  });
});

describe('timeline construction', () => {
  it('computes xfade offsets so each transition overlaps exactly the preceding cut', () => {
    const plan = planFor(fixture);
    const graph = filterComplexOf(plan.args);
    const offsets = [
      ...graph.matchAll(/xfade=transition=[a-z]+:duration=([\d.]+):offset=([\d.]+)/g),
    ];
    expect(offsets).toHaveLength(fixture.scenes.length - 1);

    // Reproduce the arithmetic independently of the builder.
    let mergedLength = fixture.scenes[0]?.durationSeconds ?? 0;
    fixture.scenes.slice(1).forEach((scene, index) => {
      const overlap = scene.transitionIn?.durationSeconds ?? 0;
      const match = offsets[index];
      expect(Number(match?.[1])).toBeCloseTo(overlap, 6);
      expect(Number(match?.[2])).toBeCloseTo(mergedLength - overlap, 6);
      mergedLength = mergedLength + scene.durationSeconds - overlap;
    });
    expect(mergedLength).toBeCloseTo(fixture.output.durationSeconds, 6);
  });

  it('reports the timeline position of every scene', () => {
    const plan = planFor(fixture);
    expect(plan.timeline.map((entry) => entry.sceneId)).toEqual(
      fixture.scenes.map((scene) => scene.id),
    );
    expect(plan.timeline[0]?.startSeconds).toBe(0);
    expect(plan.timeline[plan.timeline.length - 1]?.endSeconds).toBeCloseTo(15, 6);
  });

  it('maps each transition kind onto a distinct xfade treatment, not all onto a fade', () => {
    const graph = filterComplexOf(planFor(fixture).args);
    expect(graph).toContain('xfade=transition=circleopen'); // MASKED_UI_REVEAL
    expect(graph).toContain('xfade=transition=smoothleft'); // WHIP_PAN
    expect(graph).toContain('xfade=transition=fadewhite'); // IMPACT_CUT
    expect(graph).toContain('xfade=transition=fade'); // CROSSFADE
  });

  it('normalises every scene to a common timebase, or xfade would refuse to join them', () => {
    const graph = filterComplexOf(planFor(fixture).args);
    expect((graph.match(/settb=AVTB/g) ?? []).length).toBeGreaterThanOrEqual(fixture.scenes.length);
  });

  it('drives motion from the output frame index, so a push-in lands where it was aimed', () => {
    const graph = filterComplexOf(planFor(fixture).args);
    expect(graph).toMatch(/zoompan=z='1\+[\d.]+\*on\/\d+'/);
    expect(graph).toContain(':d=1:s=1080x1920:fps=30');
  });

  it('composites a parallax scene as two planes moving at different rates', () => {
    const graph = filterComplexOf(planFor(fixture).args);
    // A blurred, darkened backplate that zooms...
    expect(graph).toMatch(/gblur=sigma=28:steps=2,eq=brightness=-0\.12/);
    // ...under a bezelled foreground that drifts vertically over time.
    expect(graph).toMatch(/pad=iw\+20:ih\+20:10:10:color=white/);
    expect(graph).toMatch(/overlay=x='\(W-w\)\/2':y='\(H-h\)\/2\+[\d.]+-[\d.]+\*t\/[\d.]+'/);
  });

  it('trims each input to the scene it feeds rather than decoding the whole clip', () => {
    const plan = planFor(fixture);
    const firstScene = fixture.scenes[0];
    const ss = plan.args.indexOf('-ss');
    expect(plan.args[ss + 1]).toBe(String(firstScene?.trim?.inSeconds));
    expect(plan.args[ss + 2]).toBe('-t');
    expect(plan.args[ss + 3]).toBe(String(firstScene?.durationSeconds));
  });
});

describe('audio graph', () => {
  it('ducks music against the voice envelope with a sidechain, not a scheduled fade', () => {
    const graph = filterComplexOf(planFor(fixture).args);
    expect(graph).toContain('asplit=2[voicemix][voicekey]');
    expect(graph).toMatch(/\[musicbus\]\[voicekey\]sidechaincompress=/);
    expect(graph).toContain('[musicducked]');
  });

  it('normalises loudness to the manifest target and lands on an exactly-length stereo bus', () => {
    const graph = filterComplexOf(planFor(fixture).args);
    expect(graph).toContain('loudnorm=I=-14:TP=-1:LRA=11');
    expect(graph).toContain('atrim=0:15');
    expect(graph).toContain('[aout]');
  });

  it('loops a looping track at the demuxer, and delays a track that starts late', () => {
    const plan = planFor(fixture);
    expect(plan.args).toContain('-stream_loop');
    expect(filterComplexOf(plan.args)).toContain('adelay=1000|1000');
  });

  it('folds a scene that contributes its own audio into the mix', () => {
    const graph = filterComplexOf(planFor(fixture).args);
    // The sparring scene is scene index 2 and sets useSourceAudio.
    expect(graph).toContain('[ascene2]');
  });

  it('refuses a scene that asks for source audio the file does not have', () => {
    const sources = new Map(fakeSources(fixture));
    const sparring = sources.get('clip-sparring');
    if (!sparring || sparring.probe.mediaType !== 'VIDEO') throw new Error('fixture changed');
    sources.set('clip-sparring', {
      ...sparring,
      probe: { ...sparring.probe, hasAudio: false },
    });
    expect(() => buildRenderPlan({ manifest: fixture, sources })).toThrow(FilterGraphError);
  });

  it('emits no audio stream at all when the manifest asks for a silent master', () => {
    const silent: RenderManifest = {
      ...fixture,
      output: { ...fixture.output, audioCodec: null },
      scenes: fixture.scenes.map((scene) => ({ ...scene, useSourceAudio: false })),
      audio: undefined,
    } as RenderManifest;
    const plan = planFor(silent);
    expect(plan.hasAudio).toBe(false);
    expect(plan.args).toContain('-an');
    expect(plan.args).not.toContain('-c:a');
    expect(filterComplexOf(plan.args)).not.toContain('loudnorm');
  });
});

describe('typography file', () => {
  it('carries captions, text overlays and CTA copy in one ASS file with per-element styles', () => {
    const ass = buildTypographyFile(fixture);
    expect(ass).toBeTruthy();
    const contents = ass as string;
    expect(contents).toContain('PlayResX: 1080');
    expect(contents).toContain('PlayResY: 1920');
    expect(contents).toContain('Style: Caption');
    expect(contents).toContain('Style: Overlay0');
    expect(contents).toContain('Style: CtaHeadline');
    expect(contents).toContain('Style: CtaSubline');
  });

  it('animates typography rather than cutting it on and off', () => {
    const contents = buildTypographyFile(fixture) as string;
    expect(contents).toMatch(/\\fad\(\d+,\d+\)/); // fades
    expect(contents).toMatch(/\\move\(/); // slides
    expect(contents).toMatch(/\\t\(0,\d+,\\fscx100\\fscy100\)/); // scale-up pops
  });

  it('returns null when a manifest has no typography at all', () => {
    const bare: RenderManifest = {
      ...fixture,
      overlays: [],
      captions: undefined,
      cta: undefined,
    } as RenderManifest;
    expect(buildTypographyFile(bare)).toBeNull();
  });
});
