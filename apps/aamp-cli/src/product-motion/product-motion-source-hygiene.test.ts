import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * "This path spends no money" is a claim about the object graph, not a promise
 * in a comment. These tests read the source and assert it.
 *
 * The rule the repository has learned the expensive way is that a path which
 * *could* construct a provider eventually will — someone adds a fallback, a
 * default, a "just in case", and a proof that was free becomes a run that
 * bills. So the constructors are not reachable from here at all, and a future
 * edit that makes one reachable fails before it merges rather than after it
 * invoices.
 */

const SOURCE_DIRECTORY = __dirname;

/** Reading the environment belongs to the entry point, and only to it. */
const ENV_EXEMPT = new Set(['product-motion-main.ts']);

/**
 * Playwright drives a local browser to lay out the product documents. It is a
 * rendering engine here, not a network client: the context is created
 * `offline`, every request is aborted by a default-deny route, and the only
 * content it loads is a string this repository generated.
 */
const BROWSER_EXEMPT = new Set(['document-renderer.ts']);

async function sourceFiles(): Promise<readonly { name: string; text: string }[]> {
  const names = (await readdir(SOURCE_DIRECTORY)).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
  );
  return Promise.all(
    names.map(async (name) => ({
      name,
      text: await readFile(join(SOURCE_DIRECTORY, name), 'utf8'),
    })),
  );
}

describe('product-motion source hygiene', () => {
  it('has source files to check', async () => {
    const files = await sourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it('constructs no reasoning, generation or media provider', async () => {
    for (const file of await sourceFiles()) {
      expect(file.text, file.name).not.toMatch(/createAampDependencies/);
      expect(file.text, file.name).not.toMatch(/createReasoningProvider/);
      expect(file.text, file.name).not.toMatch(/createVideoGenerationProvider/);
      expect(file.text, file.name).not.toMatch(/ClaudeReasoningProvider/);
      expect(file.text, file.name).not.toMatch(/LtxClient|ltxClient/);
      expect(file.text, file.name).not.toMatch(/@combat\/providers/);
    }
  });

  it('opens no database connection', async () => {
    for (const file of await sourceFiles()) {
      expect(file.text, file.name).not.toMatch(/PrismaClient/);
      expect(file.text, file.name).not.toMatch(/QdrantClient/);
      expect(file.text, file.name).not.toMatch(/@combat\/database/);
    }
  });

  it('makes no network request of any kind', async () => {
    for (const file of await sourceFiles()) {
      expect(file.text, file.name).not.toMatch(/\bfetch\s*\(/);
      expect(file.text, file.name).not.toMatch(/node:https?/);
      expect(file.text, file.name).not.toMatch(/\baxios\b/);
      expect(file.text, file.name).not.toMatch(/WebSocket/);
      if (!BROWSER_EXEMPT.has(file.name)) {
        expect(file.text, file.name).not.toMatch(/playwright/);
      }
    }
  });

  it('reads no credential, and reads the environment only at the entry point', async () => {
    for (const file of await sourceFiles()) {
      expect(file.text, file.name).not.toMatch(/API_KEY/);
      expect(file.text, file.name).not.toMatch(/ANTHROPIC|LTXV|SECRET|TOKEN/);
      if (!ENV_EXEMPT.has(file.name)) {
        expect(file.text, file.name).not.toMatch(/process\.env/);
      }
    }
  });

  it('never writes to an external pack — staging copies out, and only out', async () => {
    for (const file of await sourceFiles()) {
      // `copyFile` is permitted; it is how material is brought *into* the run
      // directory. Anything that could mutate a source location is not.
      expect(file.text, file.name).not.toMatch(/\brename\s*\(|\brm\s*\(|\bunlink\s*\(|rmdir/);
    }
  });

  it('hardcodes no operator pack path', async () => {
    for (const file of await sourceFiles()) {
      expect(file.text, file.name).not.toMatch(/C:\\\\Users|\/Users\/|OneDrive|Desktop/);
    }
  });
});
