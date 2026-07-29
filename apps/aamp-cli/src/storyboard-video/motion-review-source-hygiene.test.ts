import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * "The review command cannot spend money" is a property of the source, and
 * this is where it is enforced.
 *
 * A runtime test can only show that a particular invocation made no request.
 * These read the files themselves and show there is nothing in them that
 * *could* — no provider factory, no credential name, no fetch. A guarantee
 * about an object graph is worth more than a guarantee about one code path,
 * because the path a future change takes is not knowable today.
 */

const REVIEW_MODULES = [
  'motion-inspection.ts',
  'motion-review-cli.ts',
  'motion-review-contracts.ts',
  'motion-review-gallery.ts',
  'motion-review-gate.ts',
  'motion-review-main.ts',
  'motion-review-run.ts',
  'motion-review-store.ts',
  'source-resolution-stage.ts',
];

/**
 * Ways a credential could be *read*, as opposed to named.
 *
 * Matched as access expressions rather than as bare words on purpose: the
 * command's own help text says "this command never reads LTXV_API_KEY", and a
 * check that banned the string would delete the sentence that tells an
 * operator the guarantee exists.
 */
const FORBIDDEN_CREDENTIAL_READS: readonly { label: string; pattern: RegExp }[] = [
  { label: 'an LTXV_API_KEY read', pattern: /env\s*(?:\.\s*LTXV_API_KEY|\[\s*['"]LTXV_API_KEY)/ },
  // The entry point reads exactly two FFmpeg locations out of `process.env`
  // and hands nothing else on. Any *other* module reaching for the process
  // environment would be reaching past that boundary.
  {
    label: 'a process.env read',
    pattern: /process\s*\.\s*env\s*(?!\[FFMPEG_PATH_ENV_VAR|\[FFPROBE_PATH_ENV_VAR)/,
  },
  { label: 'an apiKey field', pattern: /\bapiKey\s*[:=]/ },
  { label: 'an authorization header', pattern: /['"]?[Aa]uthorization['"]?\s*:/ },
];

/** Ways a module could construct something that talks to a paid provider. */
const FORBIDDEN_PROVIDER_TOKENS = [
  'createLtxHostedProvider',
  'LtxHostedVideoGenerationProvider',
  'createVideoGenerationProvider',
  'createAampDependencies',
  'PrismaClient',
  'QdrantClient',
];

async function readModule(name: string): Promise<string> {
  return readFile(join(__dirname, name), 'utf8');
}

describe('the review path constructs nothing that can spend money', () => {
  it('names every module that must satisfy this, and every one of them exists', async () => {
    const present = await readdir(__dirname);
    for (const name of REVIEW_MODULES) expect(present).toContain(name);
  });

  it('never reads an API key, in any of them', async () => {
    for (const name of REVIEW_MODULES) {
      // eslint-disable-next-line no-await-in-loop -- one file at a time keeps the failure legible
      const source = await readModule(name);
      for (const { label, pattern } of FORBIDDEN_CREDENTIAL_READS) {
        expect(`${name}: ${pattern.test(source) ? label : 'clean'}`).toBe(`${name}: clean`);
      }
    }
  });

  it('still tells the operator the guarantee exists', async () => {
    // The prose is the other half: a property nobody is told about is one
    // nobody relies on, and one a later change removes without noticing.
    const cli = await readModule('motion-review-cli.ts');
    expect(cli).toContain('never reads LTXV_API_KEY');
  });

  it('never constructs a provider, a database client or a vector client', async () => {
    for (const name of REVIEW_MODULES) {
      // eslint-disable-next-line no-await-in-loop -- one file at a time
      const source = await readModule(name);
      for (const token of FORBIDDEN_PROVIDER_TOKENS) {
        expect(`${name}: ${source.includes(token) ? token : 'clean'}`).toBe(`${name}: clean`);
      }
    }
  });

  it('never makes a network request of its own', async () => {
    for (const name of REVIEW_MODULES) {
      // eslint-disable-next-line no-await-in-loop -- one file at a time
      const source = await readModule(name);
      for (const token of ['fetch(', 'XMLHttpRequest', 'node:http', 'node:https', 'undici']) {
        expect(`${name}: ${source.includes(token) ? token : 'clean'}`).toBe(`${name}: clean`);
      }
    }
  });

  it('is wired to a command that does not load the environment file', async () => {
    // `aamp:storyboard-video` loads `.env` because a live run legitimately
    // needs the key. `aamp:motion-review` deliberately does not: a key the
    // process never loads is one no future change to this path can reach.
    const packageJson = JSON.parse(
      await readFile(join(__dirname, '..', '..', '..', '..', 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts['aamp:motion-review']).toBeDefined();
    expect(packageJson.scripts['aamp:motion-review']).not.toContain('--env-file');
    expect(packageJson.scripts['aamp:storyboard-video']).toContain('--env-file');
  });
});
