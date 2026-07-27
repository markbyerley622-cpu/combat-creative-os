import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { probeMedia, NodeCommandRunner, resolveFfmpegBinaries } from '@combat/media';

import { runGenerateCli } from '../generate-cli';
import { EXIT_CODES } from '../run-source-campaign';
import { CAPTURE_EXIT_CODES } from './capture-contracts';
import { runCaptureCli, type CaptureCliContext } from './capture-cli';
import { startFixtureSite, type FixtureSite } from './fixture-site';
import { chromiumIsAvailable } from './playwright-capture';

/**
 * The whole milestone in one test: captured UI becomes an advertisement.
 *
 * URL → read-only capture → redaction → rights → content-addressed assets →
 * deterministic manifest merge → the *existing* asset preflight → the
 * *existing* footage-first render → a real MP4 with measured QA.
 *
 * Nothing in the render path is new. That is the point: if the merge is
 * correct, the captured screens are indistinguishable from any other owned
 * still as far as the preview is concerned, and the plan that binds beats to
 * `screen-predictions` and `screen-scorecards` keeps working untouched.
 *
 * The environment is the same hostile one the preview acceptance test uses —
 * `REASONING_PROVIDER=claude` with no API key — so a successful run is also
 * evidence that no reasoning provider was constructed anywhere on this path.
 */

const REPOSITORY_ROOT = resolve(__dirname, '..', '..', '..', '..');
const EXAMPLES = resolve(__dirname, '..', '..', 'examples');
const PREVIEW_ROOT = resolve(
  REPOSITORY_ROOT,
  'packages',
  'media',
  'fixtures',
  'preview-asset-root',
);
const REQUEST = join(EXAMPLES, 'combat-reviews-preview.request.json');
const PLAN = join(EXAMPLES, 'combat-reviews-preview.plan.json');
const BASE_MANIFEST = join(EXAMPLES, 'combat-reviews-preview-assets.json');

const binaries = resolveFfmpegBinaries(process.env);
const chromium = chromiumIsAvailable();
const ffmpeg = spawnSync(binaries.ffprobe, ['-version'], { timeout: 15_000 }).status === 0;
const assetRoot =
  spawnSync(process.execPath, [
    '-e',
    `require('fs').statSync(${JSON.stringify(join(PREVIEW_ROOT, 'combat-clips', 'gym-session.mp4'))})`,
  ]).status === 0;

const available = chromium && ffmpeg && assetRoot;
const suite = available ? describe : describe.skip;

if (!available) {
  // eslint-disable-next-line no-console -- a silently skipped acceptance test is worse than a noisy one
  console.warn(
    `[capture-preview] SKIPPED: needs Chromium (${chromium}), a runnable ffprobe at "${binaries.ffprobe}" (${ffmpeg}) and the generated preview asset root (${assetRoot}). Run "pnpm aamp:fixtures" and "npx playwright install chromium".`,
  );
}

/** No key, and a provider configuration a campaign run refuses outright. */
const HOSTILE_ENV = {
  NODE_ENV: 'development',
  REASONING_PROVIDER: 'claude',
  VIDEO_GENERATION_PROVIDER: 'comfyui',
  ...(process.env.FFMPEG_PATH ? { FFMPEG_PATH: process.env.FFMPEG_PATH } : {}),
  ...(process.env.FFPROBE_PATH ? { FFPROBE_PATH: process.env.FFPROBE_PATH } : {}),
} as const;

/** The three synthetic UI stills the committed manifest declares. */
const REPLACED = ['screen-fight-card', 'screen-predictions', 'screen-scorecards'] as const;

let site: FixtureSite;
let workspace: string;
let root: string;
let mergedManifestPath: string;
let renderExitCode: number;
let runDirectory: string;
let renderStdout = '';

suite('captured UI becomes a rendered advertisement', () => {
  beforeAll(async () => {
    site = await startFixtureSite();
    workspace = await mkdtemp(join(tmpdir(), 'aamp-capture-preview-'));
    root = join(workspace, 'asset-root');

    // An operator's own library, standing in for the synthetic one. Copied so
    // the shared fixture root is never mutated by a test.
    await cp(PREVIEW_ROOT, root, { recursive: true });

    // The same committed manifest, with every path re-expressed relative to
    // this root — exactly what an operator pointing at their own directory
    // has. Nothing about the assets themselves changes.
    const base = JSON.parse(await readFile(BASE_MANIFEST, 'utf8')) as {
      assets: { path: string }[];
    };
    for (const asset of base.assets) {
      const absolute = resolve(EXAMPLES, asset.path);
      asset.path = `./${relative(PREVIEW_ROOT, absolute).split(sep).join('/')}`;
    }
    const basePath = join(root, 'base-assets.json');
    await writeFile(basePath, JSON.stringify(base, null, 2), 'utf8');

    // --- 1. capture -------------------------------------------------------
    const spec = {
      specificationVersion: 1,
      name: 'fixture-ui-capture',
      baseUrl: site.baseUrl,
      allowedHosts: ['127.0.0.1'],
      library: 'fixture UI capture',
      screens: [
        {
          assetId: 'screen-scorecards',
          path: '/forums',
          role: 'APP_DISCUSSION_SANITISED',
          enabled: true,
          viewport: 'PHONE_PORTRAIT_1080X1920',
          description: 'community discussion, sanitised',
          readinessSelector: '#card-talk',
          requiredRedactionSelectors: ['[data-account-name]'],
          timeoutMs: 20_000,
          settleMs: 200,
          required: true,
        },
        {
          assetId: 'screen-predictions',
          path: '/leaderboard',
          role: 'APP_PREDICTION',
          viewport: 'PHONE_PORTRAIT_1080X1920',
          description: 'prediction leaderboard',
          readinessSelector: '#main',
          timeoutMs: 20_000,
          settleMs: 200,
          required: true,
        },
        {
          assetId: 'screen-fight-card',
          path: '/events/fixture-card',
          role: 'APP_FIGHT_CARD',
          viewport: 'PHONE_PORTRAIT_1080X1920',
          description: 'fight card',
          readinessSelector: '#card',
          timeoutMs: 20_000,
          settleMs: 200,
          required: true,
        },
      ],
    };
    const specPath = join(workspace, 'capture.spec.json');
    await writeFile(specPath, JSON.stringify(spec), 'utf8');

    const rightsPath = join(workspace, 'rights.json');
    await writeFile(
      rightsPath,
      JSON.stringify({
        declarationVersion: 1,
        declaringEntity: 'Combat Reviews',
        declaredBy: 'A named person',
        declaredAt: '2026-07-01T00:00:00.000Z',
        approvedHost: '127.0.0.1',
        basis: 'OWNED_UI_CAPTURE',
        uiOwnershipConfirmed: true,
        thirdPartyImagery: 'NONE_PRESENT',
        thirdPartyImageryConfirmed: true,
        approvedOutputChannels: ['TIKTOK'],
        territory: 'WORLDWIDE',
        evidenceReference: 'TICKET-1',
      }),
      'utf8',
    );

    const captureContext = (): CaptureCliContext => ({
      cwd: REPOSITORY_ROOT,
      env: { ...process.env },
      stdout: () => undefined,
      stderr: () => undefined,
      now: () => new Date('2026-07-27T12:00:00.000Z'),
    });

    const captureCode = await runCaptureCli(
      ['--spec', specPath, '--rights', rightsPath, '--output-dir', root],
      captureContext(),
    );
    expect(captureCode).toBe(CAPTURE_EXIT_CODES.SUCCESS);

    // --- 2. merge ---------------------------------------------------------
    mergedManifestPath = join(root, 'merged-assets.json');
    const mergeCode = await runCaptureCli(
      [
        'merge',
        '--captured',
        join(root, 'captured-assets.json'),
        '--manifest',
        basePath,
        '--output',
        mergedManifestPath,
      ],
      captureContext(),
    );
    expect(mergeCode).toBe(CAPTURE_EXIT_CODES.SUCCESS);

    // --- 3. the existing preview, unchanged -------------------------------
    const outputDirectory = join(workspace, 'output');
    renderExitCode = await runGenerateCli(
      [
        '--request',
        REQUEST,
        '--assets',
        mergedManifestPath,
        '--asset-root',
        root,
        '--plan-file',
        PLAN,
        '--output-dir',
        outputDirectory,
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: HOSTILE_ENV,
        stdout: (text) => {
          renderStdout += text;
        },
        stderr: () => undefined,
      },
    );
    const entries = await readdir(outputDirectory);
    runDirectory = join(outputDirectory, entries[0] ?? '');
  }, 900_000);

  afterAll(async () => {
    if (site) await site.close();
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  });

  it('replaced exactly the three intended synthetic ids', async () => {
    const merged = JSON.parse(await readFile(mergedManifestPath, 'utf8')) as {
      assets: { id: string; path: string; beats?: string[]; checksumSha256?: string }[];
    };
    for (const id of REPLACED) {
      const asset = merged.assets.find((entry) => entry.id === id)!;
      expect(asset.path).toContain('app-ui/');
      expect(asset.path).toContain(`${id}-`);
      expect(asset.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // And left everything else pointing where it did.
    expect(merged.assets.find((entry) => entry.id === 'logo-primary')!.path).toBe(
      './brand/logo.png',
    );
    expect(merged.assets.find((entry) => entry.id === 'music-bed')!.path).toBe(
      './audio/music-bed.wav',
    );
  });

  it('kept every plan binding, so the committed plan still validates', async () => {
    const merged = JSON.parse(await readFile(mergedManifestPath, 'utf8')) as {
      assets: { id: string; beats?: string[]; role: string; kind: string }[];
    };
    const original = JSON.parse(await readFile(BASE_MANIFEST, 'utf8')) as {
      assets: { id: string; beats?: string[]; role: string; kind: string }[];
    };
    for (const before of original.assets) {
      const after = merged.assets.find((entry) => entry.id === before.id)!;
      expect(after.beats ?? []).toEqual(before.beats ?? []);
      expect(after.role).toBe(before.role);
      expect(after.kind).toBe(before.kind);
    }
  });

  it('rendered a real advertisement from the captured screens', () => {
    expect(renderExitCode).toBe(EXIT_CODES.SUCCESS);
    expect(renderExitCode).not.toBe(EXIT_CODES.REAL_REASONING_UNAVAILABLE);
    expect(renderStdout).toContain('execution mode:    HUMAN_ASSISTED_PREVIEW');
    expect(renderStdout).toContain('paid calls:        0');
    expect(renderStdout).toContain('RENDERED — REQUIRES HUMAN APPROVAL');
  });

  it('passes actual-media QA, measured from the produced file', async () => {
    const summary = JSON.parse(
      await readFile(join(runDirectory, 'render-summary.json'), 'utf8'),
    ) as { qaVerdict: string; outputPath: string };
    expect(summary.qaVerdict).toBe('PASS');

    const probe = await probeMedia(new NodeCommandRunner(), summary.outputPath, {
      ffprobePath: binaries.ffprobe,
    });
    expect(probe.mediaType).toBe('VIDEO');
    if (probe.mediaType === 'VIDEO') {
      expect(probe.widthPx).toBe(1080);
      expect(probe.heightPx).toBe(1920);
      expect(probe.durationSeconds).toBeCloseTo(15, 2);
      expect(probe.videoCodec).toBe('h264');
      expect(probe.hasAudio).toBe(true);
    }
  }, 120_000);

  it('put the captured screens into the render manifest, checksum-pinned', async () => {
    const manifest = JSON.parse(
      await readFile(join(runDirectory, 'render-manifest.json'), 'utf8'),
    ) as { sources: { id: string; path: string; expectedChecksum?: string }[] };
    // Source paths are absolute, so they carry the platform separator.
    const captured = manifest.sources.filter((source) =>
      source.path.split(sep).join('/').includes('/app-ui/'),
    );
    // The committed plan binds two beats to captured ids; `screen-fight-card`
    // is declared in the library but no beat uses it, so it is not a source.
    expect(captured.map((source) => source.id).sort()).toEqual([
      'screen-predictions',
      'screen-scorecards',
    ]);
    for (const source of captured) {
      expect(source.expectedChecksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('carried no reference material and no analysis-only rights into the manifest', async () => {
    const provenance = JSON.parse(
      await readFile(join(runDirectory, 'asset-provenance.json'), 'utf8'),
    ) as { assets: { rightsClassification: string; path: string }[] };
    expect(provenance.assets.length).toBeGreaterThan(0);
    for (const asset of provenance.assets) {
      expect(['OWNED', 'COMMISSIONED', 'LICENSED_FOR_OUTPUT']).toContain(
        asset.rightsClassification,
      );
      expect(asset.path.split(sep).join('/')).not.toContain('/references/');
    }
  });

  it('left no cookie, token or captured user text in any capture artefact', async () => {
    for (const filename of [
      'capture-session.json',
      'capture-report.json',
      'redaction-report.json',
      'captured-assets.json',
    ]) {
      const text = await readFile(join(root, filename), 'utf8');
      expect(text).not.toContain('User-written thread body');
      expect(text).not.toContain('community member');
      expect(text.toLowerCase()).not.toContain('cookie');
      expect(text.toLowerCase()).not.toContain('bearer');
    }
  });

  it('redacted account identity on the sanitised discussion screen', async () => {
    const report = JSON.parse(await readFile(join(root, 'redaction-report.json'), 'utf8')) as {
      screens: {
        assetId: string;
        role: string;
        userContentRedactionApplied: boolean;
        unsatisfiedRequiredSelectors: string[];
        totalElementsRedacted: number;
      }[];
    };
    const discussion = report.screens.find((entry) => entry.assetId === 'screen-scorecards')!;
    expect(discussion.role).toBe('APP_DISCUSSION_SANITISED');
    // Community writing is shown on this screen by explicit opt-in...
    expect(discussion.userContentRedactionApplied).toBe(false);
    // ...but identity is still covered, and the required selector matched.
    expect(discussion.unsatisfiedRequiredSelectors).toEqual([]);
    expect(discussion.totalElementsRedacted).toBeGreaterThan(0);
  });
});
