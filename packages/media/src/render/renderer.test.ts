import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createFakeToolchain,
  materialiseSources,
  passingOutputProbe,
} from '../test-helpers/fake-render-environment';
import { parseRenderManifest, type RenderManifest } from './manifest';
import {
  deterministicUuid,
  RenderFailedError,
  renderAdvertisement,
  type RenderResult,
} from './renderer';
import { SourceNotLicensedForOutputError } from './source-resolution';

const FIXTURE_MANIFEST_PATH = resolve(
  __dirname,
  '..',
  '..',
  'fixtures',
  'combat-reviews-15s.manifest.json',
);
const NOW = new Date('2026-07-26T12:00:00.000Z');

let fixtureRaw: Record<string, unknown>;
let workRoot: string;
let manifestDir: string;
let outputRoot: string;

beforeAll(async () => {
  fixtureRaw = JSON.parse(await readFile(FIXTURE_MANIFEST_PATH, 'utf8')) as Record<string, unknown>;
});

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'combat-render-'));
  manifestDir = join(workRoot, 'manifest');
  outputRoot = join(workRoot, 'out');
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

function manifest(mutate?: (raw: Record<string, any>) => void): RenderManifest {
  const clone = JSON.parse(JSON.stringify(fixtureRaw)) as Record<string, any>;
  mutate?.(clone);
  return parseRenderManifest(clone);
}

async function render(
  parsed: RenderManifest,
  toolchain: ReturnType<typeof createFakeToolchain>,
  overrides: Partial<Parameters<typeof renderAdvertisement>[1]> = {},
): Promise<RenderResult> {
  return renderAdvertisement(toolchain.runner, {
    manifest: parsed,
    manifestDir,
    allowedSourceRoots: [manifestDir],
    outputRoot,
    binaries: { ffmpeg: toolchain.ffmpegPath, ffprobe: toolchain.ffprobePath },
    now: NOW,
    ...overrides,
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('renderAdvertisement — a passing render', () => {
  it('places the master in the deliverable directory and marks the asset READY', async () => {
    const parsed = manifest();
    await materialiseSources(parsed, manifestDir);
    const toolchain = createFakeToolchain(parsed);

    const result = await render(parsed, toolchain);

    expect(result.status).toBe('READY');
    expect(result.qaReport.verdict).toBe('PASS');
    expect(result.asset.ingestionStatus).toBe('READY');
    expect(result.outputPath.startsWith(outputRoot)).toBe(true);
    expect(result.outputPath).not.toContain('rejected');
    expect(await exists(result.outputPath)).toBe(true);
  });

  it('writes the QA report and the asset record beside the master', async () => {
    const parsed = manifest();
    await materialiseSources(parsed, manifestDir);
    const result = await render(parsed, createFakeToolchain(parsed));

    expect(await exists(result.qaReportPath)).toBe(true);
    const report = JSON.parse(await readFile(result.qaReportPath, 'utf8'));
    expect(report.verdict).toBe('PASS');
    expect(report.outputPath).toBe(result.outputPath);

    const asset = JSON.parse(await readFile(`${result.outputPath}.asset.json`, 'utf8'));
    expect(asset.assetId).toBe(result.asset.assetId);
  });

  it('names the output deterministically from its content, not from a clock or a counter', async () => {
    const parsed = manifest();
    await materialiseSources(parsed, manifestDir);
    const first = await render(parsed, createFakeToolchain(parsed));

    await rm(outputRoot, { recursive: true, force: true });
    const second = await render(parsed, createFakeToolchain(parsed));

    expect(second.renderKey).toBe(first.renderKey);
    expect(second.outputPath).toBe(first.outputPath);
    expect(second.asset.assetId).toBe(first.asset.assetId);
  });

  it('cleans up its temporary job directory on success', async () => {
    const parsed = manifest();
    await materialiseSources(parsed, manifestDir);
    await render(parsed, createFakeToolchain(parsed));
    expect(await exists(join(outputRoot, '.jobs'))).toBe(false);
  });

  it('preserves every source file it read', async () => {
    const parsed = manifest();
    await materialiseSources(parsed, manifestDir);
    const before = await Promise.all(
      parsed.sources.map(async (source) => (await stat(join(manifestDir, source.path))).size),
    );
    await render(parsed, createFakeToolchain(parsed));
    const after = await Promise.all(
      parsed.sources.map(async (source) => (await stat(join(manifestDir, source.path))).size),
    );
    expect(after).toEqual(before);
  });
});

describe('renderAdvertisement — provenance', () => {
  it('records every contributing source with its checksum and licensing terms', async () => {
    const parsed = manifest();
    await materialiseSources(parsed, manifestDir);
    const result = await render(parsed, createFakeToolchain(parsed));

    const { provenance } = result.asset;
    expect(provenance.derivedFromSources.map((s) => s.sourceId).sort()).toEqual(
      parsed.sources.map((s) => s.id).sort(),
    );
    for (const source of provenance.derivedFromSources) {
      expect(source.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(source.sizeBytes).toBeGreaterThan(0);
      expect(['OWNED', 'LICENSED_FOR_OUTPUT']).toContain(source.usageClass);
      expect(source.rightsHolder.length).toBeGreaterThan(0);
      expect(source.licenseType.length).toBeGreaterThan(0);
    }
  });

  it('carries the attribution a licence demands through to the asset record', async () => {
    const parsed = manifest();
    await materialiseSources(parsed, manifestDir);
    const result = await render(parsed, createFakeToolchain(parsed));
    const attributed = result.asset.provenance.derivedFromSources.filter((s) => s.attribution);
    expect(attributed.length).toBeGreaterThan(0);
  });

  it('links the output to its manifest, delivery profile, QA report and render key', async () => {
    const parsed = manifest();
    await materialiseSources(parsed, manifestDir);
    const result = await render(parsed, createFakeToolchain(parsed));

    expect(result.asset.provenance.manifestChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(result.asset.provenance.manifestVersion).toBe(1);
    expect(result.asset.provenance.deliveryProfileKey).toBe('VERTICAL_SHORT_FORM_V1');
    expect(result.asset.provenance.renderKey).toBe(result.renderKey);
    expect(result.asset.provenance.qaReportPath).toBe(result.qaReportPath);
    expect(result.asset.provenance.renderedAt).toBe(NOW.toISOString());
    expect(result.asset.checksum).toBe(result.qaReport.summary.checksumSha256);
    expect(result.asset.workspaceId).toBe(parsed.workspaceId);
    expect(result.asset.campaignId).toBe(parsed.campaignId);
  });

  it('derives a stable UUID-shaped asset id with no clock or randomness', () => {
    expect(deterministicUuid('seed')).toBe(deterministicUuid('seed'));
    expect(deterministicUuid('seed')).not.toBe(deterministicUuid('other'));
    expect(deterministicUuid('seed')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('renderAdvertisement — a render that fails actual-media QA', () => {
  it('never lands in the deliverable directory, and is not READY', async () => {
    const parsed = manifest();
    await materialiseSources(parsed, manifestDir);
    // The encoder produced a square video: technically a complete file,
    // categorically not the requested delivery.
    const wrongSize = passingOutputProbe(parsed.output.durationSeconds) as {
      streams: Record<string, unknown>[];
    };
    (wrongSize.streams[0] as Record<string, unknown>).width = 1080;
    (wrongSize.streams[0] as Record<string, unknown>).height = 1080;

    const result = await render(
      parsed,
      createFakeToolchain(parsed, { outputProbe: wrongSize as unknown as Record<string, unknown> }),
    );

    expect(result.status).toBe('QA_FAILED');
    expect(result.qaReport.verdict).toBe('FAIL');
    expect(result.asset.ingestionStatus).toBe('FAILED');
    expect(result.outputPath).toContain('rejected');
    const readyPath = result.outputPath.replace(`rejected${sep}`, '');
    expect(await exists(readyPath)).toBe(false);
  });

  it('fails when the requested audio stream is missing from the produced file', async () => {
    const parsed = manifest();
    await materialiseSources(parsed, manifestDir);
    const noAudio = passingOutputProbe(parsed.output.durationSeconds) as {
      streams: Record<string, unknown>[];
    };
    noAudio.streams = noAudio.streams.filter((s) => s.codec_type !== 'audio');

    const result = await render(
      parsed,
      createFakeToolchain(parsed, { outputProbe: noAudio as unknown as Record<string, unknown> }),
    );

    expect(result.status).toBe('QA_FAILED');
    expect(
      result.qaReport.measurements.find((m) => m.check === 'audio.streamPresence')?.verdict,
    ).toBe('FAIL');
  });

  it('fails when the produced duration drifts past the declared tolerance', async () => {
    const parsed = manifest();
    await materialiseSources(parsed, manifestDir);
    const result = await render(
      parsed,
      createFakeToolchain(parsed, { outputProbe: passingOutputProbe(15.5) }),
    );
    expect(result.qaReport.verdict).toBe('FAIL');
    const duration = result.qaReport.measurements.find((m) => m.check === 'video.duration');
    expect(duration?.verdict).toBe('FAIL');
    expect(duration?.measured).toBe(15.5);
  });

  it('fails when the opening and closing frames are flat fills', async () => {
    const parsed = manifest();
    await materialiseSources(parsed, manifestDir);
    const result = await render(parsed, createFakeToolchain(parsed, { framePattern: 'FLAT' }));

    expect(result.qaReport.verdict).toBe('FAIL');
    const failed = result.qaReport.measurements.filter((m) => m.verdict === 'FAIL');
    expect(failed.map((m) => m.check)).toEqual(
      expect.arrayContaining(['frame.firstNotBlank', 'frame.finalNotBlank']),
    );
  });

  it('does not reuse a rejected render as if it had passed', async () => {
    const parsed = manifest();
    await materialiseSources(parsed, manifestDir);
    const failing = createFakeToolchain(parsed, { framePattern: 'FLAT' });
    const first = await render(parsed, failing);
    expect(first.status).toBe('QA_FAILED');

    const passing = createFakeToolchain(parsed);
    const second = await render(parsed, passing);
    expect(second.status).toBe('READY');
    expect(second.reused).toBe(false);
    expect(passing.renderInvocations()).toHaveLength(1);
  });
});

describe('renderAdvertisement — idempotency, failure and cancellation', () => {
  it('re-uses an identical completed render instead of re-encoding it', async () => {
    const parsed = manifest();
    await materialiseSources(parsed, manifestDir);

    const first = await render(parsed, createFakeToolchain(parsed));
    expect(first.reused).toBe(false);

    const retry = createFakeToolchain(parsed);
    const second = await render(parsed, retry);

    expect(second.reused).toBe(true);
    expect(second.status).toBe('READY');
    expect(second.outputPath).toBe(first.outputPath);
    expect(second.asset.checksum).toBe(first.asset.checksum);
    expect(retry.renderInvocations()).toHaveLength(0);
  });

  it('re-encodes when told not to reuse', async () => {
    const parsed = manifest();
    await materialiseSources(parsed, manifestDir);
    await render(parsed, createFakeToolchain(parsed));

    const forced = createFakeToolchain(parsed);
    const second = await render(parsed, forced, { reuseExisting: false });
    expect(second.reused).toBe(false);
    expect(forced.renderInvocations()).toHaveLength(1);
  });

  it('treats a changed manifest as a different render', async () => {
    const original = manifest();
    await materialiseSources(original, manifestDir);
    const first = await render(original, createFakeToolchain(original));

    const changed = manifest((raw) => {
      raw.cta.headline = 'Different headline';
    });
    const second = await render(changed, createFakeToolchain(changed));

    expect(second.renderKey).not.toBe(first.renderKey);
    expect(second.outputPath).not.toBe(first.outputPath);
  });

  it('surfaces a non-zero FFmpeg exit as a typed error carrying the stderr tail', async () => {
    const parsed = manifest();
    await materialiseSources(parsed, manifestDir);
    const toolchain = createFakeToolchain(parsed, {
      renderFailure: { exitCode: 1, stderr: 'Error initializing filter xfade' },
    });

    await expect(render(parsed, toolchain)).rejects.toThrow(RenderFailedError);
    await expect(render(parsed, toolchain)).rejects.toThrow(/Error initializing filter xfade/);
  });

  it('cleans up its temporary job directory even when the render fails', async () => {
    const parsed = manifest();
    await materialiseSources(parsed, manifestDir);
    const toolchain = createFakeToolchain(parsed, {
      renderFailure: { exitCode: 1, stderr: 'boom' },
    });
    await expect(render(parsed, toolchain)).rejects.toThrow(RenderFailedError);
    expect(await exists(join(outputRoot, '.jobs'))).toBe(false);
  });

  it('refuses an ANALYSIS_ONLY source before FFmpeg is invoked at all', async () => {
    const parsed = manifest((raw) => {
      raw.sources[4].license.usageClass = 'ANALYSIS_ONLY';
    });
    await materialiseSources(parsed, manifestDir);
    const toolchain = createFakeToolchain(parsed);

    await expect(render(parsed, toolchain)).rejects.toThrow(SourceNotLicensedForOutputError);
    expect(toolchain.renderInvocations()).toHaveLength(0);
  });

  it('passes the render timeout and abort signal down to the encoder invocation', async () => {
    const parsed = manifest();
    await materialiseSources(parsed, manifestDir);
    const toolchain = createFakeToolchain(parsed);
    const controller = new AbortController();

    await render(parsed, toolchain, {
      renderTimeoutMs: 1234,
      signal: controller.signal,
    });

    const call = toolchain.renderInvocations()[0];
    expect(call?.options?.timeoutMs).toBe(1234);
    expect(call?.options?.signal).toBe(controller.signal);
    // The encoder runs inside the job directory, which is what lets the
    // filter graph reference the ASS file by bare filename.
    expect(call?.options?.cwd).toContain('.jobs');
  });

  it('propagates cancellation out of the render rather than swallowing it', async () => {
    const parsed = manifest();
    await materialiseSources(parsed, manifestDir);
    const controller = new AbortController();
    const toolchain = createFakeToolchain(parsed, {
      onRender: () => {
        controller.abort();
        throw Object.assign(new Error('"fake-ffmpeg" was cancelled'), {
          name: 'CommandCancelledError',
        });
      },
    });

    await expect(render(parsed, toolchain, { signal: controller.signal })).rejects.toThrow(
      /cancelled/,
    );
  });
});
