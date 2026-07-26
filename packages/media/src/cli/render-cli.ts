#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { resolveFfmpegBinaries } from '../binaries';
import { NodeCommandRunner, type CommandRunner } from '../command-runner';
import { ManifestValidationError, parseRenderManifest } from '../render/manifest';
import { renderAdvertisement } from '../render/renderer';

/**
 * `pnpm aamp:render --manifest <path>` — the required usable surface for
 * this milestone. Validate, resolve, render, measure, report. It prints the
 * six facts the milestone asks for and nothing else; every one of them comes
 * from the produced file, so a `PASS` line here is a measurement, not a
 * restatement of what was requested.
 *
 * The whole run is `runRenderCli`, taking its environment as arguments, so a
 * test can execute the real entry point rather than a re-implementation of
 * it. Only the `require.main` block below touches process globals.
 */

const DEFAULT_OUTPUT_DIRECTORY = '.aamp-output';

export interface CliOptions {
  readonly manifestPath: string;
  readonly outputRoot?: string;
  readonly extraSourceRoots: readonly string[];
  readonly json: boolean;
}

export function parseCliArguments(argv: readonly string[]): CliOptions {
  let manifestPath: string | undefined;
  let outputRoot: string | undefined;
  const extraSourceRoots: string[] = [];
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--manifest':
        manifestPath = argv[++i];
        break;
      case '--output-root':
        outputRoot = argv[++i];
        break;
      case '--allow-source-root': {
        const value = argv[++i];
        if (value) extraSourceRoots.push(value);
        break;
      }
      case '--json':
        json = true;
        break;
      default:
        if (arg && arg.startsWith('--')) {
          throw new Error(`Unknown option ${arg}`);
        }
    }
  }

  if (!manifestPath) {
    throw new Error('Usage: aamp:render --manifest <absolute-or-repository-relative-json-path>');
  }

  return {
    manifestPath,
    ...(outputRoot ? { outputRoot } : {}),
    extraSourceRoots,
    json,
  };
}

/** Walks up to the workspace root, so a repository-relative manifest path works from any directory. */
export async function findRepositoryRoot(startDir: string): Promise<string> {
  let current = resolve(startDir);
  for (;;) {
    try {
      await stat(resolve(current, 'pnpm-workspace.yaml'));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(startDir);
      current = parent;
    }
  }
}

export interface RenderCliContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly runner?: CommandRunner;
  readonly now?: () => Date;
}

export async function runRenderCli(
  argv: readonly string[],
  context: RenderCliContext,
): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArguments(argv);
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const repositoryRoot = await findRepositoryRoot(context.cwd);
  const manifestPath = isAbsolute(options.manifestPath)
    ? options.manifestPath
    : resolve(repositoryRoot, options.manifestPath);
  const manifestDir = dirname(manifestPath);

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    context.stderr(
      `Could not read manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  let manifest;
  try {
    manifest = parseRenderManifest(raw, manifestPath);
  } catch (error) {
    context.stderr(`${error instanceof ManifestValidationError ? error.message : String(error)}\n`);
    return 2;
  }

  const outputRoot = options.outputRoot
    ? resolve(repositoryRoot, options.outputRoot)
    : resolve(repositoryRoot, DEFAULT_OUTPUT_DIRECTORY);

  let result;
  try {
    result = await renderAdvertisement(context.runner ?? new NodeCommandRunner(), {
      manifest,
      manifestDir,
      allowedSourceRoots: [
        repositoryRoot,
        manifestDir,
        ...options.extraSourceRoots.map((root) => resolve(repositoryRoot, root)),
      ],
      outputRoot,
      binaries: resolveFfmpegBinaries(context.env),
      now: context.now ? context.now() : new Date(),
    });
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const { summary } = result.qaReport;

  if (options.json) {
    context.stdout(`${JSON.stringify(result.qaReport, null, 2)}\n`);
  } else {
    context.stdout(
      `${[
        `output path:  ${result.outputPath}`,
        `duration:     ${summary.durationSeconds === null ? 'unknown' : `${summary.durationSeconds.toFixed(3)}s`}`,
        `resolution:   ${summary.widthPx ?? '?'}x${summary.heightPx ?? '?'}`,
        `codecs:       ${summary.videoCodec ?? 'none'} / ${summary.audioCodec ?? 'none'}`,
        `QA status:    ${result.qaReport.verdict}`,
        `QA report:    ${result.qaReportPath}`,
      ].join('\n')}\n`,
    );
  }

  if (result.qaReport.verdict !== 'PASS') {
    const failures = result.qaReport.measurements.filter((m) => m.verdict === 'FAIL');
    context.stderr(
      `\nfailed checks:\n${failures
        .map((m) => `  - ${m.check}: measured ${String(m.measured)}, expected ${m.expected}`)
        .join('\n')}\n`,
    );
    return 1;
  }
  return 0;
}

if (require.main === module) {
  runRenderCli(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}
