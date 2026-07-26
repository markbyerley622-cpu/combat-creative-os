import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InMemoryReferenceStore } from '@combat/database';
import { ReferenceIngestionManifestV1Schema } from '@combat/domain';
import { NodeCommandRunner, computeSceneStatistics, resolveFfmpegBinaries } from '@combat/media';
import { FfmpegSceneDetectionProvider, MockTranscriptionProvider } from '@combat/providers';

import { generateReferenceFixtures } from './generate-reference-fixtures';
import { ingestReferences } from './ingest-references';
import { projectToFiftyOne } from './fiftyone-projection';

/**
 * The Creative Memory acceptance fixture.
 *
 * Ingests three deliberately different synthetic advertisements — fast-cut
 * vertical, slow-cut vertical, landscape two-shot — plus one link-only record,
 * and proves the pipeline end to end with **real** scene detection and **real**
 * frame extraction. Nothing third-party is involved: the fixtures are built
 * from FFmpeg `lavfi` colour sources, which is the point. A system for
 * studying other people's advertisements must be testable without holding any.
 *
 * Skips loudly when FFmpeg is unavailable, matching CLAUDE.md's rule that CI
 * never invokes real FFmpeg.
 */

const binaries = resolveFfmpegBinaries(process.env);
const available = spawnSync(binaries.ffprobe, ['-version'], { timeout: 15_000 }).status === 0;
const suite = available ? describe : describe.skip;

if (!available) {
  // eslint-disable-next-line no-console -- a silently skipped acceptance test is worse than a noisy one
  console.warn(
    `[creative-memory] SKIPPED: ffprobe not runnable at "${binaries.ffprobe}". Set FFMPEG_PATH/FFPROBE_PATH to run the ingestion acceptance fixture.`,
  );
}

const WORKSPACE = '6f1d5f6c-6d3a-4a2e-9c5f-0f2a1b3c4d5e';

suite('Creative Memory ingestion acceptance', () => {
  let fixtureDirectory: string;
  let analysisDirectory: string;
  let store: InMemoryReferenceStore;
  let result: Awaited<ReturnType<typeof ingestReferences>>;

  beforeAll(async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'cm-fixtures-'));
    analysisDirectory = await mkdtemp(join(tmpdir(), 'cm-analysis-'));
    await generateReferenceFixtures(fixtureDirectory, binaries);

    store = new InMemoryReferenceStore();
    const manifest = ReferenceIngestionManifestV1Schema.parse({
      manifestVersion: 1,
      library: 'acceptance',
      workspaceId: WORKSPACE,
      references: [
        entry('fast', 'ref-fast-cut-vertical.mp4'),
        entry('slow', 'ref-slow-cut-vertical.mp4'),
        entry('landscape', 'ref-landscape-two-shot.mp4'),
        {
          referenceId: 'link-only',
          title: 'Link-only professional reference',
          brand: 'Third-party brand',
          officialUrl: 'https://example.com/official',
          accessBasis: 'PUBLICLY_PUBLISHED_URL',
          rightsClassification: 'LINK_ONLY',
          rightsHolder: 'Third party',
          permittedUses: ['manual research via the official public URL'],
          prohibitedUses: ['no use in any produced advertisement or other output'],
          businessRoles: ['REFERENCE_INTELLIGENCE'],
        },
      ],
    });

    result = await ingestReferences({
      manifest,
      manifestDir: fixtureDirectory,
      db: store,
      sceneDetector: new FfmpegSceneDetectionProvider(binaries, new NodeCommandRunner()),
      transcriber: new MockTranscriptionProvider(),
      binaries,
      referenceRoots: [fixtureDirectory],
      analysisDirectory,
    });
  }, 600_000);

  afterAll(async () => {
    await rm(fixtureDirectory, { recursive: true, force: true }).catch(() => undefined);
    await rm(analysisDirectory, { recursive: true, force: true }).catch(() => undefined);
  });

  function entry(id: string, filename: string) {
    return {
      referenceId: id,
      title: `Synthetic ${id}`,
      brand: 'Combat Creative OS (synthetic)',
      localAnalysisPath: `./${filename}`,
      accessBasis: 'OWN_PAST_WORK',
      rightsClassification: 'OWNED_REFERENCE',
      rightsHolder: 'Combat Reviews',
      permittedUses: ['private structural analysis'],
      prohibitedUses: ['no use in any produced advertisement or other output'],
      businessRoles: ['MOTION_AND_TRANSITIONS'],
      annotation: {
        authorId: 'acceptance',
        transferablePrinciple: 'Pacing is measurable independently of taste.',
        prohibitedDirectSimilarity: 'Do not copy any third-party cut pattern.',
        reviewerConfidence: 'HIGH' as const,
      },
    };
  }

  const outcome = (id: string) => result.outcomes.find((o) => o.referenceId === id);

  it('ingests the three local references and registers the link-only one', () => {
    expect(result.failedCount).toBe(0);
    expect(outcome('fast')?.status).toBe('INGESTED');
    expect(outcome('slow')?.status).toBe('INGESTED');
    expect(outcome('landscape')?.status).toBe('INGESTED');
    expect(outcome('link-only')?.status).toBe('REGISTERED_LINK_ONLY');
  });

  it('detects the real scene boundaries of each fixture', () => {
    // Six one-second scenes, three scenes, and two scenes respectively — the
    // detector finds the actual cuts, it is not told them.
    expect(outcome('fast')?.sceneCount).toBe(6);
    expect(outcome('slow')?.sceneCount).toBe(3);
    expect(outcome('landscape')?.sceneCount).toBe(2);
  });

  it('places the boundaries at the right timestamps', async () => {
    const scenes = store
      .snapshot('referenceScene')
      .filter((row) => row.detectionMethod === 'ffmpeg-select-scene');
    const fast = scenes
      .filter((row) => (row.startSeconds as number) !== undefined)
      .filter((row) => row.durationSeconds === 1)
      .map((row) => row.startSeconds as number)
      .sort((a, b) => a - b);

    // The fast fixture cuts on every whole second.
    expect(fast.slice(0, 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it('extracts three frames per scene, and they exist on disk', async () => {
    expect(outcome('fast')?.frameCount).toBe(18);
    expect(outcome('slow')?.frameCount).toBe(9);
    expect(outcome('landscape')?.frameCount).toBe(6);

    const frames = store.snapshot('referenceFrame');
    for (const frame of frames.slice(0, 5)) {
      const stats = await stat(frame.localPath as string);
      expect(stats.size).toBeGreaterThan(0);
    }
  });

  it('measures craft statistics that distinguish the three references', () => {
    const metrics = store.snapshot('referenceCraftMetrics');
    expect(metrics).toHaveLength(3);

    const bySceneCount = new Map(metrics.map((row) => [row.sceneCount as number, row]));
    const fast = bySceneCount.get(6);
    const slow = bySceneCount.get(3);
    const landscape = bySceneCount.get(2);

    // Pacing genuinely differs, and the measurement reflects it.
    expect(fast?.cutsPerSecond as number).toBeGreaterThan(slow?.cutsPerSecond as number);
    expect(fast?.averageSceneSeconds as number).toBeLessThan(slow?.averageSceneSeconds as number);
    expect(fast?.firstCutSeconds).toBeCloseTo(1, 1);

    // Aspect ratio is measured, never assumed vertical.
    expect(fast?.aspectRatio).toBe('9:16');
    expect(landscape?.aspectRatio).toBe('16:9');
  });

  it('computes scene statistics deterministically', () => {
    const scenes = [
      { startSeconds: 0, durationSeconds: 1 },
      { startSeconds: 1, durationSeconds: 2 },
      { startSeconds: 3, durationSeconds: 3 },
    ];
    const first = computeSceneStatistics(scenes, 6);
    const second = computeSceneStatistics(scenes, 6);
    expect(first).toEqual(second);
    // Three scenes were cut twice, over six seconds.
    expect(first.cutsPerSecond).toBeCloseTo(2 / 6, 4);
    expect(first.medianSceneSeconds).toBe(2);
    expect(first.firstCutSeconds).toBe(1);
  });

  it('records provenance on every derived artefact', () => {
    const derived = store.snapshot('referenceDerivedArtifact');
    expect(derived.length).toBeGreaterThan(0);

    const mediaChecksums = new Set(
      store.snapshot('referenceMedia').map((row) => row.checksumSha256 as string),
    );
    for (const artifact of derived) {
      expect(artifact.analysisOnly).toBe(true);
      expect(artifact.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
      // Traceable back to the exact original it came from.
      expect(mediaChecksums.has(artifact.sourceChecksumSha256 as string)).toBe(true);
      expect(String(artifact.extractionCommand)).toContain('ffmpeg');
      expect(String(artifact.toolVersion).length).toBeGreaterThan(0);
    }
  });

  it('never modifies the original reference files', async () => {
    const media = store.snapshot('referenceMedia');
    for (const row of media) {
      const bytes = await readFile(row.localPath as string);
      const { createHash } = await import('node:crypto');
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.checksumSha256);
    }
  });

  it('keeps derived analysis media out of any production namespace', () => {
    const productionRoot = resolve(process.cwd(), '.aamp-output');
    for (const artifact of store.snapshot('referenceDerivedArtifact')) {
      expect(String(artifact.localPath).startsWith(productionRoot)).toBe(false);
      expect(String(artifact.localPath).startsWith(analysisDirectory)).toBe(true);
    }
  });

  it('produces no technical measurement for the link-only reference', () => {
    const linkOnly = store
      .snapshot('referenceAdvertisement')
      .find((row) => row.referenceKey === 'link-only');
    expect(linkOnly?.mediaAcquired).toBe(false);

    const measured = store
      .snapshot('referenceCraftMetrics')
      .filter((row) => row.referenceAdvertisementId === linkOnly?.id);
    expect(measured).toHaveLength(0);
    expect(
      store
        .snapshot('referenceScene')
        .filter((row) => row.referenceAdvertisementId === linkOnly?.id),
    ).toHaveLength(0);
  });

  it('detects a duplicate on re-ingestion rather than doubling the library', async () => {
    const manifest = ReferenceIngestionManifestV1Schema.parse({
      manifestVersion: 1,
      library: 'acceptance-duplicate',
      workspaceId: WORKSPACE,
      // A different reference id pointing at the same bytes.
      references: [{ ...entry('fast-again', 'ref-fast-cut-vertical.mp4') }],
    });

    const second = await ingestReferences({
      manifest,
      manifestDir: fixtureDirectory,
      db: store,
      sceneDetector: new FfmpegSceneDetectionProvider(binaries, new NodeCommandRunner()),
      binaries,
      referenceRoots: [fixtureDirectory],
      analysisDirectory,
    });

    expect(second.skippedCount).toBe(1);
    expect(second.outcomes[0]?.status).toBe('SKIPPED_DUPLICATE');
    expect(second.outcomes[0]?.detail).toContain('already ingested');
  }, 300_000);

  it('leaves every reference short of retrieval-ready until a human approves', () => {
    for (const reference of store.snapshot('referenceAdvertisement')) {
      expect(reference.processingState).not.toBe('READY_FOR_RETRIEVAL');
    }
  });

  it('projects to FiftyOne without exposing an output-eligible sample', async () => {
    const projection = await projectToFiftyOne({
      db: store,
      workspaceId: WORKSPACE,
      outputDirectory: join(analysisDirectory, '_fiftyone'),
    });

    // Link-only has no media, so it is skipped rather than given a fake path.
    expect(projection.skippedLinkOnly).toBe(1);
    expect(projection.sampleCount).toBeGreaterThanOrEqual(3);

    const payload = JSON.parse(await readFile(projection.samplesPath, 'utf8')) as {
      samples: { analysis_only: boolean; output_permitted: boolean; filepath: string }[];
    };
    for (const sample of payload.samples) {
      expect(sample.analysis_only).toBe(true);
      expect(sample.output_permitted).toBe(false);
      // The projection points at the analysis proxy, never the original.
      expect(sample.filepath).toContain('proxy.mp4');
    }
  }, 120_000);

  it('is idempotent: re-projecting produces the same sample set', async () => {
    const first = await projectToFiftyOne({
      db: store,
      workspaceId: WORKSPACE,
      outputDirectory: join(analysisDirectory, '_fiftyone2'),
    });
    const second = await projectToFiftyOne({
      db: store,
      workspaceId: WORKSPACE,
      outputDirectory: join(analysisDirectory, '_fiftyone3'),
    });
    expect(first.sampleCount).toBe(second.sampleCount);
    expect(await readFile(first.samplesPath, 'utf8')).toBe(
      await readFile(second.samplesPath, 'utf8'),
    );
  }, 120_000);
});
