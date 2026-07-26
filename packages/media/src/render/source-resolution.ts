import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import type { CommandRunner } from '../command-runner';
import { probeMedia } from '../ffprobe';
import type { MediaProbeResult } from '../types';
import {
  OUTPUT_ELIGIBLE_USAGE_CLASSES,
  type RenderManifest,
  type RenderSource,
  type SourceKind,
  type SourceLicense,
} from './manifest';
import { assertReadableNonEmptyFile, resolveContainedPath } from './paths';

/**
 * Input resolution is where licensing is enforced (docs/aamp-architecture.md
 * §9.1). A source becomes renderable only if it is `OWNED` or
 * `LICENSED_FOR_OUTPUT` and its licence has not expired. Every
 * `ANALYSIS_ONLY` reference — the class all Creative Memory material carries
 * — is rejected here, with a typed error, before FFmpeg is invoked at all.
 * This is deliberately the single gate: the renderer has no other way to
 * learn a file path.
 */
export class SourceNotLicensedForOutputError extends Error {
  constructor(
    public readonly sourceId: string,
    public readonly usageClass: string,
  ) {
    super(
      `Source "${sourceId}" has usageClass ${usageClass} and may not contribute to output; only ${OUTPUT_ELIGIBLE_USAGE_CLASSES.join(' or ')} may be rendered`,
    );
    this.name = 'SourceNotLicensedForOutputError';
  }
}

export class LicenseExpiredError extends Error {
  constructor(
    public readonly sourceId: string,
    public readonly expiresAt: string,
    public readonly asOf: string,
  ) {
    super(`Source "${sourceId}" licence expired at ${expiresAt} (evaluated as of ${asOf})`);
    this.name = 'LicenseExpiredError';
  }
}

export class SourceChecksumMismatchError extends Error {
  constructor(
    public readonly sourceId: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`Source "${sourceId}" checksum is ${actual}, expected ${expected}`);
    this.name = 'SourceChecksumMismatchError';
  }
}

export class SourceKindMismatchError extends Error {
  constructor(
    public readonly sourceId: string,
    public readonly declared: SourceKind,
    public readonly detected: string,
  ) {
    super(`Source "${sourceId}" is declared ${declared} but probes as ${detected}`);
    this.name = 'SourceKindMismatchError';
  }
}

export interface ResolvedSource {
  readonly id: string;
  readonly kind: SourceKind;
  readonly absolutePath: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly probe: MediaProbeResult;
  readonly license: SourceLicense;
  readonly description: string;
}

export interface ResolveSourcesOptions {
  /** Relative source paths resolve against this — the manifest's directory. */
  readonly baseDir: string;
  readonly allowedRoots: readonly string[];
  readonly ffprobePath?: string;
  readonly probeTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Licence expiry is evaluated against this instant; the caller supplies it so resolution stays a pure function of its inputs. */
  readonly asOf: Date;
}

export async function sha256File(absolutePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(absolutePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/**
 * Resolves every manifest source to real, probed, licence-cleared bytes.
 * Ordering matters: licensing is checked first, so an `ANALYSIS_ONLY`
 * reference is refused without the renderer ever touching the file.
 */
export async function resolveManifestSources(
  runner: CommandRunner,
  manifest: RenderManifest,
  options: ResolveSourcesOptions,
): Promise<ReadonlyMap<string, ResolvedSource>> {
  const resolved = new Map<string, ResolvedSource>();
  for (const source of manifest.sources) {
    resolved.set(source.id, await resolveOne(runner, source, options));
  }
  return resolved;
}

async function resolveOne(
  runner: CommandRunner,
  source: RenderSource,
  options: ResolveSourcesOptions,
): Promise<ResolvedSource> {
  assertLicensedForOutput(source, options.asOf);

  const absolutePath = resolveContainedPath({
    rawPath: source.path,
    baseDir: options.baseDir,
    allowedRoots: options.allowedRoots,
  });
  const facts = await assertReadableNonEmptyFile(absolutePath);

  const checksumSha256 = await sha256File(absolutePath);
  if (source.expectedChecksum && source.expectedChecksum !== checksumSha256) {
    throw new SourceChecksumMismatchError(source.id, source.expectedChecksum, checksumSha256);
  }

  const probe = await probeMedia(runner, absolutePath, {
    ffprobePath: options.ffprobePath,
    timeoutMs: options.probeTimeoutMs,
    signal: options.signal,
  });
  if (probe.mediaType !== source.kind) {
    throw new SourceKindMismatchError(source.id, source.kind, probe.mediaType);
  }

  return {
    id: source.id,
    kind: source.kind,
    absolutePath,
    sizeBytes: facts.sizeBytes,
    checksumSha256,
    probe,
    license: source.license,
    description: source.description,
  };
}

export function assertLicensedForOutput(source: RenderSource, asOf: Date): void {
  if (!OUTPUT_ELIGIBLE_USAGE_CLASSES.includes(source.license.usageClass)) {
    throw new SourceNotLicensedForOutputError(source.id, source.license.usageClass);
  }
  if (source.license.expiresAt) {
    const expiresAt = new Date(source.license.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new LicenseExpiredError(source.id, source.license.expiresAt, asOf.toISOString());
    }
    if (expiresAt.getTime() <= asOf.getTime()) {
      throw new LicenseExpiredError(source.id, expiresAt.toISOString(), asOf.toISOString());
    }
  }
}
