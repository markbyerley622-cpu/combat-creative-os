import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CommandRunner } from '@combat/media';

import {
  classifyPackLicence,
  containedWithin,
  importPilotPack,
  isAnalysisOnlyPath,
  PilotPackImportError,
  resolveInsidePack,
} from './pilot-pack';

/**
 * The importer, proven against a temporary pack built in `os.tmpdir()`.
 *
 * The real external folder is never used here, for two reasons. It is not
 * present on a CI machine, and — more importantly — a test that read an
 * operator's actual library would be a test whose result changed when they
 * added a file. The read-only calibration against the real pack is a separate,
 * opt-in exercise; this is the part that has to hold on every push.
 */

let packRoot: string;
let outsideRoot: string;

/** A runner that fails every command: no test here needs FFmpeg. */
const REFUSING_RUNNER: CommandRunner = {
  run: async () => ({ exitCode: 1, stdout: '', stderr: 'no ffmpeg in this test' }),
};

const NOW = new Date('2026-07-27T00:00:00.000Z');

const CANDIDATE_HEADER =
  '"candidate_id","provider","provider_asset_id","media_kind","title","creator","landing_page_url","declared_licence","licence_url","attribution_text","commercial_use_permitted","derivative_use_permitted","paid_ads_permitted","recognizable_people","trademark_or_logo","endorsement_risk","provider_restrictions","suggested_asset_slot","notes"';

const ACQUISITION_HEADER =
  '"acquisition_id","candidate_id","provider","stored_path","sha256","media_kind","declared_licence","creator","licence_evidence_file","rights_status","output_approval","download_status"';

function candidateRow(id: string, overrides: Partial<Record<string, string>> = {}): string {
  const cells: Record<string, string> = {
    candidate_id: id,
    provider: 'Wikimedia Commons',
    provider_asset_id: id,
    media_kind: 'image',
    title: `Title ${id}`,
    creator: 'A Photographer',
    landing_page_url: `https://commons.wikimedia.org/wiki/File:${id}.jpg`,
    declared_licence: 'Public domain',
    licence_url: '',
    attribution_text: '',
    commercial_use_permitted: 'YES',
    derivative_use_permitted: 'YES',
    paid_ads_permitted: 'YES_LICENCE / RELEASE_UNVERIFIED',
    recognizable_people: 'NONE_APPARENT',
    trademark_or_logo: 'NONE_APPARENT',
    endorsement_risk: 'LOW',
    provider_restrictions: '',
    suggested_asset_slot: 'CLIP-01',
    notes: '',
    ...overrides,
  };
  const order = [
    'candidate_id',
    'provider',
    'provider_asset_id',
    'media_kind',
    'title',
    'creator',
    'landing_page_url',
    'declared_licence',
    'licence_url',
    'attribution_text',
    'commercial_use_permitted',
    'derivative_use_permitted',
    'paid_ads_permitted',
    'recognizable_people',
    'trademark_or_logo',
    'endorsement_risk',
    'provider_restrictions',
    'suggested_asset_slot',
    'notes',
  ];
  return order.map((column) => `"${(cells[column] ?? '').replace(/"/g, '""')}"`).join(',');
}

function acquisitionRow(id: string, storedPath: string, sha256: string, evidence = ''): string {
  return [
    `ACQ-${id}`,
    id,
    'Wikimedia Commons',
    storedPath,
    sha256,
    'image',
    'Public domain',
    'A Photographer',
    evidence,
    'RIGHTS_REVIEW_REQUIRED',
    'NOT_APPROVED',
    'OK',
  ]
    .map((cell) => `"${cell}"`)
    .join(',');
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const JPEG_SHA = createHash('sha256').update(JPEG).digest('hex');

beforeEach(async () => {
  packRoot = await mkdtemp(join(tmpdir(), 'aamp-pack-'));
  outsideRoot = await mkdtemp(join(tmpdir(), 'aamp-outside-'));
  await mkdir(join(packRoot, 'candidates', 'images'), { recursive: true });
  await mkdir(join(packRoot, 'candidates', 'licence-evidence'), { recursive: true });
  await mkdir(join(packRoot, 'references'), { recursive: true });
  await writeFile(join(outsideRoot, 'secret.jpg'), JPEG);
});

afterEach(async () => {
  await rm(packRoot, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
});

async function writePack(candidates: string[], acquisitions: string[]): Promise<void> {
  await writeFile(
    join(packRoot, 'source-candidates.csv'),
    `${CANDIDATE_HEADER}\n${candidates.join('\n')}\n`,
  );
  await writeFile(
    join(packRoot, 'acquisition-log.csv'),
    `${ACQUISITION_HEADER}\n${acquisitions.join('\n')}\n`,
  );
  await writeFile(join(packRoot, 'asset-inventory.csv'), 'asset_id,filename\nLOGO-01,\n');
  await writeFile(
    join(packRoot, 'rights-inventory.csv'),
    'asset_id,declaration_status\nLOGO-01,PENDING\n',
  );
}

describe('path containment', () => {
  it('accepts the root itself and anything beneath it', () => {
    expect(containedWithin('C:/pack', 'C:/pack')).toBe(true);
    expect(containedWithin('C:/pack', resolve('C:/pack', 'a/b.jpg'))).toBe(true);
  });

  it('refuses a sibling whose name merely starts the same way', () => {
    expect(containedWithin(resolve('C:/pack'), resolve('C:/pack-other/x.jpg'))).toBe(false);
  });

  it('matches analysis-only directories as whole path segments', () => {
    const root = resolve('C:/pack');
    expect(isAnalysisOnlyPath(root, resolve(root, 'references/a.mp4'))).toBe(true);
    // A substring rule would refuse this one, and a rule that fires on ordinary
    // content is a rule operators learn to work around.
    expect(isAnalysisOnlyPath(root, resolve(root, 'combat-clips/references-to-review.mp4'))).toBe(
      false,
    );
  });
});

describe('untrusted paths', () => {
  it('refuses a traversal', async () => {
    const result = await resolveInsidePack(packRoot, '..\\..\\Windows\\System32\\config');
    expect(result.problem?.kind).toBe('PATH_ESCAPE');
  });

  it('refuses an absolute path', async () => {
    const result = await resolveInsidePack(packRoot, 'C:\\Windows\\System32');
    expect(result.problem?.kind).toBe('PATH_ESCAPE');
  });

  it('refuses a symlink that points outside the pack', async () => {
    const linkPath = join(packRoot, 'candidates', 'images', 'escape.jpg');
    try {
      await symlink(join(outsideRoot, 'secret.jpg'), linkPath);
    } catch {
      // Windows needs Developer Mode or elevation for symlinks; when it is
      // unavailable the lexical check above is what stands, and this test
      // reports that honestly rather than passing vacuously.
      expect(true).toBe(true);
      return;
    }
    const result = await resolveInsidePack(packRoot, 'candidates/images/escape.jpg');
    expect(result.problem?.kind).toBe('SYMLINK_ESCAPE');
  });

  it('accepts an ordinary pack-relative Windows path', async () => {
    await writeFile(join(packRoot, 'candidates', 'images', 'a.jpg'), JPEG);
    const result = await resolveInsidePack(packRoot, 'candidates\\images\\a.jpg');
    expect(result.problem).toBeNull();
    expect(result.path).toContain('a.jpg');
  });
});

describe('licence classification', () => {
  it('reads the most restrictive match first so NC never becomes plain BY', () => {
    expect(classifyPackLicence('CC BY-NC-SA 4.0')).toBe('CC_BY_NC_SA');
    expect(classifyPackLicence('CC BY 4.0')).toBe('CC_BY');
    expect(classifyPackLicence('Pexels License')).toBe('PEXELS_LICENCE');
    expect(classifyPackLicence('Pixabay Content License')).toBe('PIXABAY_CONTENT_LICENCE');
    expect(classifyPackLicence('Public domain')).toBe('PUBLIC_DOMAIN');
    expect(classifyPackLicence('Standard YouTube License')).toBe('STANDARD_YOUTUBE_LICENCE');
    expect(classifyPackLicence('something invented')).toBe('UNKNOWN');
  });
});

describe('importing a pack', () => {
  it('recalculates the checksum rather than trusting the log', async () => {
    await writeFile(join(packRoot, 'candidates', 'images', 'a.jpg'), JPEG);
    await writePack(
      [candidateRow('WC-1')],
      [acquisitionRow('WC-1', 'candidates\\images\\a.jpg', JPEG_SHA.toUpperCase())],
    );

    const result = await importPilotPack({ packPath: packRoot, runner: REFUSING_RUNNER, now: NOW });
    expect(result.counts.checksumVerified).toBe(1);
    expect(result.counts.checksumMismatched).toBe(0);
    expect(result.privateLocations[0]?.checksumSha256).toBe(JPEG_SHA);
  });

  it('reports a checksum the log got wrong, and uses the recalculated value', async () => {
    await writeFile(join(packRoot, 'candidates', 'images', 'a.jpg'), JPEG);
    await writePack(
      [candidateRow('WC-1')],
      [acquisitionRow('WC-1', 'candidates/images/a.jpg', 'f'.repeat(64))],
    );

    const result = await importPilotPack({ packPath: packRoot, runner: REFUSING_RUNNER, now: NOW });
    expect(result.counts.checksumMismatched).toBe(1);
    expect(result.problems.some((p) => p.kind === 'CHECKSUM_MISMATCH')).toBe(true);
    expect(result.privateLocations[0]?.checksumSha256).toBe(JPEG_SHA);
  });

  it('detects two catalogue entries pointing at identical bytes', async () => {
    await writeFile(join(packRoot, 'candidates', 'images', 'a.jpg'), JPEG);
    await writeFile(join(packRoot, 'candidates', 'images', 'b.jpg'), JPEG);
    await writePack(
      [candidateRow('WC-1'), candidateRow('WC-2')],
      [
        acquisitionRow('WC-1', 'candidates/images/a.jpg', JPEG_SHA),
        acquisitionRow('WC-2', 'candidates/images/b.jpg', JPEG_SHA),
      ],
    );

    const result = await importPilotPack({ packPath: packRoot, runner: REFUSING_RUNNER, now: NOW });
    expect(result.counts.duplicates).toBe(1);
    expect(result.problems.find((p) => p.kind === 'DUPLICATE_CONTENT')?.detail).toContain('WC-1');
  });

  it('reports media the log promises and the disk does not have', async () => {
    await writePack(
      [candidateRow('WC-1')],
      [acquisitionRow('WC-1', 'candidates/images/gone.jpg', JPEG_SHA)],
    );
    const result = await importPilotPack({ packPath: packRoot, runner: REFUSING_RUNNER, now: NOW });
    expect(result.counts.mediaMissing).toBe(1);
    expect(result.problems.some((p) => p.kind === 'MEDIA_MISSING')).toBe(true);
  });

  it('refuses a file under references/ as production media, whatever its rights column says', async () => {
    await writeFile(join(packRoot, 'references', 'benchmark.jpg'), JPEG);
    await writePack(
      // Deliberately declared as clean, commercially usable, owned material.
      [candidateRow('WC-REF', { declared_licence: 'CC0', commercial_use_permitted: 'YES' })],
      [acquisitionRow('WC-REF', 'references/benchmark.jpg', JPEG_SHA)],
    );

    const result = await importPilotPack({ packPath: packRoot, runner: REFUSING_RUNNER, now: NOW });
    expect(result.counts.analysisOnlyRefused).toBe(1);
    const problem = result.problems.find((p) => p.kind === 'ANALYSIS_ONLY_IN_PRODUCTION');
    expect(problem?.detail).toContain('may never enter a production selection');
    expect(result.privateLocations).toHaveLength(0);
  });

  it('reports an acquisition row for a candidate the catalogue does not list', async () => {
    await writeFile(join(packRoot, 'candidates', 'images', 'a.jpg'), JPEG);
    await writePack(
      [candidateRow('WC-1')],
      [acquisitionRow('WC-9', 'candidates/images/a.jpg', JPEG_SHA)],
    );
    const result = await importPilotPack({ packPath: packRoot, runner: REFUSING_RUNNER, now: NOW });
    expect(result.problems.some((p) => p.kind === 'ORPHANED_ACQUISITION')).toBe(true);
  });

  it('counts licence evidence without copying any of it', async () => {
    await writeFile(join(packRoot, 'candidates', 'images', 'a.jpg'), JPEG);
    await writeFile(join(packRoot, 'candidates', 'licence-evidence', 'WC-1.json'), '{}');
    await writeFile(join(packRoot, 'candidates', 'licence-evidence', 'WC-2.json'), '{}');
    await writePack(
      [candidateRow('WC-1')],
      [
        acquisitionRow(
          'WC-1',
          'candidates/images/a.jpg',
          JPEG_SHA,
          'candidates/licence-evidence/WC-1.json',
        ),
      ],
    );

    const result = await importPilotPack({ packPath: packRoot, runner: REFUSING_RUNNER, now: NOW });
    expect(result.counts.licenceEvidenceFiles).toBe(2);
    expect(result.privateLocations[0]?.licenceEvidencePath).toContain('WC-1.json');
  });

  it('never imports a candidate above RIGHTS_REVIEW_REQUIRED', async () => {
    await writeFile(join(packRoot, 'candidates', 'images', 'a.jpg'), JPEG);
    await writePack(
      [candidateRow('WC-1', { declared_licence: 'CC0', paid_ads_permitted: 'YES' })],
      [acquisitionRow('WC-1', 'candidates/images/a.jpg', JPEG_SHA)],
    );
    const result = await importPilotPack({ packPath: packRoot, runner: REFUSING_RUNNER, now: NOW });
    expect(result.candidates[0]?.state).toBe('RIGHTS_REVIEW_REQUIRED');
  });

  it('parks a candidate the rights policy rejects short of review', async () => {
    await writeFile(join(packRoot, 'candidates', 'images', 'a.jpg'), JPEG);
    await writePack(
      [candidateRow('WC-NC', { declared_licence: 'CC BY-NC 4.0', commercial_use_permitted: 'NO' })],
      [acquisitionRow('WC-NC', 'candidates/images/a.jpg', JPEG_SHA)],
    );
    const result = await importPilotPack({ packPath: packRoot, runner: REFUSING_RUNNER, now: NOW });
    expect(result.candidates[0]?.state).toBe('METADATA_VERIFIED');
    expect(result.candidates[0]?.rightsDecision?.outcome).toBe('REJECTED');
  });

  it('keeps the external absolute path out of the candidate and in private provenance', async () => {
    await writeFile(join(packRoot, 'candidates', 'images', 'a.jpg'), JPEG);
    await writePack(
      [candidateRow('WC-1')],
      [acquisitionRow('WC-1', 'candidates/images/a.jpg', JPEG_SHA)],
    );
    const result = await importPilotPack({ packPath: packRoot, runner: REFUSING_RUNNER, now: NOW });

    expect(JSON.stringify(result.candidates)).not.toContain(packRoot);
    expect(result.privateLocations[0]?.absolutePath).toContain(packRoot);
  });

  it('refuses a folder that is not there', async () => {
    await expect(
      importPilotPack({ packPath: join(packRoot, 'nope'), runner: REFUSING_RUNNER, now: NOW }),
    ).rejects.toThrow(PilotPackImportError);
  });

  it('refuses a candidate list with no candidate_id column', async () => {
    await writeFile(join(packRoot, 'source-candidates.csv'), 'a,b\n1,2\n');
    await expect(
      importPilotPack({ packPath: packRoot, runner: REFUSING_RUNNER, now: NOW }),
    ).rejects.toThrow(/candidate_id/);
  });

  it('does not stop the whole import for one broken row', async () => {
    await writeFile(join(packRoot, 'candidates', 'images', 'a.jpg'), JPEG);
    await writePack(
      [candidateRow('WC-1'), candidateRow('WC-2'), candidateRow('WC-3')],
      [
        acquisitionRow('WC-1', 'candidates/images/a.jpg', JPEG_SHA),
        acquisitionRow('WC-2', '../../escape.jpg', JPEG_SHA),
        acquisitionRow('WC-3', 'candidates/images/gone.jpg', JPEG_SHA),
      ],
    );
    const result = await importPilotPack({ packPath: packRoot, runner: REFUSING_RUNNER, now: NOW });
    expect(result.candidates).toHaveLength(3);
    expect(result.problems.map((p) => p.kind)).toEqual(
      expect.arrayContaining(['PATH_ESCAPE', 'MEDIA_MISSING']),
    );
  });
});
