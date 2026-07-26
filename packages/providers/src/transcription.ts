import { NodeCommandRunner, type CommandRunner } from '@combat/media';

/**
 * Optional speech transcription for reference analysis.
 *
 * The governing rule is that **an unavailable transcriber records
 * `TRANSCRIPTION_UNAVAILABLE`; it never invents a transcript**. A fabricated
 * transcript would be indistinguishable from a real one in the database, and
 * would then be studied as if it were evidence of how an advertisement is
 * scripted. Absence is a fact worth persisting; a guess is not.
 *
 * Nothing here downloads model weights. The Whisper adapter shells out to an
 * existing local `whisper` command if one is already installed, and reports
 * itself unavailable otherwise.
 */

export interface TranscriptSegment {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly text: string;
}

export interface TranscriptionRequest {
  readonly filePath: string;
  readonly language?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type TranscriptionResult =
  | {
      readonly available: true;
      readonly provider: string;
      readonly model: string;
      readonly language?: string;
      readonly segments: readonly TranscriptSegment[];
    }
  | {
      readonly available: false;
      readonly provider: string;
      /** Why, in words an operator can act on. */
      readonly reason: string;
    };

export interface TranscriptionProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

/**
 * Reports unavailable, always. The honest default when no transcriber is
 * installed — and what the ingestion pipeline uses unless one is injected.
 */
export class UnavailableTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'none';

  constructor(private readonly reason = 'no transcription provider is configured') {}

  async isAvailable(): Promise<boolean> {
    return false;
  }

  // Takes the request it ignores, so the concrete class still satisfies the
  // interface's call signature at every call site.
  async transcribe(_request: TranscriptionRequest): Promise<TranscriptionResult> {
    return { available: false, provider: this.name, reason: this.reason };
  }
}

/** Deterministic transcript replay for tests. */
export class MockTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'mock-transcription';

  constructor(
    private readonly segmentsByFile: Readonly<Record<string, readonly TranscriptSegment[]>> = {},
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const key = request.filePath.replace(/\\/g, '/').split('/').pop() ?? request.filePath;
    const segments = this.segmentsByFile[key];
    if (!segments) {
      return {
        available: false,
        provider: this.name,
        reason: `no scripted transcript for "${key}"`,
      };
    }
    return { available: true, provider: this.name, model: 'mock-1', segments };
  }
}

/**
 * Local Whisper CLI adapter.
 *
 * Deliberately conservative: it uses an *already installed* `whisper`
 * executable and a model the operator has already fetched. It never triggers a
 * download, because the first run of a large Whisper model silently pulls
 * gigabytes, and an ingestion command is not the place to discover that.
 */
export interface WhisperOptions {
  readonly executable?: string;
  /** A model the operator already has locally. Nothing is downloaded. */
  readonly model?: string;
  readonly runner?: CommandRunner;
}

export class WhisperCliTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'whisper-cli';
  private readonly executable: string;
  private readonly model: string;
  private readonly runner: CommandRunner;

  constructor(options: WhisperOptions = {}) {
    this.executable = options.executable ?? 'whisper';
    this.model = options.model ?? 'base';
    this.runner = options.runner ?? new NodeCommandRunner();
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.runner.run(this.executable, ['--help'], { timeoutMs: 30_000 });
      return true;
    } catch {
      return false;
    }
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    if (!(await this.isAvailable())) {
      return {
        available: false,
        provider: this.name,
        reason: `"${this.executable}" is not installed. Transcription is optional; install a local Whisper CLI and a model yourself if you want it.`,
      };
    }

    const args = [
      request.filePath,
      '--model',
      this.model,
      '--output_format',
      'json',
      '--output_dir',
      '-',
      ...(request.language ? ['--language', request.language] : []),
    ];

    try {
      const { stdout } = await this.runner.run(this.executable, args, {
        timeoutMs: request.timeoutMs ?? 15 * 60_000,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const segments = parseWhisperJson(stdout);
      if (segments.length === 0) {
        return {
          available: false,
          provider: this.name,
          reason: 'whisper produced no segments',
        };
      }
      return {
        available: true,
        provider: this.name,
        model: this.model,
        ...(request.language ? { language: request.language } : {}),
        segments,
      };
    } catch (error) {
      // A failed transcription is reported as unavailable, never as an empty
      // transcript — "we did not get one" and "there is no speech" are
      // different facts.
      return {
        available: false,
        provider: this.name,
        reason: `whisper failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

export function parseWhisperJson(stdout: string): TranscriptSegment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const raw = (parsed as { segments?: unknown })?.segments;
  if (!Array.isArray(raw)) return [];

  const segments: TranscriptSegment[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { start, end, text } = entry as { start?: unknown; end?: unknown; text?: unknown };
    if (typeof start !== 'number' || typeof end !== 'number' || typeof text !== 'string') continue;
    const trimmed = text.trim();
    if (trimmed.length === 0 || end <= start) continue;
    segments.push({ startSeconds: start, endSeconds: end, text: trimmed });
  }
  return segments;
}
