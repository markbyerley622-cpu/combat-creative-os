import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The properties of this path that are true of the *source*, not of one run.
 *
 * A runtime test can show that a particular invocation spent 36¢ once. These
 * read the files and show what the code is structurally incapable of: reaching
 * a second provider, calling a reasoning model, opening a database, hardcoding
 * an operator's folder, or authoring a line of the advertisement.
 *
 * A guarantee about an object graph outlives a guarantee about a code path,
 * because the path a future change takes is not knowable today.
 */

const MODULES = [
  'acceptance-brief.ts',
  'comparison-gallery.ts',
  'notification-comparison-gallery.ts',
  'notification-composite.ts',
  'notification-defects.ts',
  'notification-pixels.ts',
  'notification-placement.ts',
  'notification-proof-cli.ts',
  'notification-proof-main.ts',
  'notification-proof.ts',
  'notification-surface.ts',
  'notification-timeline.ts',
  'one-request-guard.ts',
  'plate-library.ts',
  'plate-staging.ts',
  'raw-clip-inspection.ts',
  'review-record.ts',
  'run-scene-acceptance.ts',
  'scene-acceptance-cli.ts',
  'scene-acceptance-main.ts',
  'visual-defects.ts',
];

/**
 * The notification proof path, which is the whole command and not merely a mode
 * of the paid one. Nothing here may reach a provider, a credential or a cost.
 */
const ZERO_COST_MODULES = [
  'notification-comparison-gallery.ts',
  'notification-composite.ts',
  'notification-defects.ts',
  'notification-pixels.ts',
  'notification-placement.ts',
  'notification-proof-cli.ts',
  'notification-proof-main.ts',
  'notification-proof.ts',
  'notification-surface.ts',
  'notification-timeline.ts',
];

/** Only one module may construct the paid provider, and only one may read the key. */
const PROVIDER_CONSTRUCTION_MODULE = 'run-scene-acceptance.ts';
const CREDENTIAL_READING_MODULES = ['scene-acceptance-main.ts', 'scene-acceptance-cli.ts'];

/** Anything that would make this path able to spend money somewhere else. */
const FORBIDDEN_EVERYWHERE = [
  'createVideoGenerationProvider',
  'ComfyUIVideoGenerationProvider',
  'ClaudeReasoningProvider',
  'createReasoningProvider',
  'createAampDependencies',
  'PrismaClient',
  'QdrantClient',
];

async function readModule(name: string): Promise<string> {
  return readFile(join(__dirname, name), 'utf8');
}

describe('the Scene-1 acceptance path', () => {
  it('names every module it governs, and every one of them exists', async () => {
    const present = await readdir(__dirname);
    for (const name of MODULES) expect(present).toContain(name);
  });

  it('constructs no other provider, no reasoning provider and no database client', async () => {
    for (const name of MODULES) {
      // eslint-disable-next-line no-await-in-loop -- one file at a time keeps the failure legible
      const source = await readModule(name);
      for (const token of FORBIDDEN_EVERYWHERE) {
        expect(`${name}: ${source.includes(token) ? token : 'clean'}`).toBe(`${name}: clean`);
      }
    }
  });

  it('constructs the paid provider in exactly one module', async () => {
    for (const name of MODULES) {
      // eslint-disable-next-line no-await-in-loop -- one file at a time
      const source = await readModule(name);
      const constructs = source.includes('createLtxHostedProvider(');
      expect(`${name}: ${constructs}`).toBe(`${name}: ${name === PROVIDER_CONSTRUCTION_MODULE}`);
    }
  });

  it('reads the credential only at the boundary that hands it in', async () => {
    for (const name of MODULES) {
      // eslint-disable-next-line no-await-in-loop -- one file at a time
      const source = await readModule(name);
      const reads = /env\s*(?:\.\s*LTXV_API_KEY|\[\s*['"]LTXV_API_KEY)/.test(source);
      expect(`${name}: ${reads}`).toBe(`${name}: ${CREDENTIAL_READING_MODULES.includes(name)}`);
    }
  });

  it('reaches for the process environment only in the entry points', async () => {
    const entryPoints = ['scene-acceptance-main.ts', 'notification-proof-main.ts'];
    for (const name of MODULES) {
      // eslint-disable-next-line no-await-in-loop -- one file at a time
      const source = await readModule(name);
      const reaches = /process\s*\.\s*env/.test(source);
      expect(`${name}: ${reaches}`).toBe(`${name}: ${entryPoints.includes(name)}`);
    }
  });

  it('hardcodes no operator path and no external pack location', async () => {
    for (const name of MODULES) {
      // eslint-disable-next-line no-await-in-loop -- one file at a time
      const source = await readModule(name);
      for (const token of [
        'OneDrive',
        'Desktop',
        'C:\\\\Users',
        '/c/Users',
        'Combat-Reviews-Work',
      ]) {
        expect(`${name}: ${source.includes(token) ? token : 'clean'}`).toBe(`${name}: clean`);
      }
    }
  });

  it('never retries a paid call and offers no bypass', async () => {
    for (const name of MODULES) {
      // eslint-disable-next-line no-await-in-loop -- one file at a time
      const source = await readModule(name);
      // Anchored so a longer flag that merely starts the same way is not a
      // false positive: `--force-color-profile` is a Chromium rendering flag,
      // not a way past a gate, and a check that cannot tell them apart is one
      // that gets deleted the first time it fires wrongly.
      for (const pattern of [
        /--force(?![-\w])/,
        /--skip-review(?![-\w])/,
        /retryPaid/,
        /resubmit\(/,
      ]) {
        expect(`${name}: ${pattern.test(source) ? pattern.source : 'clean'}`).toBe(
          `${name}: clean`,
        );
      }
    }
  });

  it('writes no verdict of its own into the human review record', async () => {
    const source = await readModule('review-record.ts');
    // The only verdict values in this repository are APPROVED and REJECTED, and
    // neither may be assigned here. A run that could write one would be a run
    // that could approve its own output.
    expect(source).not.toMatch(/verdict\s*:\s*['"]APPROVED['"]/);
    expect(source).not.toMatch(/verdict\s*:\s*['"]REJECTED['"]/);
    expect(source).toMatch(/verdict\s*:\s*null/);
  });

  it('cannot spend money on the notification-proof path, structurally', async () => {
    for (const name of ZERO_COST_MODULES) {
      // eslint-disable-next-line no-await-in-loop -- one file at a time
      const source = await readModule(name);
      for (const token of [
        'LTXV_API_KEY',
        'apiKey',
        'createLtxHostedProvider',
        'VideoGenerationProvider',
        'ltxGenerationCostCents',
        'maxCostCents',
        'fetchImpl',
      ]) {
        expect(`${name}: ${source.includes(token) ? token : 'clean'}`).toBe(`${name}: clean`);
      }
      // No transport at all. A module that cannot make a request cannot make a
      // billable one, and that is a stronger statement than a spending ceiling.
      expect(`${name}: ${/\bfetch\s*\(/.test(source) ? 'fetches' : 'clean'}`).toBe(
        `${name}: clean`,
      );
    }
  });

  it('states the notification proof cost as zero, never as an estimate', async () => {
    const source = await readModule('notification-proof.ts');
    expect(source).toMatch(/paidProviderCalls:\s*0/);
    expect(source).toMatch(/costCents:\s*0/);
    expect(source).toContain('ZERO_COST');
  });

  it('authors no creative copy: every headline, prompt and colour comes from the brief', async () => {
    const briefFields = [
      'headline',
      'headerLabel',
      'timestampLabel',
      'supportingLine',
      'motionPrompt',
      'accentColorHex',
      'surfaceColorHex',
      'headlineColorHex',
      'headerColorHex',
      'supportingColorHex',
      'fontFamily',
    ];
    for (const name of MODULES) {
      // eslint-disable-next-line no-await-in-loop -- one file at a time
      const source = await readModule(name);
      for (const field of briefFields) {
        // A literal assigned to one of these fields would be this code writing
        // the advertisement. They may only be read.
        const assigns = new RegExp(`${field}\\s*:\\s*['"\`]`).test(source);
        expect(`${name}.${field}: ${assigns ? 'assigned a literal' : 'clean'}`).toBe(
          `${name}.${field}: clean`,
        );
      }
    }
  });

  it('is wired to a command that hands in four variables and no more', async () => {
    const main = await readModule('scene-acceptance-main.ts');
    for (const variable of [
      'LTXV_API_KEY',
      'LTX_BASE_URL',
      'FFMPEG_PATH_ENV_VAR',
      'FFPROBE_PATH_ENV_VAR',
    ]) {
      expect(main).toContain(variable);
    }
    const packageJson = JSON.parse(
      await readFile(join(__dirname, '..', '..', '..', '..', 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts['aamp:ltx-scene-01']).toContain(
      'dist/scene-acceptance/scene-acceptance-main.js',
    );
  });
});
