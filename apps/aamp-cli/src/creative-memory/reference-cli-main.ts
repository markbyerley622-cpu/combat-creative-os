#!/usr/bin/env node
import { createPrismaClient } from '@combat/database';

import { runReferenceCli, type ReferenceCliContext } from './reference-cli';

/**
 * Process entry point for `pnpm aamp:reference`.
 *
 * Kept separate from `reference-cli.ts` so the command logic stays testable
 * against an injected in-memory store — this file is the only place a real
 * PrismaClient is constructed, and it is never imported by a test.
 */
async function main(): Promise<void> {
  const prisma = createPrismaClient();
  const context: ReferenceCliContext = {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    // The generated client's reference delegates match the repository's
    // structural `ReferenceDataSource`; the cast is the same boundary
    // `createPrismaActivityDatabase` crosses on the production side.
    db: prisma as unknown as ReferenceCliContext['db'],
  };

  try {
    process.exitCode = await runReferenceCli(process.argv.slice(2), context);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 10;
  });
}
