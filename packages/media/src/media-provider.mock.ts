import type { InspectMediaInput } from './inspect';
import type {
  MediaProvider,
  ProxyRequest,
  ProxyResult,
  ThumbnailRequest,
  ThumbnailResult,
} from './media-provider';
import type { MediaProbeResult } from './types';

/**
 * Deterministic, no-ffmpeg-required fake — canned per `filePath` so a test
 * can drive multiple distinct inputs (a good file, a corrupt one, a
 * mismatched one) through the same provider instance without real process
 * spawning. Matches `MockStorageProvider`'s "throw on unregistered key"
 * convention: an unregistered path is a test-authoring bug, not a silent
 * empty result.
 */
export class MockMediaProvider implements MediaProvider {
  readonly name = 'mock-media';
  private readonly probeResults = new Map<string, MediaProbeResult | Error>();
  private readonly thumbnailResults = new Map<string, ThumbnailResult | Error>();
  private readonly proxyResults = new Map<string, ProxyResult | Error>();

  setProbeResult(filePath: string, result: MediaProbeResult | Error): void {
    this.probeResults.set(filePath, result);
  }

  setThumbnailResult(sourcePath: string, result: ThumbnailResult | Error): void {
    this.thumbnailResults.set(sourcePath, result);
  }

  setProxyResult(sourcePath: string, result: ProxyResult | Error): void {
    this.proxyResults.set(sourcePath, result);
  }

  async probe(input: InspectMediaInput): Promise<MediaProbeResult> {
    const result = this.probeResults.get(input.filePath);
    if (result === undefined) {
      throw new Error(`MockMediaProvider: no canned probe result registered for ${input.filePath}`);
    }
    if (result instanceof Error) throw result;
    return result;
  }

  async generateThumbnail(request: ThumbnailRequest): Promise<ThumbnailResult> {
    const result = this.thumbnailResults.get(request.sourcePath);
    if (result === undefined) {
      throw new Error(
        `MockMediaProvider: no canned thumbnail result registered for ${request.sourcePath}`,
      );
    }
    if (result instanceof Error) throw result;
    return result;
  }

  async generateProxy(request: ProxyRequest): Promise<ProxyResult> {
    const result = this.proxyResults.get(request.sourcePath);
    if (result === undefined) {
      throw new Error(
        `MockMediaProvider: no canned proxy result registered for ${request.sourcePath}`,
      );
    }
    if (result instanceof Error) throw result;
    return result;
  }
}
