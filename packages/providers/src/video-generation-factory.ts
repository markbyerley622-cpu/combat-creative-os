import {
  getComfyUIWorkflowProfile,
  isComfyUIWorkflowProfileKey,
  type ComfyUIWorkflowProfileKey,
} from './comfyui/workflow-profiles';
import { assertSupportedLtxModel, type LtxModel } from './ltx/models';
import { ComfyUIVideoGenerationProvider } from './video-generation.comfyui';
import { LtxHostedVideoGenerationProvider } from './video-generation.ltx-hosted';
import { MockVideoGenerationProvider } from './video-generation.mock';
import type { VideoGenerationProvider } from './video-generation';

/**
 * The single place a `VideoGenerationProvider` is chosen.
 *
 * Before this existed, `apps/worker` constructed `MockVideoGenerationProvider`
 * unconditionally — honest at the time, because no real adapter existed, and
 * exactly the wrong thing once one does. Selection is now configuration-driven
 * and, critically, *refuses* the combinations that would produce fake work
 * silently.
 *
 * Takes a plain config object rather than `@combat/config`'s `WorkerEnv`:
 * `packages/providers` does not depend on `packages/config`, and the
 * composition roots (`apps/worker`, `apps/aamp-cli`) are what map validated
 * env onto this shape.
 */

export const VIDEO_GENERATION_PROVIDER_KINDS = ['mock', 'comfyui', 'ltx-hosted'] as const;
export type VideoGenerationProviderKind = (typeof VIDEO_GENERATION_PROVIDER_KINDS)[number];

export interface ComfyUIProviderConfig {
  readonly baseUrl: string;
  readonly workflowProfile: string;
  readonly clientId: string;
  readonly outputTimeoutMs: number;
  /** Absolute path. The composition root resolves any repository-relative value. */
  readonly outputDirectory: string;
  readonly apiKey?: string;
  readonly costCentsPerSecond?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

/**
 * LTX hosted configuration.
 *
 * `apiKey` is required and is the only place a credential enters this module.
 * It is passed straight into the provider's private client and is never stored
 * on the config object beyond construction, never logged, and never returned.
 */
export interface LtxHostedProviderFactoryConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly outputTimeoutMs: number;
  readonly requestTimeoutMs?: number;
  /** Absolute path. The composition root resolves any repository-relative value. */
  readonly outputDirectory: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

export interface VideoGenerationProviderConfig {
  readonly kind: VideoGenerationProviderKind;
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly comfyui?: ComfyUIProviderConfig;
  readonly ltxHosted?: LtxHostedProviderFactoryConfig;
}

export class VideoGenerationProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoGenerationProviderConfigError';
  }
}

/**
 * Validates a profile key and confirms the profile is actually runnable.
 *
 * A profile whose `templateStatus` is `REQUIRES_LIVE_VERIFICATION` is declared
 * but unproven — its graph has never been established against a real server.
 * Selecting it is refused here rather than at first dispatch, so the failure
 * arrives at startup with a message that says what to do about it.
 */
export function resolveWorkflowProfileKey(value: string): ComfyUIWorkflowProfileKey {
  if (!isComfyUIWorkflowProfileKey(value)) {
    throw new VideoGenerationProviderConfigError(
      `COMFYUI_WORKFLOW_PROFILE="${value}" is not a known workflow profile`,
    );
  }
  const profile = getComfyUIWorkflowProfile(value);
  if (profile.templateStatus === 'REQUIRES_LIVE_VERIFICATION') {
    throw new VideoGenerationProviderConfigError(
      `COMFYUI_WORKFLOW_PROFILE="${value}" has no verified workflow template yet (templateStatus=${profile.templateStatus}) and cannot be selected`,
    );
  }
  return value;
}

export function createVideoGenerationProvider(
  config: VideoGenerationProviderConfig,
): VideoGenerationProvider {
  if (config.kind === 'mock') {
    if (config.nodeEnv === 'production') {
      throw new VideoGenerationProviderConfigError(
        'Refusing to build the mock video-generation provider in production: it returns metadata-only placeholders, so every "generated" shot would be fabricated',
      );
    }
    return new MockVideoGenerationProvider();
  }

  if (config.kind === 'ltx-hosted') {
    return createLtxHostedProvider(config.ltxHosted);
  }

  const comfyui = config.comfyui;
  if (!comfyui) {
    throw new VideoGenerationProviderConfigError(
      'VIDEO_GENERATION_PROVIDER=comfyui was selected but no ComfyUI configuration was supplied',
    );
  }

  return new ComfyUIVideoGenerationProvider({
    baseUrl: comfyui.baseUrl,
    profileKey: resolveWorkflowProfileKey(comfyui.workflowProfile),
    clientId: comfyui.clientId,
    outputTimeoutMs: comfyui.outputTimeoutMs,
    outputDirectory: comfyui.outputDirectory,
    ...(comfyui.apiKey ? { apiKey: comfyui.apiKey } : {}),
    ...(comfyui.costCentsPerSecond === undefined
      ? {}
      : { costCentsPerSecond: comfyui.costCentsPerSecond }),
    ...(comfyui.fetchImpl ? { fetchImpl: comfyui.fetchImpl } : {}),
    ...(comfyui.now ? { now: comfyui.now } : {}),
  });
}

/**
 * Builds the LTX hosted provider, refusing at startup rather than at first
 * dispatch when the key is absent.
 *
 * Refusing here is what makes "this process cannot spend money without a key"
 * a property of the object graph. A provider that constructed successfully and
 * failed on the first paid call would have already uploaded a frame.
 */
export function createLtxHostedProvider(
  config: LtxHostedProviderFactoryConfig | undefined,
): VideoGenerationProvider {
  if (!config) {
    throw new VideoGenerationProviderConfigError(
      'VIDEO_GENERATION_PROVIDER=ltx-hosted was selected but no LTX configuration was supplied',
    );
  }
  if (!config.apiKey || config.apiKey.trim().length === 0) {
    throw new VideoGenerationProviderConfigError(
      'LTXV_API_KEY is not set. The LTX hosted provider is refused rather than started without a credential — there is no unauthenticated mode and no fallback to a fixture.',
    );
  }
  let model: LtxModel;
  try {
    model = assertSupportedLtxModel(config.model);
  } catch (error) {
    throw new VideoGenerationProviderConfigError(
      error instanceof Error ? error.message : String(error),
    );
  }
  return new LtxHostedVideoGenerationProvider({
    apiKey: config.apiKey,
    model,
    outputTimeoutMs: config.outputTimeoutMs,
    outputDirectory: config.outputDirectory,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs }),
    ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    ...(config.now ? { now: config.now } : {}),
  });
}
