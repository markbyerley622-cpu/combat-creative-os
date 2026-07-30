import type {
  GeneratedCandidateRef,
  GenerationJobHandle,
  JobStatus,
  VideoGenerationCapabilities,
  VideoGenerationFailure,
  VideoGenerationProvider,
  VideoGenerationSubmitInput,
  VideoGenerationUsage,
} from '@combat/providers';

import { StoryboardVideoError } from '../storyboard-video/failures';

/**
 * A provider that will submit exactly one billable generation, ever.
 *
 * The underlying LTX adapter already refuses to retry a paid call on its own.
 * This is the second, structural half of the same rule for a run whose entire
 * authorisation is "one request": a second `submit` cannot happen because
 * there is no code path that permits it, rather than because no caller
 * currently calls it twice.
 *
 * It wraps rather than replaces, so every property of the real adapter — the
 * credential staying inside it, the rights gate, the immediate download, the
 * typed failures — is untouched. Only `submit` is guarded. Polling, fetching,
 * usage and cancellation are free operations against a job that has already
 * been bought, and counting them would make the number mean something other
 * than "billable requests".
 *
 * A repeated `submit` carrying the *same* idempotency key is answered from the
 * first handle rather than refused: that is a caller asking about the request
 * it already made, and the adapter beneath does the same. It is a different
 * key that is the refusal, because that is a caller asking to pay twice.
 */
export class OneRequestVideoGenerationProvider implements VideoGenerationProvider {
  readonly name: string;

  private submissions = 0;
  private firstKey: string | null = null;
  private firstHandle: GenerationJobHandle | null = null;

  constructor(private readonly inner: VideoGenerationProvider) {
    this.name = inner.name;
  }

  /** Billable submissions made through this guard. Zero until one is made. */
  get billableSubmissionCount(): number {
    return this.submissions;
  }

  getCapabilities(): VideoGenerationCapabilities {
    return this.inner.getCapabilities();
  }

  async submit(input: VideoGenerationSubmitInput): Promise<GenerationJobHandle> {
    if (this.firstHandle && this.firstKey === input.idempotencyKey) return this.firstHandle;
    if (this.firstHandle) {
      throw new StoryboardVideoError(
        'JOB_SUBMISSION_FAILED',
        `this run is authorised for exactly one paid generation and has already made it (${this.firstHandle.shotId}). A second submission with a different idempotency key is refused rather than sent. Deciding to pay again is a person's decision, taken by rerunning the command.`,
      );
    }
    const handle = await this.inner.submit(input);
    this.submissions += 1;
    this.firstKey = input.idempotencyKey;
    this.firstHandle = handle;
    return handle;
  }

  getStatus(handle: GenerationJobHandle): Promise<JobStatus> {
    return this.inner.getStatus(handle);
  }

  getFailure(handle: GenerationJobHandle): Promise<VideoGenerationFailure | null> {
    return this.inner.getFailure(handle);
  }

  fetchResult(handle: GenerationJobHandle): Promise<GeneratedCandidateRef[]> {
    return this.inner.fetchResult(handle);
  }

  getUsage(handle: GenerationJobHandle): Promise<VideoGenerationUsage> {
    return this.inner.getUsage(handle);
  }

  cancel(handle: GenerationJobHandle): Promise<void> {
    return this.inner.cancel(handle);
  }
}

/**
 * A `fetch` that counts what passed through it.
 *
 * The dry run's central claim is "no request was made and nothing was spent".
 * Counting at the transport is what makes that claim checkable by a test
 * rather than asserted in a report: a dry run that touched the network would
 * show a non-zero count even if every other artefact said otherwise.
 */
export class CountingFetch {
  private count = 0;

  constructor(private readonly inner: typeof fetch) {}

  get requestCount(): number {
    return this.count;
  }

  readonly fetch: typeof fetch = (input, init) => {
    this.count += 1;
    return this.inner(input, init);
  };
}
