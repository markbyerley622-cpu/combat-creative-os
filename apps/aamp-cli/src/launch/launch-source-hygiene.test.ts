import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The milestone's central claim, asserted against the source itself: **the
 * agents own the creative, and application code owns the constraints**.
 *
 * A reviewer can check that by reading the modules, but a reader six months
 * from now will not, and the failure mode is quiet — one "temporary" default
 * concept added to unblock a demo, and the system is writing the advertisement
 * again. So it is a test.
 *
 * The scan looks for the shapes creative content actually takes: a concept
 * title, a hook, a caption, a beat list, a script line, a timing decision. It
 * deliberately covers the fixture provider too, which derives everything from
 * its input and therefore contains none of them.
 */

const LAUNCH_DIRECTORY = join(__dirname);

/** Vocabulary values are structure, not creative. Everything else is suspect. */
const STRUCTURAL_VOCABULARY = /^[A-Z][A-Z0-9_]*$/;

async function launchSourceFiles(): Promise<readonly string[]> {
  const entries = await readdir(LAUNCH_DIRECTORY, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .filter((entry) => !entry.name.endsWith('.test.ts'))
    .map((entry) => entry.name)
    .sort();
}

async function read(name: string): Promise<string> {
  return readFile(join(LAUNCH_DIRECTORY, name), 'utf8');
}

describe('no campaign-specific creative lives in application source', () => {
  it('covers every non-test file in the launch module', async () => {
    const files = await launchSourceFiles();
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain('launch-fixture-reasoning.ts');
    expect(files).toContain('run-launch-plan.ts');
  });

  it('contains no concept title, hook, caption, script line or beat plan', async () => {
    const CREATIVE_FIELDS = ['centralIdea', 'conceptTitle', 'caption', 'hookLine', 'voiceOver'];

    for (const file of await launchSourceFiles()) {
      const source = await read(file);
      for (const field of CREATIVE_FIELDS) {
        // A static string literal assigned to a creative field *is* the
        // creative, written here.
        const staticLiteral = new RegExp(`${field}\\s*[:=]\\s*['"]`, 'i');
        expect(staticLiteral.test(source), `${file} assigns a literal ${field}`).toBe(false);

        // A template literal is permitted only when it interpolates — that is
        // the difference between composing from the brief and writing the idea.
        for (const line of source.split('\n')) {
          const composed = new RegExp(`${field}\\s*[:=]\\s*\``, 'i');
          if (composed.test(line)) {
            expect(line.includes('${'), `${file} assigns a fixed ${field} template`).toBe(true);
          }
        }
      }
    }
  });

  it('never hardcodes a beat plan, a shot list or a timing decision', async () => {
    for (const file of await launchSourceFiles()) {
      const source = await read(file);
      expect(/durationFrames\s*:\s*\d+/.test(source), `${file} hardcodes a beat length`).toBe(
        false,
      );
      expect(/shots\s*:\s*\[\s*{/.test(source), `${file} hardcodes a shot list`).toBe(false);
    }
  });

  it('keeps the launch fixtures out of every command path', async () => {
    for (const file of await launchSourceFiles()) {
      if (file === 'launch-fixtures.ts') continue;
      const source = await read(file);
      expect(source.includes("from './launch-fixtures'"), `${file} imports the test fixtures`).toBe(
        false,
      );
    }
  });

  it('names the campaign nowhere: the brand reaches the agents as input', async () => {
    for (const file of await launchSourceFiles()) {
      if (file === 'launch-fixtures.ts') continue;
      const source = await read(file);
      expect(/Combat Reviews/i.test(source), `${file} names a specific campaign brand`).toBe(false);
    }
  });

  it('produces every axis value from a closed structural vocabulary', async () => {
    // The concept vocabularies are the one place enumerated creative-adjacent
    // values live, and they are structure: LINEAR_BUILD is a shape, not an idea.
    const { LAUNCH_NARRATIVE_STRUCTURES, LAUNCH_EMOTIONAL_ARCS, LAUNCH_END_FRAME_STRATEGIES } =
      await import('@combat/domain');
    for (const value of [
      ...LAUNCH_NARRATIVE_STRUCTURES,
      ...LAUNCH_EMOTIONAL_ARCS,
      ...LAUNCH_END_FRAME_STRATEGIES,
    ]) {
      expect(STRUCTURAL_VOCABULARY.test(value), value).toBe(true);
    }
  });
});

describe('the fixture reasoning provider is a demonstration, and says so', () => {
  it('derives its output from the input rather than carrying canned creative', async () => {
    const source = await read('launch-fixture-reasoning.ts');
    // Everything it emits is composed from the envelope it was given.
    expect(source).toContain('parseEnvelope');
    expect(source).toMatch(/demonstration/i);
    expect(source).toContain('LAUNCH_FIXTURE_MODEL');
    expect(source).toContain('deterministic-launch-fixture');
  });

  it('lives outside packages/providers, so no worker configuration can select it', async () => {
    const providersIndex = await readFile(
      join(__dirname, '..', '..', '..', '..', 'packages', 'providers', 'src', 'index.ts'),
      'utf8',
    );
    expect(providersIndex).not.toContain('launch-fixture');
  });
});
