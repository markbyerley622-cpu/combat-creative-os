import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Path handling for the renderer. A manifest names files; those names decide
 * which bytes FFmpeg reads and which file the encoder writes. Two distinct
 * rules apply, and conflating them is how a renderer ends up reading
 * `C:\Users\...\.ssh\id_rsa` or overwriting an unrelated file:
 *
 * - **Sources are contained.** A resolved source path must sit inside one of
 *   the caller's declared roots. The manifest may be operator-authored today
 *   and API-supplied tomorrow; containment is what makes the second case safe
 *   without a second code path.
 * - **Outputs are contained *and* never clobber.** The renderer writes only
 *   inside its own output root, and refuses a target that already exists
 *   unless the caller explicitly asked to replace it.
 */
export class UnsafePathError extends Error {
  constructor(
    public readonly rawPath: string,
    detail: string,
  ) {
    super(`Unsafe path ${JSON.stringify(rawPath)}: ${detail}`);
    this.name = 'UnsafePathError';
  }
}

export class PathNotContainedError extends Error {
  constructor(
    public readonly resolvedPath: string,
    public readonly allowedRoots: readonly string[],
  ) {
    super(`Path ${resolvedPath} is outside every allowed root: ${allowedRoots.join(', ')}`);
    this.name = 'PathNotContainedError';
  }
}

export class OutputAlreadyExistsError extends Error {
  constructor(public readonly outputPath: string) {
    super(`Refusing to overwrite an existing file at ${outputPath}`);
    this.name = 'OutputAlreadyExistsError';
  }
}

export class SourceFileError extends Error {
  constructor(
    public readonly filePath: string,
    detail: string,
  ) {
    super(`Source file ${filePath}: ${detail}`);
    this.name = 'SourceFileError';
  }
}

/** Rejects the shapes that are never a legitimate local media path. */
function assertLexicallySafe(rawPath: string): void {
  if (rawPath.trim().length === 0) {
    throw new UnsafePathError(rawPath, 'is empty');
  }
  if (rawPath.includes('\0')) {
    throw new UnsafePathError(rawPath, 'contains a NUL byte');
  }
  // A URL would be silently accepted by FFmpeg's protocol layer, turning a
  // local-file contract into an outbound network fetch.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawPath)) {
    throw new UnsafePathError(rawPath, 'is a URL, not a local file path');
  }
  // FFmpeg reads a leading `-` as an option, and `pipe:`/`concat:` as
  // protocols; neither is a file.
  if (rawPath.startsWith('-')) {
    throw new UnsafePathError(rawPath, 'starts with "-", which FFmpeg reads as an option');
  }
  if (/^(pipe|concat|subfile|async|cache|data|tcp|udp|http|https|ftp|rtmp|rtsp):/i.test(rawPath)) {
    throw new UnsafePathError(rawPath, 'names an FFmpeg protocol rather than a file');
  }
}

/** True when `candidate` is `root` itself or sits beneath it. */
export function isContainedWithin(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return !rel.startsWith(`..${sep}`) && rel !== '..';
}

export interface ResolveContainedPathInput {
  readonly rawPath: string;
  /** Relative paths resolve against this — normally the manifest's own directory. */
  readonly baseDir: string;
  /** The resolved path must sit inside at least one of these. */
  readonly allowedRoots: readonly string[];
}

export function resolveContainedPath(input: ResolveContainedPathInput): string {
  assertLexicallySafe(input.rawPath);
  const resolved = resolve(input.baseDir, input.rawPath);
  const contained = input.allowedRoots.some((root) => isContainedWithin(resolved, root));
  if (!contained) {
    throw new PathNotContainedError(resolved, input.allowedRoots);
  }
  return resolved;
}

export interface ReadableFileFacts {
  readonly absolutePath: string;
  readonly sizeBytes: number;
}

/**
 * Proves the file is present, is a regular file, is readable and is not
 * zero-byte — the four failure modes that otherwise surface as an opaque
 * FFmpeg exit code several seconds into a render.
 */
export async function assertReadableNonEmptyFile(absolutePath: string): Promise<ReadableFileFacts> {
  let stats;
  try {
    stats = await stat(absolutePath);
  } catch {
    throw new SourceFileError(absolutePath, 'does not exist');
  }
  if (stats.isDirectory()) {
    throw new SourceFileError(absolutePath, 'is a directory, not a file');
  }
  if (!stats.isFile()) {
    throw new SourceFileError(absolutePath, 'is not a regular file');
  }
  if (stats.size === 0) {
    throw new SourceFileError(absolutePath, 'is zero bytes');
  }
  try {
    await access(absolutePath, fsConstants.R_OK);
  } catch {
    throw new SourceFileError(absolutePath, 'is not readable');
  }
  return { absolutePath, sizeBytes: stats.size };
}

export interface PrepareOutputPathInput {
  readonly outputPath: string;
  readonly outputRoot: string;
  /** Default false: an existing file is an error, never a silent overwrite. */
  readonly allowReplace?: boolean;
}

export async function assertWritableOutputPath(input: PrepareOutputPathInput): Promise<string> {
  assertLexicallySafe(input.outputPath);
  const resolved = resolve(input.outputPath);
  if (!isContainedWithin(resolved, input.outputRoot)) {
    throw new PathNotContainedError(resolved, [input.outputRoot]);
  }
  if (!input.allowReplace) {
    try {
      await stat(resolved);
      throw new OutputAlreadyExistsError(resolved);
    } catch (error) {
      if (error instanceof OutputAlreadyExistsError) throw error;
      // Any stat failure means "not there", which is what we want.
    }
  }
  return resolved;
}
