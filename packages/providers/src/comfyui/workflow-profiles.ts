import type { VideoGenerationCapabilities, VideoGenerationMode } from '../video-generation';

/**
 * Versioned, provider-owned ComfyUI workflow profiles.
 *
 * A profile is the *only* way a graph reaches ComfyUI. Callers pick a profile
 * key and supply typed parameters; they never author nodes. That is the whole
 * point — an API client that could post its own graph could execute arbitrary
 * ComfyUI nodes on the render host, which is remote code execution wearing a
 * JSON hat.
 *
 * Node class names and their input field names below are taken verbatim from
 * ComfyUI's own source (`comfy_extras/nodes_lt.py`, `comfy_extras/nodes_hunyuan.py`,
 * `nodes.py`, `comfy_extras/nodes_video.py`) and the official model tutorials —
 * never from recollection. `templateStatus` records, per profile, how far that
 * verification actually got: a graph assembled from verified node signatures is
 * still not a graph that has been *executed*, and this codebase does not
 * pretend otherwise.
 */

export const COMFYUI_WORKFLOW_PROFILE_KEYS = [
  'LTX_2_3_DRAFT',
  'HUNYUAN_VIDEO_1_5_QUALITY',
] as const;
export type ComfyUIWorkflowProfileKey = (typeof COMFYUI_WORKFLOW_PROFILE_KEYS)[number];

export function isComfyUIWorkflowProfileKey(value: string): value is ComfyUIWorkflowProfileKey {
  return (COMFYUI_WORKFLOW_PROFILE_KEYS as readonly string[]).includes(value);
}

/**
 * How much of a template has actually been proven.
 *
 * - `EXECUTED_AGAINST_LIVE_SERVER` — a real run produced a real file. Nothing
 *   in this repository carries this value yet; it is set only by a human after
 *   the opt-in real integration test passes on a given endpoint.
 * - `SIGNATURES_VERIFIED_NOT_EXECUTED` — every node class and input name was
 *   read out of ComfyUI's source, and the graph is well-formed against those
 *   signatures, but it has never been executed.
 * - `REQUIRES_LIVE_VERIFICATION` — some part of the wiring could not be
 *   established from official sources. The profile refuses to build a graph.
 */
export const COMFYUI_TEMPLATE_STATUSES = [
  'EXECUTED_AGAINST_LIVE_SERVER',
  'SIGNATURES_VERIFIED_NOT_EXECUTED',
  'REQUIRES_LIVE_VERIFICATION',
] as const;
export type ComfyUITemplateStatus = (typeof COMFYUI_TEMPLATE_STATUSES)[number];

export interface ComfyUIModelFile {
  /** ComfyUI models subdirectory, e.g. `checkpoints`, `text_encoders`, `vae`. */
  readonly folder: string;
  readonly filename: string;
  /** Where the file is published. Recorded for provenance; nothing downloads it automatically. */
  readonly sourceUrl: string;
  /** Populated once a specific artefact has been downloaded and hashed locally. */
  readonly sha256?: string;
  readonly approximateGigabytes: number;
}

export interface ComfyUIModelLicense {
  readonly name: string;
  readonly url: string;
  /** False means output may not be used in a commercial advertisement without further review. */
  readonly permitsCommercialOutput: boolean;
  readonly notes: string;
}

export interface ComfyUIHardwareRequirements {
  readonly minimumVramGb: number;
  readonly minimumSystemRamGb: number;
  readonly minimumFreeDiskGb: number;
  /** Where the numbers came from, so a future reader can re-check them. */
  readonly sourceUrl: string;
}

export interface ComfyUIReferenceControl {
  readonly supportsReferenceImages: boolean;
  readonly maxReferenceImages: number;
  /** Whether reference *video bytes* may be submitted. False everywhere here — see ADR-0005 §9.1. */
  readonly supportsReferenceVideo: boolean;
  readonly supportsStartFrame: boolean;
  readonly supportsEndFrame: boolean;
}

/** Everything a graph builder is allowed to vary. Nothing else is interpolable. */
export interface ComfyUIGraphInput {
  readonly promptText: string;
  readonly negativePrompt: string;
  readonly widthPx: number;
  readonly heightPx: number;
  /** Total frames. Derived from duration × frame rate and snapped by the profile. */
  readonly frameCount: number;
  readonly frameRate: number;
  readonly seed: number;
  readonly steps: number;
  readonly cfg: number;
  readonly batchSize: number;
  /**
   * Names of images already uploaded into ComfyUI's `input` folder. Generated
   * from content checksums by the provider — never authored text.
   */
  readonly referenceImageFilenames: readonly string[];
  /** Output filename prefix. Validated filesystem-safe before it reaches here. */
  readonly filenamePrefix: string;
  readonly mode: VideoGenerationMode;
}

export interface ComfyUIEnvironmentFacts {
  /** Node class names the server reports through `/object_info`. */
  readonly installedNodes: ReadonlySet<string>;
  /** Largest single-device VRAM the server reports, in GB. Undefined when unknown. */
  readonly vramGb?: number;
}

export interface ComfyUICompatibilityResult {
  readonly compatible: boolean;
  readonly problems: readonly string[];
}

export class ComfyUIProfileError extends Error {
  constructor(
    public readonly profileKey: ComfyUIWorkflowProfileKey,
    message: string,
  ) {
    super(message);
    this.name = 'ComfyUIProfileError';
  }
}

export interface ComfyUIWorkflowProfile {
  readonly key: ComfyUIWorkflowProfileKey;
  /** Bumped whenever the graph shape changes. Recorded in every asset's provenance. */
  readonly templateVersion: number;
  readonly templateStatus: ComfyUITemplateStatus;
  readonly modelIdentifier: string;
  readonly modelRepositoryUrl: string;
  readonly modelFiles: readonly ComfyUIModelFile[];
  readonly license: ComfyUIModelLicense;
  readonly requiredNodes: readonly string[];
  readonly hardware: ComfyUIHardwareRequirements;
  readonly capabilities: VideoGenerationCapabilities;
  readonly referenceControl: ComfyUIReferenceControl;
  readonly defaultNegativePrompt: string;
  readonly defaultSteps: number;
  readonly defaultCfg: number;
  /** Frame counts these models expect: `k * n + 1`. Enforced by `snapFrameCount`. */
  readonly frameCountMultiple: number;
  /** Both dimensions must be a multiple of this. */
  readonly dimensionMultiple: number;
  validateEnvironment(facts: ComfyUIEnvironmentFacts): ComfyUICompatibilityResult;
  buildGraph(input: ComfyUIGraphInput): Record<string, unknown>;
}

/**
 * Latent video models encode in fixed temporal chunks, so a frame count that is
 * not `multiple * n + 1` is silently rounded by the sampler — which would make
 * the produced clip a different length than the render manifest budgeted for.
 * Snapping here, deterministically, keeps the timeline arithmetic honest.
 */
export function snapFrameCount(requested: number, multiple: number): number {
  const chunks = Math.max(1, Math.round((requested - 1) / multiple));
  return chunks * multiple + 1;
}

export function snapDimension(requested: number, multiple: number): number {
  return Math.max(multiple, Math.round(requested / multiple) * multiple);
}

function checkNodes(
  profileKey: ComfyUIWorkflowProfileKey,
  required: readonly string[],
  facts: ComfyUIEnvironmentFacts,
  hardware: ComfyUIHardwareRequirements,
): ComfyUICompatibilityResult {
  const problems: string[] = [];
  const missing = required.filter((node) => !facts.installedNodes.has(node));
  if (missing.length > 0) {
    problems.push(
      `${profileKey}: ComfyUI does not have these node classes installed: ${missing.join(', ')}`,
    );
  }
  if (facts.vramGb !== undefined && facts.vramGb + 0.5 < hardware.minimumVramGb) {
    problems.push(
      `${profileKey}: endpoint reports ${facts.vramGb.toFixed(1)} GB VRAM but this profile needs at least ${hardware.minimumVramGb} GB`,
    );
  }
  return { compatible: problems.length === 0, problems };
}

/** Core ComfyUI nodes both profiles rely on, listed once. */
const CORE_SAVE_NODES = ['CreateVideo', 'SaveVideo'] as const;

/**
 * LTX-2.3 — the fast iteration profile.
 *
 * Node signatures verified against `comfy_extras/nodes_lt.py`:
 * `EmptyLTXVLatentVideo(width, height, length, batch_size) -> LATENT`,
 * `LTXVConditioning(positive, negative, frame_rate) -> (CONDITIONING, CONDITIONING)`,
 * `ModelSamplingLTXV(model, max_shift, base_shift) -> MODEL`,
 * `LTXVImgToVideo(positive, negative, vae, image, width, height, length, batch_size, strength)
 *   -> (CONDITIONING, CONDITIONING, LATENT)`.
 * Core node signatures verified against `nodes.py` and `comfy_extras/nodes_video.py`.
 */
const LTX_2_3_DRAFT: ComfyUIWorkflowProfile = {
  key: 'LTX_2_3_DRAFT',
  templateVersion: 1,
  templateStatus: 'SIGNATURES_VERIFIED_NOT_EXECUTED',
  modelIdentifier: 'ltx-2-19b-distilled',
  modelRepositoryUrl: 'https://huggingface.co/Lightricks/LTX-Video',
  modelFiles: [
    {
      folder: 'checkpoints',
      filename: 'ltx-2-19b-distilled.safetensors',
      sourceUrl: 'https://huggingface.co/Lightricks/LTX-Video',
      approximateGigabytes: 20,
    },
    {
      folder: 'text_encoders',
      filename: 'gemma-3-12b-it-qat-q4_0-unquantized',
      sourceUrl: 'https://huggingface.co/Lightricks/LTX-Video',
      approximateGigabytes: 12,
    },
  ],
  license: {
    name: 'LTX-Video Open Weights License',
    url: 'https://huggingface.co/Lightricks/LTX-Video/blob/main/License.txt',
    permitsCommercialOutput: true,
    notes:
      'Lightricks publishes LTX-Video under an open-weights licence with a use-based restrictions annex. Confirm the current terms before any commercial delivery — this field records where to look, it is not legal advice.',
  },
  requiredNodes: [
    'CheckpointLoaderSimple',
    'CLIPTextEncode',
    'EmptyLTXVLatentVideo',
    'LTXVConditioning',
    'ModelSamplingLTXV',
    'LTXVImgToVideo',
    'KSampler',
    'VAEDecode',
    'LoadImage',
    ...CORE_SAVE_NODES,
  ],
  hardware: {
    minimumVramGb: 12,
    minimumSystemRamGb: 32,
    minimumFreeDiskGb: 100,
    sourceUrl: 'https://docs.comfy.org/tutorials/video/ltx/ltx-2',
  },
  capabilities: {
    supportedModes: ['TEXT_TO_VIDEO', 'IMAGE_TO_VIDEO'],
    supportsReferenceImages: true,
    maxReferenceImages: 1,
    supportsReferenceVideo: false,
    supportedAspectRatios: ['9:16'],
    supportedResolutions: ['704x1280', '768x1344', '1080x1920'],
    minDurationSeconds: 1,
    maxDurationSeconds: 10,
    supportedFrameRates: [24, 25, 30],
    supportsSeed: true,
    supportsNegativePrompt: true,
    maxCandidateCount: 2,
  },
  referenceControl: {
    supportsReferenceImages: true,
    maxReferenceImages: 1,
    supportsReferenceVideo: false,
    supportsStartFrame: true,
    supportsEndFrame: false,
  },
  defaultNegativePrompt:
    'worst quality, blurry, jittery, distorted, watermark, text artifacts, warped hands, extra limbs, oversaturated',
  defaultSteps: 8,
  defaultCfg: 1,
  frameCountMultiple: 8,
  dimensionMultiple: 32,

  validateEnvironment(facts) {
    return checkNodes(this.key, this.requiredNodes, facts, this.hardware);
  },

  buildGraph(input) {
    const checkpoint = 'ltx-2-19b-distilled.safetensors';
    const graph: Record<string, unknown> = {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: input.promptText, clip: ['1', 1] } },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: input.negativePrompt, clip: ['1', 1] } },
      '6': {
        class_type: 'ModelSamplingLTXV',
        inputs: { model: ['1', 0], max_shift: 2.05, base_shift: 0.95 },
      },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['1', 2] } },
      '9': { class_type: 'CreateVideo', inputs: { images: ['8', 0], fps: input.frameRate } },
      '10': {
        class_type: 'SaveVideo',
        inputs: {
          video: ['9', 0],
          filename_prefix: input.filenamePrefix,
          format: 'mp4',
          codec: 'h264',
        },
      },
    };

    const referenceImage = input.referenceImageFilenames[0];
    if (input.mode === 'IMAGE_TO_VIDEO') {
      if (!referenceImage) {
        throw new ComfyUIProfileError(
          this.key,
          'IMAGE_TO_VIDEO requires exactly one reference image, but none was uploaded',
        );
      }
      // LTXVImgToVideo emits its own conditioning pair *and* the seeded latent,
      // so it replaces both EmptyLTXVLatentVideo and the plain LTXVConditioning
      // wiring used by the text-to-video path.
      graph['4'] = { class_type: 'LoadImage', inputs: { image: referenceImage } };
      graph['5'] = {
        class_type: 'LTXVImgToVideo',
        inputs: {
          positive: ['2', 0],
          negative: ['3', 0],
          vae: ['1', 2],
          image: ['4', 0],
          width: input.widthPx,
          height: input.heightPx,
          length: input.frameCount,
          batch_size: input.batchSize,
          strength: 1.0,
        },
      };
      graph['11'] = {
        class_type: 'LTXVConditioning',
        inputs: { positive: ['5', 0], negative: ['5', 1], frame_rate: input.frameRate },
      };
      graph['7'] = {
        class_type: 'KSampler',
        inputs: {
          model: ['6', 0],
          seed: input.seed,
          steps: input.steps,
          cfg: input.cfg,
          sampler_name: 'euler',
          scheduler: 'normal',
          positive: ['11', 0],
          negative: ['11', 1],
          latent_image: ['5', 2],
          denoise: 1.0,
        },
      };
      return graph;
    }

    graph['4'] = {
      class_type: 'EmptyLTXVLatentVideo',
      inputs: {
        width: input.widthPx,
        height: input.heightPx,
        length: input.frameCount,
        batch_size: input.batchSize,
      },
    };
    graph['5'] = {
      class_type: 'LTXVConditioning',
      inputs: { positive: ['2', 0], negative: ['3', 0], frame_rate: input.frameRate },
    };
    graph['7'] = {
      class_type: 'KSampler',
      inputs: {
        model: ['6', 0],
        seed: input.seed,
        steps: input.steps,
        cfg: input.cfg,
        sampler_name: 'euler',
        scheduler: 'normal',
        positive: ['5', 0],
        negative: ['5', 1],
        latent_image: ['4', 0],
        denoise: 1.0,
      },
    };
    return graph;
  },
};

/**
 * HunyuanVideo 1.5 — the quality profile, deliberately not runnable yet.
 *
 * Its model files, node classes, licence and hardware floor are all recorded
 * from official sources (`comfy_extras/nodes_hunyuan.py` and the ComfyUI
 * tutorial). What could *not* be established from those sources is how the two
 * text encoders this model needs — `qwen_2.5_vl_7b_fp8_scaled` and
 * `byt5_small_glyphxl_fp16` — are loaded and combined in the native template.
 *
 * Guessing that wiring and shipping it as a working profile is exactly the
 * failure mode CLAUDE.md's "never claim support merely because a profile
 * exists" rule exists to prevent, so `buildGraph` refuses. The metadata is
 * still useful: it is what a future milestone validates against a live
 * endpoint before flipping `templateStatus`.
 */
const HUNYUAN_VIDEO_1_5_QUALITY: ComfyUIWorkflowProfile = {
  key: 'HUNYUAN_VIDEO_1_5_QUALITY',
  templateVersion: 0,
  templateStatus: 'REQUIRES_LIVE_VERIFICATION',
  modelIdentifier: 'hunyuanvideo1.5-720p-t2v',
  modelRepositoryUrl: 'https://huggingface.co/tencent/HunyuanVideo-1.5',
  modelFiles: [
    {
      folder: 'diffusion_models',
      filename: 'hunyuanvideo1.5_720p_t2v_fp16.safetensors',
      sourceUrl: 'https://docs.comfy.org/tutorials/video/hunyuan/hunyuan-video-1-5',
      approximateGigabytes: 17,
    },
    {
      folder: 'diffusion_models',
      filename: 'hunyuanvideo1.5_1080p_sr_distilled_fp16.safetensors',
      sourceUrl: 'https://docs.comfy.org/tutorials/video/hunyuan/hunyuan-video-1-5',
      approximateGigabytes: 7,
    },
    {
      folder: 'text_encoders',
      filename: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
      sourceUrl: 'https://docs.comfy.org/tutorials/video/hunyuan/hunyuan-video-1-5',
      approximateGigabytes: 9,
    },
    {
      folder: 'text_encoders',
      filename: 'byt5_small_glyphxl_fp16.safetensors',
      sourceUrl: 'https://docs.comfy.org/tutorials/video/hunyuan/hunyuan-video-1-5',
      approximateGigabytes: 1,
    },
    {
      folder: 'vae',
      filename: 'hunyuanvideo15_vae_fp16.safetensors',
      sourceUrl: 'https://docs.comfy.org/tutorials/video/hunyuan/hunyuan-video-1-5',
      approximateGigabytes: 1,
    },
  ],
  license: {
    name: 'Tencent HunyuanVideo Community License',
    url: 'https://huggingface.co/tencent/HunyuanVideo-1.5',
    permitsCommercialOutput: false,
    notes:
      'Tencent publishes HunyuanVideo under a community licence with territorial and monthly-active-user conditions. Treat commercial output as blocked until reviewed.',
  },
  requiredNodes: [
    'UNETLoader',
    'VAELoader',
    'CLIPTextEncode',
    'EmptyHunyuanVideo15Latent',
    'HunyuanVideo15ImageToVideo',
    'HunyuanVideo15SuperResolution',
    'LatentUpscaleModelLoader',
    'KSampler',
    'VAEDecode',
    ...CORE_SAVE_NODES,
  ],
  hardware: {
    minimumVramGb: 24,
    minimumSystemRamGb: 32,
    minimumFreeDiskGb: 120,
    sourceUrl: 'https://blog.comfy.org/p/hunyuanvideo-15-native-support',
  },
  capabilities: {
    supportedModes: ['TEXT_TO_VIDEO', 'IMAGE_TO_VIDEO'],
    supportsReferenceImages: true,
    maxReferenceImages: 1,
    supportsReferenceVideo: false,
    supportedAspectRatios: ['9:16'],
    supportedResolutions: ['720x1280', '1080x1920'],
    minDurationSeconds: 2,
    maxDurationSeconds: 10,
    supportedFrameRates: [24, 25],
    supportsSeed: true,
    supportsNegativePrompt: true,
    maxCandidateCount: 1,
  },
  referenceControl: {
    supportsReferenceImages: true,
    maxReferenceImages: 1,
    supportsReferenceVideo: false,
    supportsStartFrame: true,
    supportsEndFrame: false,
  },
  defaultNegativePrompt:
    'worst quality, blurry, jittery, distorted, watermark, text artifacts, warped hands, extra limbs, oversaturated',
  defaultSteps: 30,
  defaultCfg: 6,
  frameCountMultiple: 4,
  dimensionMultiple: 16,

  validateEnvironment(facts) {
    const base = checkNodes(this.key, this.requiredNodes, facts, this.hardware);
    return {
      compatible: false,
      problems: [
        ...base.problems,
        `${this.key}: template status is REQUIRES_LIVE_VERIFICATION — the dual text-encoder wiring for this model has not been confirmed against a live ComfyUI server, so this profile cannot be selected yet`,
      ],
    };
  },

  buildGraph() {
    throw new ComfyUIProfileError(
      'HUNYUAN_VIDEO_1_5_QUALITY',
      'HUNYUAN_VIDEO_1_5_QUALITY has no executable template yet: the qwen_2.5_vl + byt5 text-encoder wiring could not be established from official sources. Verify it against a live ComfyUI server and raise templateStatus before selecting this profile.',
    );
  },
};

export const COMFYUI_WORKFLOW_PROFILES: Readonly<
  Record<ComfyUIWorkflowProfileKey, ComfyUIWorkflowProfile>
> = {
  LTX_2_3_DRAFT,
  HUNYUAN_VIDEO_1_5_QUALITY,
};

export function getComfyUIWorkflowProfile(key: ComfyUIWorkflowProfileKey): ComfyUIWorkflowProfile {
  const profile = COMFYUI_WORKFLOW_PROFILES[key];
  if (!profile) {
    throw new ComfyUIProfileError(key, `Unknown ComfyUI workflow profile "${key}"`);
  }
  return profile;
}

/** Largest single-device VRAM figure, in GB, from a `/system_stats` payload. */
export function largestDeviceVramGb(
  devices: readonly { vram_total?: number | undefined }[],
): number | undefined {
  const totals = devices
    .map((device) => device.vram_total)
    .filter((value): value is number => typeof value === 'number' && value > 0);
  if (totals.length === 0) return undefined;
  return Math.max(...totals) / 1024 ** 3;
}
