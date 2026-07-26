import { isAbsolute, resolve } from 'node:path';

import {
  CREATIVE_MEMORY_MODES,
  CreativeMemoryModeSchema,
  type CreativeMemoryMode,
} from '@combat/domain';

import { findRepositoryRoot } from '../generate-cli';
import { parseExecutionModeFlag, type AampExecutionMode } from './aamp-execution-mode';
import { runDoctor, type DoctorCheck, type DoctorOptions, type DoctorReport } from './doctor';

/**
 * `pnpm aamp:doctor` — the operator surface for the read-only preflight.
 *
 * Split from `doctor.ts` so the checks are testable without argument parsing,
 * and from `doctor-main.ts` so no test ever constructs a real PrismaClient.
 *
 * Exit codes carry the verdict, so a script can gate on it without parsing
 * prose: `0` READY, `1` DEGRADED, `2` BLOCKED, `3` bad arguments. DEGRADED is
 * deliberately non-zero — it means a run will work but will be substituting
 * something, and a pipeline that treats that as success is how a demonstration
 * gets published.
 */

export const DOCTOR_EXIT_CODES = {
  READY: 0,
  DEGRADED: 1,
  BLOCKED: 2,
  INVALID_ARGUMENTS: 3,
} as const;

export interface DoctorCliOptions {
  readonly executionMode?: AampExecutionMode;
  readonly creativeMemory: CreativeMemoryMode;
  readonly workspaceId?: string;
  readonly benchmarkProfileName?: string;
  readonly assetsPath?: string;
  readonly outputDirectory?: string;
  readonly json: boolean;
}

export function parseDoctorArguments(argv: readonly string[]): DoctorCliOptions {
  let executionMode: AampExecutionMode | undefined;
  let creativeMemory: CreativeMemoryMode = 'off';
  let workspaceId: string | undefined;
  let benchmarkProfileName: string | undefined;
  let assetsPath: string | undefined;
  let outputDirectory: string | undefined;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--execution-mode': {
        const value = argv[++index];
        const parsed = parseExecutionModeFlag(value);
        if (!parsed) {
          throw new Error(
            `--execution-mode must be one of fixture|local-production|production (got "${value ?? ''}")`,
          );
        }
        executionMode = parsed;
        break;
      }
      case '--creative-memory': {
        const value = argv[++index];
        const parsed = CreativeMemoryModeSchema.safeParse(value);
        if (!parsed.success) {
          throw new Error(
            `--creative-memory must be one of ${CREATIVE_MEMORY_MODES.join('|')} (got "${value ?? ''}")`,
          );
        }
        creativeMemory = parsed.data;
        break;
      }
      case '--workspace':
        workspaceId = argv[++index];
        break;
      case '--benchmark-profile':
        benchmarkProfileName = argv[++index];
        break;
      case '--assets':
        assetsPath = argv[++index];
        break;
      case '--output-dir':
        outputDirectory = argv[++index];
        break;
      case '--json':
        json = true;
        break;
      case '--help':
      case '-h':
        throw new Error(usage());
      default:
        if (argument?.startsWith('--')) throw new Error(`Unknown option ${argument}\n\n${usage()}`);
    }
  }

  return {
    ...(executionMode ? { executionMode } : {}),
    creativeMemory,
    ...(workspaceId ? { workspaceId } : {}),
    ...(benchmarkProfileName ? { benchmarkProfileName } : {}),
    ...(assetsPath ? { assetsPath } : {}),
    ...(outputDirectory ? { outputDirectory } : {}),
    json,
  };
}

export function usage(): string {
  return [
    'Usage: pnpm aamp:doctor [options]',
    '',
    '  --execution-mode fixture|local-production|production',
    '                        the tier to check readiness for (default: report what is attainable)',
    '  --creative-memory required|optional|off',
    '                        whether governed benchmark intelligence must be available (default: off)',
    '  --workspace <uuid>    workspace whose benchmark profiles and references are checked',
    '  --benchmark-profile <name>',
    '                        require an approved, active profile with this name',
    '  --assets <path>       production asset manifest whose rights are checked',
    '  --output-dir <dir>    output root whose writability is checked',
    '  --json                machine-readable report',
    '',
    'Read-only: no generation call, no spend, no database write, no render.',
    'Exit codes: 0 READY, 1 DEGRADED, 2 BLOCKED, 3 invalid arguments.',
  ].join('\n');
}

export interface DoctorCliContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now?: () => Date;
  /** Injected by tests; the process entry point supplies the real opener. */
  readonly openDatabase?: DoctorOptions['openDatabase'];
  readonly qdrant?: DoctorOptions['qdrant'];
  readonly embedder?: DoctorOptions['embedder'];
  readonly runner?: DoctorOptions['runner'];
}

const STATUS_MARK: Readonly<Record<DoctorCheck['status'], string>> = {
  READY: 'ok  ',
  DEGRADED: 'warn',
  BLOCKED: 'STOP',
  NOT_APPLICABLE: 'n/a ',
};

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `AAMP doctor — ${report.status}`,
    `  requested execution mode: ${report.requestedExecutionMode ?? '(none)'}`,
    `  attainable execution mode: ${report.attainableExecutionMode}`,
    `  creative memory: ${report.creativeMemoryMode}`,
    `  workspace: ${report.workspaceId ?? '(none)'}`,
    '',
  ];
  for (const check of report.checks) {
    lines.push(
      `  [${STATUS_MARK[check.status]}] ${check.title}${check.required ? '' : ' (advisory)'}`,
    );
    lines.push(`         ${check.detail}`);
    if (check.remedy) lines.push(`         fix: ${check.remedy}`);
  }
  if (report.blockers.length > 0) {
    lines.push('', 'BLOCKERS:');
    for (const blocker of report.blockers) lines.push(`  - ${blocker}`);
  }
  lines.push('', report.notice);
  return `${lines.join('\n')}\n`;
}

export async function runDoctorCli(
  argv: readonly string[],
  context: DoctorCliContext,
): Promise<number> {
  let options: DoctorCliOptions;
  try {
    options = parseDoctorArguments(argv);
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return DOCTOR_EXIT_CODES.INVALID_ARGUMENTS;
  }

  const repositoryRoot = await findRepositoryRoot(context.cwd);
  const absolute = (candidate: string): string =>
    isAbsolute(candidate) ? candidate : resolve(repositoryRoot, candidate);

  const report = await runDoctor({
    env: context.env,
    repositoryRoot,
    creativeMemoryMode: options.creativeMemory,
    now: context.now ? context.now() : new Date(),
    ...(options.executionMode ? { requestedExecutionMode: options.executionMode } : {}),
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    ...(options.benchmarkProfileName ? { benchmarkProfileName: options.benchmarkProfileName } : {}),
    ...(options.assetsPath ? { assetsPath: absolute(options.assetsPath) } : {}),
    ...(options.outputDirectory ? { outputDirectory: options.outputDirectory } : {}),
    ...(context.openDatabase ? { openDatabase: context.openDatabase } : {}),
    ...(context.qdrant ? { qdrant: context.qdrant } : {}),
    ...(context.embedder ? { embedder: context.embedder } : {}),
    ...(context.runner ? { runner: context.runner } : {}),
  });

  context.stdout(
    options.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report),
  );

  return report.status === 'BLOCKED'
    ? DOCTOR_EXIT_CODES.BLOCKED
    : report.status === 'DEGRADED'
      ? DOCTOR_EXIT_CODES.DEGRADED
      : DOCTOR_EXIT_CODES.READY;
}
