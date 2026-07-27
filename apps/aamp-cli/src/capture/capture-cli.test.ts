import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveFfmpegBinaries } from '@combat/media';

import { CAPTURE_EXIT_CODES } from './capture-contracts';
import { runCaptureCli, type CaptureCliContext } from './capture-cli';
import { startFixtureSite, type FixtureSite } from './fixture-site';
import { chromiumIsAvailable } from './playwright-capture';

/**
 * `aamp:capture-app`, end to end, against the deterministic fixture site.
 *
 * The properties under test are the ones that decide whether a screenshot can
 * become an advertisement: the inspection-only label, the rights gate, the
 * content-addressed write, and the artefacts. Everything runs against a local
 * server, so nothing here depends on the deployed Combat Reviews site.
 */

const binaries = resolveFfmpegBinaries(process.env);
const chromium = chromiumIsAvailable();
const suite = chromium ? describe : describe.skip;

if (!chromium) {
  // eslint-disable-next-line no-console -- a silently skipped suite is worse than a noisy one
  console.warn(
    '[capture-cli] SKIPPED: no Chromium build is available to Playwright. Install one with "npx playwright install chromium".',
  );
}

const REPOSITORY_ROOT = resolve(__dirname, '..', '..', '..', '..');
const EXAMPLES = resolve(__dirname, '..', '..', 'examples');

let site: FixtureSite;
let workspace: string;

beforeAll(async () => {
  if (!chromium) return;
  site = await startFixtureSite();
  workspace = await mkdtemp(join(tmpdir(), 'aamp-capture-'));
}, 60_000);

afterAll(async () => {
  if (site) await site.close();
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

interface Captured {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

async function runCli(
  argv: readonly string[],
  now = new Date('2026-07-27T12:00:00.000Z'),
): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const context: CaptureCliContext = {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    now: () => now,
  };
  const code = await runCaptureCli(argv, context);
  return { stdout, stderr, code };
}

async function writeSpec(name: string, screens: unknown[]): Promise<string> {
  const path = join(workspace, `${name}.spec.json`);
  await writeFile(
    path,
    JSON.stringify({
      specificationVersion: 1,
      name,
      baseUrl: site.baseUrl,
      allowedHosts: ['127.0.0.1'],
      library: 'fixture library',
      screens,
    }),
    'utf8',
  );
  return path;
}

function screen(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assetId: 'screen-scorecards',
    path: '/events',
    role: 'APP_EVENT_LIST',
    viewport: 'PHONE_PORTRAIT_1080X1920',
    description: 'events list',
    readinessSelector: 'section[aria-label="Recent events"]',
    timeoutMs: 20_000,
    settleMs: 200,
    required: true,
    ...overrides,
  };
}

async function writeRights(overrides: Record<string, unknown> = {}): Promise<string> {
  const path = join(workspace, `rights-${Math.abs(hash(JSON.stringify(overrides)))}.json`);
  await writeFile(
    path,
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
      ...overrides,
    }),
    'utf8',
  );
  return path;
}

function hash(value: string): number {
  let total = 0;
  for (const character of value) total = (total * 31 + character.charCodeAt(0)) | 0;
  return total;
}

suite('aamp:capture-app', () => {
  it('labels an inspection-only capture and refuses it output eligibility', async () => {
    const specPath = await writeSpec('inspection', [screen()]);
    const outputDir = join(workspace, 'inspection-out');
    const result = await runCli(['--spec', specPath, '--output-dir', outputDir]);

    expect(result.code).toBe(CAPTURE_EXIT_CODES.SUCCESS);
    expect(result.stderr).toContain('NOT OUTPUT ELIGIBLE');
    expect(result.stderr).toContain('RIGHTS REVIEW REQUIRED');
    expect(result.stdout).toContain('eligibility:        REVIEW_REQUIRED');

    const captured = JSON.parse(
      await readFile(join(outputDir, 'captured-assets.json'), 'utf8'),
    ) as { assets: { eligibility: string; rightsClassification: string | null }[] };
    expect(captured.assets).toHaveLength(1);
    expect(captured.assets[0]!.eligibility).toBe('REVIEW_REQUIRED');
    expect(captured.assets[0]!.rightsClassification).toBeNull();
  }, 120_000);

  it('writes every artefact, content-addressed, with no credential in any of them', async () => {
    const specPath = await writeSpec('declared', [screen()]);
    const rightsPath = await writeRights();
    const outputDir = join(workspace, 'declared-out');
    const result = await runCli([
      '--spec',
      specPath,
      '--rights',
      rightsPath,
      '--output-dir',
      outputDir,
    ]);

    expect(result.code).toBe(CAPTURE_EXIT_CODES.SUCCESS);
    const entries = await readdir(outputDir);
    for (const filename of [
      'capture-session.json',
      'capture-report.json',
      'redaction-report.json',
      'captured-assets.json',
    ]) {
      expect(entries).toContain(filename);
    }

    const images = await readdir(join(outputDir, 'app-ui'));
    expect(images).toHaveLength(1);
    // Content-addressed: the checksum is in the name.
    const captured = JSON.parse(
      await readFile(join(outputDir, 'captured-assets.json'), 'utf8'),
    ) as {
      assets: {
        assetId: string;
        checksumSha256: string;
        relativePath: string;
        widthPx: number;
        heightPx: number;
        rightsClassification: string;
      }[];
    };
    const asset = captured.assets[0]!;
    expect(images[0]).toBe(`${asset.assetId}-${asset.checksumSha256.slice(0, 16)}.png`);
    expect(asset.widthPx).toBe(1080);
    expect(asset.heightPx).toBe(1920);
    expect(asset.rightsClassification).toBe('OWNED');

    // No cookie, token, header, comment text or account name anywhere.
    for (const filename of entries.filter((entry) => entry.endsWith('.json'))) {
      const text = await readFile(join(outputDir, filename), 'utf8');
      const lowered = text.toLowerCase();
      for (const forbidden of ['cookie', 'set-cookie', 'authorization', 'bearer', '"token"']) {
        expect(lowered).not.toContain(forbidden);
      }
      // The fixture's user-written copy must not have been carried across.
      expect(text).not.toContain('user-written');
      expect(text).not.toContain('community member');
    }
  }, 120_000);

  it('records the blocked mutations without recording a query string', async () => {
    const specPath = await writeSpec('blocked', [screen()]);
    const outputDir = join(workspace, 'blocked-out');
    await runCli(['--spec', specPath, '--output-dir', outputDir]);

    const report = JSON.parse(await readFile(join(outputDir, 'capture-report.json'), 'utf8')) as {
      readOnly: boolean;
      permittedMethods: string[];
      blockedRequests: { method: string; path: string }[];
      blockedRequestTotal: number;
    };
    expect(report.readOnly).toBe(true);
    expect(report.permittedMethods).toEqual(['GET', 'HEAD']);
    expect(report.blockedRequestTotal).toBeGreaterThan(0);
    expect(report.blockedRequests.some((entry) => entry.method === 'POST')).toBe(true);
    for (const entry of report.blockedRequests) expect(entry.path).not.toContain('?');
  }, 120_000);

  it('refuses two screens that photographed identical pixels', async () => {
    const specPath = await writeSpec('duplicate', [
      screen({ assetId: 'screen-a' }),
      screen({ assetId: 'screen-b' }),
    ]);
    const outputDir = join(workspace, 'duplicate-out');
    const result = await runCli(['--spec', specPath, '--output-dir', outputDir]);

    expect(result.code).toBe(CAPTURE_EXIT_CODES.INGESTION_FAILURE);
    expect(result.stderr).toContain('identical to "screen-a"');
  }, 120_000);

  it('refuses an expired rights declaration before capturing anything', async () => {
    const specPath = await writeSpec('expired', [screen()]);
    const rightsPath = await writeRights({ expiresAt: '2026-07-02T00:00:00.000Z' });
    const outputDir = join(workspace, 'expired-out');
    const result = await runCli([
      '--spec',
      specPath,
      '--rights',
      rightsPath,
      '--output-dir',
      outputDir,
    ]);
    expect(result.code).toBe(CAPTURE_EXIT_CODES.RIGHTS_FAILURE);
    expect(result.stderr).toContain('licence term ended');
    await expect(readdir(outputDir)).rejects.toThrow();
  }, 120_000);

  it('refuses a declaration written for another host', async () => {
    const specPath = await writeSpec('wrong-host', [screen()]);
    const rightsPath = await writeRights({ approvedHost: 'someone-else.test' });
    const result = await runCli([
      '--spec',
      specPath,
      '--rights',
      rightsPath,
      '--output-dir',
      join(workspace, 'wrong-host-out'),
    ]);
    expect(result.code).toBe(CAPTURE_EXIT_CODES.RIGHTS_FAILURE);
    expect(result.stderr).toContain('cannot licence another');
  }, 120_000);

  it('exits with the specification code when the specification is invalid', async () => {
    const path = join(workspace, 'broken.spec.json');
    await writeFile(path, JSON.stringify({ specificationVersion: 1 }), 'utf8');
    const result = await runCli(['--spec', path, '--output-dir', join(workspace, 'broken-out')]);
    expect(result.code).toBe(CAPTURE_EXIT_CODES.INVALID_SPECIFICATION);
  }, 60_000);

  it('builds a contact sheet of the approved screenshots when FFmpeg is present', async () => {
    const ffmpegPresent =
      spawnSync(binaries.ffmpeg, ['-version'], { timeout: 15_000 }).status === 0;
    const specPath = await writeSpec('sheet', [
      screen({ assetId: 'screen-scorecards' }),
      screen({
        assetId: 'screen-predictions',
        path: '/leaderboard',
        role: 'APP_PREDICTION',
        readinessSelector: '#main',
      }),
    ]);
    const outputDir = join(workspace, 'sheet-out');
    const result = await runCli([
      '--spec',
      specPath,
      '--rights',
      await writeRights(),
      '--output-dir',
      outputDir,
    ]);
    expect(result.code).toBe(CAPTURE_EXIT_CODES.SUCCESS);
    const entries = await readdir(outputDir);
    if (ffmpegPresent) {
      expect(entries).toContain('capture-contact-sheet.png');
    } else {
      expect(result.stderr).toContain('no contact sheet');
    }
  }, 180_000);

  it('merges captured screens into the committed preview manifest, preserving plan bindings', async () => {
    const specPath = await writeSpec('merge', [
      screen({ assetId: 'screen-scorecards' }),
      screen({
        assetId: 'screen-predictions',
        path: '/leaderboard',
        role: 'APP_PREDICTION',
        readinessSelector: '#main',
      }),
    ]);
    const outputDir = join(workspace, 'merge-out');
    expect(
      (
        await runCli([
          '--spec',
          specPath,
          '--rights',
          await writeRights(),
          '--output-dir',
          outputDir,
        ])
      ).code,
    ).toBe(CAPTURE_EXIT_CODES.SUCCESS);

    const mergedPath = join(outputDir, 'merged-assets.json');
    const merge = await runCli([
      'merge',
      '--captured',
      join(outputDir, 'captured-assets.json'),
      '--manifest',
      join(EXAMPLES, 'combat-reviews-preview-assets.json'),
      '--output',
      mergedPath,
    ]);
    expect(merge.code).toBe(CAPTURE_EXIT_CODES.SUCCESS);
    expect(merge.stdout).toContain('screen-scorecards');
    expect(merge.stdout).toContain('screen-predictions');

    const merged = JSON.parse(await readFile(mergedPath, 'utf8')) as {
      assets: { id: string; path: string; beats?: string[]; checksumSha256?: string }[];
    };
    const original = JSON.parse(
      await readFile(join(EXAMPLES, 'combat-reviews-preview-assets.json'), 'utf8'),
    ) as { assets: { id: string; beats?: string[] }[] };

    expect(merged.assets).toHaveLength(original.assets.length);
    for (const asset of original.assets) {
      const after = merged.assets.find((entry) => entry.id === asset.id)!;
      expect(after.beats ?? []).toEqual(asset.beats ?? []);
    }
    const replaced = merged.assets.find((entry) => entry.id === 'screen-predictions')!;
    expect(replaced.path).toContain('app-ui/screen-predictions-');
    expect(replaced.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    // Assets nobody captured keep pointing at the fixture root.
    expect(merged.assets.find((entry) => entry.id === 'logo-primary')!.path).toContain(
      'preview-asset-root/brand/logo.png',
    );
  }, 180_000);

  it('refuses to merge an inspection-only capture', async () => {
    const specPath = await writeSpec('merge-review', [screen({ assetId: 'screen-scorecards' })]);
    const outputDir = join(workspace, 'merge-review-out');
    await runCli(['--spec', specPath, '--output-dir', outputDir]);

    const merge = await runCli([
      'merge',
      '--captured',
      join(outputDir, 'captured-assets.json'),
      '--manifest',
      join(EXAMPLES, 'combat-reviews-preview-assets.json'),
      '--output',
      join(outputDir, 'merged.json'),
    ]);
    expect(merge.code).toBe(CAPTURE_EXIT_CODES.RIGHTS_FAILURE);
    expect(merge.stderr).toContain('REVIEW_REQUIRED');
  }, 120_000);

  it('reports zero paid provider calls in machine-readable output', async () => {
    const specPath = await writeSpec('json', [screen()]);
    const outputDir = join(workspace, 'json-out');
    const result = await runCli(['--spec', specPath, '--output-dir', outputDir, '--json']);
    const parsed = JSON.parse(result.stdout) as { paidProviderCalls: number; rightsMode: string };
    expect(parsed.paidProviderCalls).toBe(0);
    expect(parsed.rightsMode).toBe('INSPECTION_ONLY');
  }, 120_000);
});
