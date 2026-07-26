import { describe, expect, it } from 'vitest';

import { GenerationManifestValidationError, parseGenerationManifest } from './generation-manifest';

const VALID = {
  manifestVersion: 1,
  name: 'combat-reviews-15s',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  campaignId: '11111111-1111-4111-8111-111111111111',
  brandName: 'Combat Reviews',
  campaignPrompt: 'Show fight fans that Combat Reviews settles every argument.',
  objective: 'Drive app installs',
  targetAudience: 'Combat sports fans aged 18-34',
  hook: 'Who really won that round?',
  outputDurationSeconds: 15,
  cta: { headline: 'Download Combat Reviews', durationSeconds: 3 },
  assets: [
    {
      id: 'logo',
      role: 'LOGO',
      kind: 'IMAGE',
      path: './logo.png',
      description: 'Combat Reviews logo',
      license: { usageClass: 'OWNED', rightsHolder: 'Combat Reviews', licenseType: 'FULL_BUY_OUT' },
    },
    {
      id: 'app-1',
      role: 'APP_SCREENSHOT',
      kind: 'IMAGE',
      path: './app-1.png',
      description: 'Scorecard screen',
      license: { usageClass: 'OWNED', rightsHolder: 'Combat Reviews', licenseType: 'FULL_BUY_OUT' },
    },
  ],
};

const withAssets = (assets: unknown[]) => ({ ...VALID, assets });

describe('campaign generation manifest', () => {
  it('accepts a well-formed manifest and applies defaults', () => {
    const manifest = parseGenerationManifest(VALID);
    expect(manifest.generation.profile).toBe('LTX_2_3_DRAFT');
    expect(manifest.generation.shotCount).toBe(1);
    expect(manifest.generation.candidateCount).toBe(1);
  });

  it('rejects an unknown top-level key rather than ignoring it', () => {
    expect(() => parseGenerationManifest({ ...VALID, renderNow: true })).toThrow(
      GenerationManifestValidationError,
    );
  });

  it('rejects a manifest version it does not understand', () => {
    expect(() => parseGenerationManifest({ ...VALID, manifestVersion: 2 })).toThrow(
      GenerationManifestValidationError,
    );
  });

  it('refuses an ANALYSIS_ONLY asset at parse time', () => {
    const manifest = withAssets([
      ...VALID.assets,
      {
        id: 'ref',
        role: 'REFERENCE_IMAGE',
        kind: 'IMAGE',
        path: './someone-elses-ad.png',
        description: 'A competitor advertisement',
        license: {
          usageClass: 'ANALYSIS_ONLY',
          rightsHolder: 'Third party',
          licenseType: 'REFERENCE',
        },
      },
    ]);

    expect(() => parseGenerationManifest(manifest)).toThrow(/never placed in an output manifest/);
  });

  it('requires a logo and an app screenshot', () => {
    expect(() => parseGenerationManifest(withAssets([VALID.assets[0]]))).toThrow(
      /APP_SCREENSHOT asset is required/,
    );
    expect(() => parseGenerationManifest(withAssets([VALID.assets[1]]))).toThrow(
      /LOGO asset is required/,
    );
  });

  it('rejects a role/kind mismatch', () => {
    expect(() =>
      parseGenerationManifest(
        withAssets([
          ...VALID.assets,
          {
            id: 'music',
            role: 'MUSIC',
            kind: 'IMAGE',
            path: './bed.png',
            description: 'not actually audio',
            license: {
              usageClass: 'OWNED',
              rightsHolder: 'Combat Reviews',
              licenseType: 'FULL_BUY_OUT',
            },
          },
        ]),
      ),
    ).toThrow(/MUSIC asset must be AUDIO/);
  });

  it('rejects duplicate asset ids', () => {
    expect(() => parseGenerationManifest(withAssets([...VALID.assets, VALID.assets[0]]))).toThrow(
      /duplicate asset id/,
    );
  });

  it('refuses a CTA as long as the whole cut', () => {
    expect(() =>
      parseGenerationManifest({ ...VALID, cta: { headline: 'Go', durationSeconds: 15 } }),
    ).toThrow(/as long as the whole cut/);
  });

  it('refuses to plan more generated footage than the cut can hold', () => {
    expect(() =>
      parseGenerationManifest({
        ...VALID,
        outputDurationSeconds: 6,
        generation: { shotCount: 3, maxShotDurationSeconds: 4 },
      }),
    ).toThrow(/but the cut is only 6s/);
  });

  it('reports every problem at once rather than the first', () => {
    try {
      parseGenerationManifest({ ...VALID, assets: [], cta: { headline: '', durationSeconds: 3 } });
      expect.unreachable('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(GenerationManifestValidationError);
      expect((error as GenerationManifestValidationError).issues.length).toBeGreaterThan(1);
    }
  });
});
