import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The product-story path cannot spend money, and that is a property of the
 * source rather than a promise in a report.
 *
 * The whole correction was authorised as a zero-cost one. What makes that
 * true is not a ceiling — a ceiling is a number somebody can change — but the
 * absence of anything on this path that could construct a provider, read a
 * credential or open a socket. These assertions are what keeps it absent.
 */

const DIRECTORY = __dirname;

async function moduleSources(): Promise<readonly { name: string; text: string }[]> {
  const names = (await readdir(DIRECTORY)).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
  );
  return Promise.all(
    names.map(async (name) => ({ name, text: await readFile(join(DIRECTORY, name), 'utf8') })),
  );
}

describe('product-story source hygiene', () => {
  it('constructs no provider and reads no credential', async () => {
    for (const { name, text } of await moduleSources()) {
      expect(text, `${name} must not construct a generation provider`).not.toMatch(
        /createLtxHostedProvider|createVideoGenerationProvider|createAampDependencies/,
      );
      expect(text, `${name} must not read a credential`).not.toMatch(/LTXV_API_KEY|apiKey/);
      expect(text, `${name} must not read process.env`).not.toMatch(/process\.env/);
    }
  });

  it('makes no network request of any kind', async () => {
    for (const { name, text } of await moduleSources()) {
      expect(text, `${name} must not fetch`).not.toMatch(/\bfetch\s*\(/);
      expect(text, `${name} must not open a socket`).not.toMatch(
        /require\(['"]node:(http|https|net|tls)['"]\)|from '(node:)?(http|https|net|tls)'/,
      );
    }
  });

  it('opens no database client', async () => {
    for (const { name, text } of await moduleSources()) {
      expect(text, `${name} must not open a database`).not.toMatch(/PrismaClient|QdrantClient/);
    }
  });

  it('hardcodes no operator path', async () => {
    for (const { name, text } of await moduleSources()) {
      expect(text, `${name} must not hardcode an operator path`).not.toMatch(
        /[A-Za-z]:\\\\Users|\/Users\/[a-z]/i,
      );
    }
  });

  it('assigns no creative literal — every word on screen is authored', async () => {
    // The treatments are laid out here; what they *say* arrives from the plan.
    // A headline assigned in a module is the system writing the advertisement.
    //
    // Comments are stripped first, deliberately. A comment explaining that the
    // rank rises out and its replacement settles in has to be able to name the
    // example, and refusing that would push the explanation out of the file
    // that needs it. What must not appear is a literal the code could *emit*.
    const treatments = (await readFile(join(DIRECTORY, 'screen-treatments.ts'), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const forbidden of [
      'PREDICTION SUBMITTED',
      'PREDICTION CORRECT',
      'JOIN THE DEBATE',
      'READ THE FIGHT',
      'NEVER MISS FIGHT NIGHT',
      'EXPLORE EVENTS',
      '#27',
      '#18',
    ]) {
      expect(treatments, `screen-treatments.ts must not contain "${forbidden}"`).not.toContain(
        forbidden,
      );
    }
  });

  it('scores no creative quality anywhere', async () => {
    for (const { name, text } of await moduleSources()) {
      expect(text, `${name} must not score creative quality`).not.toMatch(
        /creativeScore|qualityScore|craftScore|aestheticScore/,
      );
    }
  });
});
