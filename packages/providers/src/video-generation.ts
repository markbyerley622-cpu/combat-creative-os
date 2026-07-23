import type { AssetRef, IdempotencyKey, JobStatus } from './types';

/**
 * Provider-neutral interface for video generation providers (docs/architecture.md
 * §5). Veo is the preferred future hero-footage provider; Runway is the
 * preferred future alternative-take/shot-repair provider (§7.1 resolved
 * default #1). Neither has a real adapter yet — only this interface and the
 * deterministic mock in video-generation.mock.ts exist at this milestone.
 */
export interface VideoGenerationSubmitInput {
  idempotencyKey: IdempotencyKey;
  shotId: string;
  promptText: string;
  candidateCount: number;
}

export interface GenerationJobHandle {
  jobId: string;
  shotId: string;
}

export interface GeneratedCandidateRef extends AssetRef {
  candidateIndex: number;
}

export interface VideoGenerationProvider {
  readonly name: string;
  submit(input: VideoGenerationSubmitInput): Promise<GenerationJobHandle>;
  getStatus(handle: GenerationJobHandle): Promise<JobStatus>;
  fetchResult(handle: GenerationJobHandle): Promise<GeneratedCandidateRef[]>;
  cancel(handle: GenerationJobHandle): Promise<void>;
}
