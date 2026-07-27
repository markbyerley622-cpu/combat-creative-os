import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseProductionAssetManifest } from '../production-assets';
import type { CapturedAppAsset } from './capture-contracts';
import { CaptureMergeError, mergeCapturedAssets } from './manifest-merge';

const EXAMPLES = resolve(__dirname, '..', '..', 'examples');
const PREVIEW_MANIFEST = resolve(EXAMPLES, 'combat-reviews-preview-assets.json');

/** The three synthetic UI stills the committed preview plan binds beats to. */
const REPLACEABLE = ['screen-fight-card', 'screen-predictions', 'screen-scorecards'] as const;

function captured(assetId: string, overrides: Partial<CapturedAppAsset> = {}): CapturedAppAsset {
  return {
    assetId,
    role: 'APP_EVENT_LIST',
    eligibility: 'OUTPUT_ELIGIBLE',
    rightsClassification: 'OWNED',
    rightsBasis: 'OWNED_UI_CAPTURE',
    relativePath: `app-ui/${assetId}-0123456789abcdef.png`,
    checksumSha256: 'a'.repeat(64),
    widthPx: 1080,
    heightPx: 1920,
    format: 'png',
    sizeBytes: 400_000,
    provenance: {
      sourceHost: 'example.test',
      sourcePath: '/events',
      queryPresent: false,
      capturedAt: '2026-07-27T12:00:00.000Z',
      viewport: 'PHONE_PORTRAIT_1080X1920',
      viewportWidthCssPx: 360,
      viewportHeightCssPx: 640,
      deviceScaleFactor: 3,
      specificationVersion: 1,
      specificationName: 'fixture',
      rightsDeclarationVersion: 1,
      browserEngine: 'chromium',
      browserVersion: '0.0.0',
      playwrightVersion: '0.0.0',
      redactedElementCount: 2,
      croppedToSelector: false,
    },
    ...overrides,
  };
}

async function baseManifest(): Promise<ReturnType<typeof parseProductionAssetManifest>> {
  return parseProductionAssetManifest(
    JSON.parse(await readFile(PREVIEW_MANIFEST, 'utf8')),
    PREVIEW_MANIFEST,
  );
}

describe('merging captured screens into the production asset manifest', () => {
  it('replaces exactly the intended ids and preserves every other asset', async () => {
    const manifest = await baseManifest();
    const { manifest: merged, report } = mergeCapturedAssets({
      manifest,
      manifestDirectory: EXAMPLES,
      captured: REPLACEABLE.map((id, index) =>
        captured(id, { checksumSha256: String(index).repeat(64) }),
      ),
      captureDirectory: '/tmp/capture',
      outputManifestDirectory: '/tmp/capture',
    });

    expect(report.replaced.map((entry) => entry.assetId).sort()).toEqual([...REPLACEABLE].sort());
    expect(merged.assets).toHaveLength(manifest.assets.length);
    expect(report.preserved).toHaveLength(manifest.assets.length - REPLACEABLE.length);

    // Everything that was not captured keeps its identity untouched.
    for (const original of manifest.assets) {
      const after = merged.assets.find((entry) => entry.id === original.id)!;
      expect(after.kind).toBe(original.kind);
      expect(after.role).toBe(original.role);
      expect(after.beats).toEqual(original.beats);
      expect(after.tags).toEqual(original.tags);
      if (!REPLACEABLE.includes(original.id as (typeof REPLACEABLE)[number])) {
        expect(after.checksumSha256).toBe(original.checksumSha256);
      }
    }
  });

  it('preserves the plan bindings of a replaced asset and pins it to the captured bytes', async () => {
    const manifest = await baseManifest();
    const original = manifest.assets.find((entry) => entry.id === 'screen-predictions')!;
    const { manifest: merged } = mergeCapturedAssets({
      manifest,
      manifestDirectory: EXAMPLES,
      captured: [captured('screen-predictions', { role: 'APP_PREDICTION' })],
      captureDirectory: '/tmp/capture',
      outputManifestDirectory: '/tmp/capture',
    });

    const after = merged.assets.find((entry) => entry.id === 'screen-predictions')!;
    // Bindings the creative plan reads.
    expect(after.beats).toEqual(original.beats);
    expect(after.role).toBe(original.role);
    expect(after.kind).toBe('IMAGE');
    // Facts about the file, taken from the capture.
    expect(after.checksumSha256).toBe('a'.repeat(64));
    expect(after.declaredWidthPx).toBe(1080);
    expect(after.declaredHeightPx).toBe(1920);
    expect(after.path).toBe('./app-ui/screen-predictions-0123456789abcdef.png');
    expect(after.rights.classification).toBe('OWNED');
    expect(after.rights.permittedOutputUse).toBe(true);
  });

  it('is deterministic: the same inputs produce byte-identical output', async () => {
    const manifest = await baseManifest();
    const run = (): string =>
      JSON.stringify(
        mergeCapturedAssets({
          manifest,
          manifestDirectory: EXAMPLES,
          captured: REPLACEABLE.map((id) => captured(id)).map((asset, index) => ({
            ...asset,
            checksumSha256: String(index).repeat(64),
          })),
          captureDirectory: '/tmp/capture',
          outputManifestDirectory: '/tmp/capture',
        }).manifest,
      );
    expect(run()).toBe(run());
  });

  it('refuses an inspection-only capture rather than skipping it', async () => {
    const manifest = await baseManifest();
    expect(() =>
      mergeCapturedAssets({
        manifest,
        manifestDirectory: EXAMPLES,
        captured: [
          captured('screen-predictions', {
            eligibility: 'REVIEW_REQUIRED',
            rightsClassification: null,
            rightsBasis: null,
          }),
        ],
        captureDirectory: '/tmp/capture',
        outputManifestDirectory: '/tmp/capture',
      }),
    ).toThrow(CaptureMergeError);
  });

  it('refuses a capture that claims eligibility with no classification', async () => {
    const manifest = await baseManifest();
    expect(() =>
      mergeCapturedAssets({
        manifest,
        manifestDirectory: EXAMPLES,
        captured: [captured('screen-predictions', { rightsClassification: null })],
        captureDirectory: '/tmp/capture',
        outputManifestDirectory: '/tmp/capture',
      }),
    ).toThrow(/cannot be true at the same time/);
  });

  it('reports a captured id that matches nothing rather than appending it', async () => {
    const manifest = await baseManifest();
    const { manifest: merged, report } = mergeCapturedAssets({
      manifest,
      manifestDirectory: EXAMPLES,
      captured: [captured('screen-nobody-asked-for')],
      captureDirectory: '/tmp/capture',
      outputManifestDirectory: '/tmp/capture',
    });
    expect(report.replaced).toEqual([]);
    expect(report.notMerged.map((entry) => entry.assetId)).toEqual(['screen-nobody-asked-for']);
    expect(merged.assets.some((entry) => entry.id === 'screen-nobody-asked-for')).toBe(false);
  });

  it('re-validates the merged document against the production schema', async () => {
    const manifest = await baseManifest();
    // A capture whose id belongs to the LOGO asset would change its kind
    // agreement; the merge must not be able to produce a manifest the existing
    // parser would refuse.
    const { manifest: merged } = mergeCapturedAssets({
      manifest,
      manifestDirectory: EXAMPLES,
      captured: [captured('screen-scorecards')],
      captureDirectory: '/tmp/capture',
      outputManifestDirectory: '/tmp/capture',
    });
    expect(() => parseProductionAssetManifest(merged)).not.toThrow();
    expect(merged.assets.some((entry) => entry.role === 'LOGO')).toBe(true);
  });

  it('cannot introduce analysis-only material, because the schema refuses it', async () => {
    const manifest = await baseManifest();
    const { manifest: merged } = mergeCapturedAssets({
      manifest,
      manifestDirectory: EXAMPLES,
      captured: [captured('screen-scorecards')],
      captureDirectory: '/tmp/capture',
      outputManifestDirectory: '/tmp/capture',
    });
    for (const asset of merged.assets) {
      expect(['OWNED', 'COMMISSIONED', 'LICENSED_FOR_OUTPUT']).toContain(
        asset.rights.classification,
      );
      expect(asset.rights.permittedOutputUse).toBe(true);
    }
  });
});
