/**
 * An in-process fake of ComfyUI's HTTP protocol.
 *
 * It speaks the real routes (`/prompt`, `/history/{id}`, `/queue`, `/view`,
 * `/interrupt`, `/object_info`, `/system_stats`, `/upload/image`) with the
 * real response shapes, so the adapter under test runs its actual transport,
 * parsing and state-machine code rather than a stubbed-out version of it.
 *
 * What it explicitly does **not** do is generate video. It hands back a few
 * bytes labelled as an MP4. That is the whole reason a passing protocol test
 * is not evidence of working generation, and why the binding acceptance test
 * for this milestone is the opt-in one that talks to a real endpoint.
 */

export interface FakeComfyUIOptions {
  /** `/queue` and `/history` report the job as running for this many polls before completing. */
  readonly pollsBeforeCompletion?: number;
  /** Completes with `status_str: "error"` and an `execution_error` message. */
  readonly failWithError?: string;
  /** Completes successfully but with no video artefact in `outputs`. */
  readonly completeWithNoOutput?: boolean;
  /** `/view` returns an empty body. */
  readonly emptyOutputBytes?: boolean;
  /** `POST /prompt` answers 400 with this validation error. */
  readonly rejectSubmission?: string;
  /** Every route returns unparseable JSON. */
  readonly malformedResponses?: boolean;
  /** Node classes `/object_info` reports. Defaults to everything LTX needs. */
  readonly installedNodes?: readonly string[];
  /** VRAM `/system_stats` reports, in bytes. */
  readonly vramTotalBytes?: number;
  /** Bytes `/view` returns for a produced clip. */
  readonly outputBytes?: Uint8Array;
}

export interface FakeComfyUIServer {
  readonly fetchImpl: typeof fetch;
  /** Every request the adapter made, in order — `"POST /prompt"` etc. */
  readonly calls: string[];
  /** Prompt ids that reached `POST /prompt`. A retry that queued twice shows up here. */
  readonly submittedPromptIds: string[];
  readonly interruptCount: () => number;
  readonly deletedPromptIds: string[];
  readonly uploadedFilenames: string[];
}

const DEFAULT_NODES = [
  'CheckpointLoaderSimple',
  'CLIPTextEncode',
  'EmptyLTXVLatentVideo',
  'LTXVConditioning',
  'ModelSamplingLTXV',
  'LTXVImgToVideo',
  'KSampler',
  'VAEDecode',
  'LoadImage',
  'CreateVideo',
  'SaveVideo',
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function createFakeComfyUIServer(options: FakeComfyUIOptions = {}): FakeComfyUIServer {
  const pollsBeforeCompletion = options.pollsBeforeCompletion ?? 0;
  const outputBytes = options.outputBytes ?? new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);

  const calls: string[] = [];
  const submittedPromptIds: string[] = [];
  const deletedPromptIds: string[] = [];
  const uploadedFilenames: string[] = [];
  let interrupts = 0;
  const pollCounts = new Map<string, number>();

  /**
   * Progress advances on `/queue`, never on `/history`.
   *
   * The adapter consults history first and the queue second within a single
   * status check, so a counter that moved during the history read would make
   * the two disagree inside one poll — the job would look "not in history" and
   * "not in the queue" simultaneously, which real ComfyUI never does.
   */
  const isComplete = (promptId: string): boolean =>
    (pollCounts.get(promptId) ?? 0) >= pollsBeforeCompletion;

  const historyFor = (promptId: string): Record<string, unknown> => {
    if (options.failWithError) {
      return {
        [promptId]: {
          outputs: {},
          status: {
            status_str: 'error',
            completed: false,
            messages: [
              [
                'execution_error',
                {
                  prompt_id: promptId,
                  node_type: 'KSampler',
                  exception_type: 'RuntimeError',
                  exception_message: options.failWithError,
                },
              ],
            ],
          },
        },
      };
    }
    return {
      [promptId]: {
        outputs: options.completeWithNoOutput
          ? { '10': { text: ['nothing playable here'] } }
          : {
              '10': {
                preview_video: [
                  { filename: 'combat_00001.mp4', subfolder: 'combat', type: 'output' },
                ],
              },
            },
        status: { status_str: 'success', completed: true, messages: [] },
      },
    };
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const route = `${method} ${url.pathname}`;
    calls.push(route);

    if (options.malformedResponses) {
      return new Response('this is not json at all', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (route === 'POST /prompt') {
      if (options.rejectSubmission) {
        return json(
          {
            error: { type: 'prompt_outputs_failed_validation', message: options.rejectSubmission },
            node_errors: { '1': { errors: [{ message: options.rejectSubmission }] } },
          },
          400,
        );
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { prompt_id?: string };
      const promptId = body.prompt_id ?? 'server-generated';
      submittedPromptIds.push(promptId);
      pollCounts.set(promptId, 0);
      return json({ prompt_id: promptId, number: 1, node_errors: {} });
    }

    if (url.pathname.startsWith('/history/')) {
      const promptId = decodeURIComponent(url.pathname.slice('/history/'.length));
      if (!pollCounts.has(promptId)) return json({});
      // ComfyUI has no history entry until execution ends.
      if (!isComplete(promptId)) return json({});
      return json(historyFor(promptId));
    }

    if (route === 'GET /queue') {
      const pending = [...pollCounts.entries()]
        .filter(([promptId]) => !isComplete(promptId))
        .map(([promptId]) => [0, promptId, {}, {}, []]);
      for (const [promptId, count] of pollCounts.entries()) {
        if (!isComplete(promptId)) pollCounts.set(promptId, count + 1);
      }
      return json({ queue_running: [], queue_pending: pending });
    }

    if (route === 'POST /queue') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { delete?: string[] };
      for (const promptId of body.delete ?? []) deletedPromptIds.push(promptId);
      return json({});
    }

    if (route === 'GET /view') {
      return new Response(options.emptyOutputBytes ? new Uint8Array() : outputBytes, {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      });
    }

    if (route === 'POST /interrupt') {
      interrupts += 1;
      return json({});
    }

    if (route === 'GET /object_info') {
      const nodes = options.installedNodes ?? DEFAULT_NODES;
      return json(Object.fromEntries(nodes.map((node) => [node, { input: {}, output: [] }])));
    }

    if (route === 'GET /system_stats') {
      return json({
        system: { comfyui_version: '0.3.99', python_version: '3.12.0' },
        devices: [
          {
            name: 'cuda:0 NVIDIA Test GPU',
            type: 'cuda',
            vram_total: options.vramTotalBytes ?? 24 * 1024 ** 3,
            vram_free: 20 * 1024 ** 3,
          },
        ],
      });
    }

    if (route === 'POST /upload/image') {
      const form = init?.body;
      let name = 'uploaded.png';
      if (typeof FormData !== 'undefined' && form instanceof FormData) {
        const file = form.get('image');
        if (file && typeof file === 'object' && 'name' in file) {
          name = String((file as { name: unknown }).name);
        }
      }
      uploadedFilenames.push(name);
      return json({ name, subfolder: '', type: 'input' });
    }

    return json({ error: `fake ComfyUI has no route ${route}` }, 404);
  };

  return {
    fetchImpl,
    calls,
    submittedPromptIds,
    deletedPromptIds,
    uploadedFilenames,
    interruptCount: () => interrupts,
  };
}
