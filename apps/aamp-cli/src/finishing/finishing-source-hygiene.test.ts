import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The milestone's central claim, asserted against the source itself: **the
 * reviewer owns the creative decisions, and application code owns the
 * discipline**.
 *
 * A finishing pass is exactly where that erodes. The tempting shortcut is a
 * "sensible default" alternative — trim 0.4s off the opening, try the sweep on
 * the app screen — added to make a demo produce something without a person
 * writing directives. One of those and the system is deciding what the
 * advertisement should be, while the artefacts still say a human did.
 *
 * So the scan looks for the shapes a creative decision takes here: copy
 * assigned to a creative field, a hardcoded beat plan, a timing literal
 * assigned to a duration, and a default candidate list.
 */

const FINISHING_DIRECTORY = join(__dirname);

async function finishingSourceFiles(): Promise<readonly string[]> {
  const entries = await readdir(FINISHING_DIRECTORY, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .filter((entry) => !entry.name.endsWith('.test.ts'))
    .map((entry) => entry.name)
    .sort();
}

async function read(name: string): Promise<string> {
  return readFile(join(FINISHING_DIRECTORY, name), 'utf8');
}

describe('no creative decision lives in finishing application source', () => {
  it('covers every non-test file in the finishing module', async () => {
    const files = await finishingSourceFiles();
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain('finishing-plan-edits.ts');
    expect(files).toContain('finishing-propose.ts');
    expect(files).toContain('finishing-directives.ts');
  });

  it('assigns no caption, headline, hook line or on-screen copy', async () => {
    const CREATIVE_FIELDS = ['onScreenLine', 'headline', 'subline', 'logline', 'visualDirection'];
    for (const file of await finishingSourceFiles()) {
      const source = await read(file);
      for (const field of CREATIVE_FIELDS) {
        const staticLiteral = new RegExp(`\\b${field}\\s*[:=]\\s*['"]`, 'i');
        expect(staticLiteral.test(source), `${file} assigns a literal ${field}`).toBe(false);
        for (const line of source.split('\n')) {
          if (new RegExp(`\\b${field}\\s*[:=]\\s*\``, 'i').test(line)) {
            expect(line.includes('${'), `${file} assigns a fixed ${field} template`).toBe(true);
          }
        }
      }
    }
  });

  /**
   * The one that matters most. Every duration, latency, gain and hold in a
   * candidate comes from a directive the reviewer wrote; a numeric literal
   * assigned to one of those fields in this directory would be this code
   * making a timing decision.
   */
  it('makes no timing, gain or intensity decision of its own', async () => {
    const TIMED_FIELDS = [
      'durationSeconds',
      'latencySeconds',
      'holdSeconds',
      'inSeconds',
      'musicGainDb',
      'sourceAudioGainDb',
      'targetLufs',
      'intensity',
      'opacity',
    ];
    for (const file of await finishingSourceFiles()) {
      const source = await read(file);
      for (const field of TIMED_FIELDS) {
        // `field: 12`, `field = 0.4` — a decision. `field: operation.x`,
        // `field: z.number()` and `field: entry.durationSeconds` are plumbing.
        const decision = new RegExp(`\\b${field}\\s*[:=]\\s*-?\\d`, 'i');
        expect(decision.test(source), `${file} decides ${field} itself`).toBe(false);
      }
    }
  });

  it('never hardcodes a beat plan, a candidate list or a default alternative', async () => {
    for (const file of await finishingSourceFiles()) {
      const source = await read(file);
      expect(/\bbeats\s*:\s*\[\s*{/.test(source), `${file} hardcodes a beat plan`).toBe(false);
      expect(
        /\boperations\s*:\s*\[\s*{/.test(source),
        `${file} authors a directive's operations`,
      ).toBe(false);
    }
  });

  /**
   * The template is a skeleton, never a runnable directive set — the same rule
   * the human plan template lives by. A template that produced candidates
   * would make the mode's claim untrue on first use, and it is the one place
   * a "sensible default" alternative would be easiest to slip in.
   */
  it('emits a directive template that cannot run until a person edits it', async () => {
    const { buildDirectiveTemplate, parseStageDirectiveSet } =
      await import('./finishing-directives');
    const template = buildDirectiveTemplate('HOOK', 'a'.repeat(64), '2026-01-01T00:00:00.000Z');
    const candidates = template.candidates as readonly { operations: readonly unknown[] }[];
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) expect(candidate.operations).toHaveLength(0);
    expect(() => parseStageDirectiveSet(template)).toThrow();
  });

  it('names no specific campaign or brand', async () => {
    for (const file of await finishingSourceFiles()) {
      const source = await read(file);
      expect(/Combat Reviews/i.test(source), `${file} names a specific campaign brand`).toBe(false);
    }
  });

  /**
   * The structural half of "a finishing round cannot spend money": there is no
   * import that could reach a reasoning provider, a generation provider, the
   * composition root or a database client from anywhere in this module.
   */
  it('constructs no provider, no composition root and no database client', async () => {
    const FORBIDDEN = [
      'dependency-factory',
      '@combat/providers',
      '@combat/database',
      'PrismaClient',
      'QdrantClient',
      'fixture-reasoning',
      'fixture-generation',
    ];
    for (const file of await finishingSourceFiles()) {
      const source = await read(file);
      for (const forbidden of FORBIDDEN) {
        expect(source.includes(forbidden), `${file} reaches ${forbidden}`).toBe(false);
      }
    }
  });

  it('produces no craft score anywhere', async () => {
    for (const file of await finishingSourceFiles()) {
      const source = await read(file);
      // A score assigned from anything but a submitted scorecard would be the
      // system grading its own advertisement.
      expect(/\bscore\s*[:=]\s*-?\d/.test(source), `${file} produces a craft score`).toBe(
        file === 'finishing-scorecard.ts',
      );
    }
    // The single permitted case is the empty template, which emits zeros a
    // reviewer must replace — and the schema refuses a zero.
    const scorecard = await read('finishing-scorecard.ts');
    expect(scorecard).toContain('buildScorecardTemplate');
    expect(scorecard).toContain('score: z.number().int().min(1).max(10)');
  });
});
