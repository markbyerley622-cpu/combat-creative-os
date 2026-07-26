import { z } from 'zod';

/**
 * The ComfyUI wire protocol, as a parse boundary.
 *
 * Every byte ComfyUI sends back crosses into this package through one of the
 * schemas below. Nothing downstream reads an untyped field off a response
 * object: a server that answers with a shape we did not expect fails here,
 * loudly, instead of surfacing as `undefined` three call frames later while a
 * budget reservation is already standing.
 *
 * Shapes are taken from ComfyUI's own reference client
 * (`script_examples/websockets_api_example.py`) and `server.py`'s route
 * definitions, not from memory — see `docs/aamp-comfyui.md` for the pinned
 * source list.
 */

/** `type` values a ComfyUI `/view` request accepts for the folder to read from. */
export const COMFYUI_FOLDER_TYPES = ['output', 'input', 'temp'] as const;
export const ComfyUIFolderTypeSchema = z.enum(COMFYUI_FOLDER_TYPES);
export type ComfyUIFolderType = z.infer<typeof ComfyUIFolderTypeSchema>;

/**
 * One saved artefact, as it appears in a history `outputs` entry. ComfyUI's
 * `SaveVideo` node emits these under `preview_video`; `SaveWEBM` uses the same
 * structure, `SaveImage` uses `images`, and the widely-deployed
 * `VHS_VideoCombine` custom node uses `gifs`. The reader below accepts all of
 * them and filters by extension rather than pinning one key, because the key
 * is a property of whichever save node a workflow template chose.
 */
export const ComfyUISavedResultSchema = z
  .object({
    filename: z.string().min(1),
    subfolder: z.string().default(''),
    type: ComfyUIFolderTypeSchema.default('output'),
  })
  .passthrough();
export type ComfyUISavedResult = z.infer<typeof ComfyUISavedResultSchema>;

/**
 * `POST /prompt` success. `prompt_id` is the job identifier every later call
 * keys off. `node_errors` is present-but-empty on success.
 */
export const ComfyUIQueueResponseSchema = z
  .object({
    prompt_id: z.string().min(1),
    number: z.number().optional(),
    node_errors: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type ComfyUIQueueResponse = z.infer<typeof ComfyUIQueueResponseSchema>;

/**
 * `POST /prompt` validation failure (HTTP 400). ComfyUI reports graph problems
 * here — a missing model file, an unknown node class, an out-of-range widget
 * value — which is exactly the class of failure that must map to a
 * non-retryable `PROVIDER_REJECTED` rather than a retry loop.
 */
export const ComfyUIErrorResponseSchema = z
  .object({
    error: z.union([
      z.string(),
      z
        .object({
          type: z.string().optional(),
          message: z.string().optional(),
          details: z.string().optional(),
        })
        .passthrough(),
    ]),
    node_errors: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type ComfyUIErrorResponse = z.infer<typeof ComfyUIErrorResponseSchema>;

/** Terminal status strings ComfyUI writes into a history entry. */
export const COMFYUI_STATUS_STRINGS = ['success', 'error'] as const;

export const ComfyUIHistoryStatusSchema = z
  .object({
    status_str: z.string().optional(),
    completed: z.boolean().optional(),
    /**
     * Loosely typed on purpose: ComfyUI appends heterogeneous
     * `[event_name, payload]` tuples here and adds new event kinds between
     * releases. We read it only to surface a human-readable failure detail,
     * never to make a control-flow decision.
     */
    messages: z.array(z.unknown()).optional(),
  })
  .passthrough();
export type ComfyUIHistoryStatus = z.infer<typeof ComfyUIHistoryStatusSchema>;

export const ComfyUIHistoryEntrySchema = z
  .object({
    outputs: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    status: ComfyUIHistoryStatusSchema.optional(),
  })
  .passthrough();
export type ComfyUIHistoryEntry = z.infer<typeof ComfyUIHistoryEntrySchema>;

/** `GET /history/{prompt_id}` returns a map keyed by prompt id, not the entry itself. */
export const ComfyUIHistoryResponseSchema = z.record(z.string(), ComfyUIHistoryEntrySchema);
export type ComfyUIHistoryResponse = z.infer<typeof ComfyUIHistoryResponseSchema>;

/**
 * `GET /queue`. Entries are positional tuples (`[number, prompt_id, prompt,
 * extra_data, outputs_to_execute]`), so only the parts we actually use are
 * described: index 1 is the prompt id, which is how a job still waiting in the
 * queue is distinguished from one that vanished entirely.
 */
export const ComfyUIQueueStateSchema = z
  .object({
    queue_running: z.array(z.array(z.unknown())).default([]),
    queue_pending: z.array(z.array(z.unknown())).default([]),
  })
  .passthrough();
export type ComfyUIQueueState = z.infer<typeof ComfyUIQueueStateSchema>;

export const ComfyUIDeviceSchema = z
  .object({
    name: z.string().optional(),
    type: z.string().optional(),
    vram_total: z.number().optional(),
    vram_free: z.number().optional(),
  })
  .passthrough();

export const ComfyUISystemStatsSchema = z
  .object({
    system: z
      .object({
        comfyui_version: z.string().optional(),
        python_version: z.string().optional(),
      })
      .passthrough()
      .optional(),
    devices: z.array(ComfyUIDeviceSchema).default([]),
  })
  .passthrough();
export type ComfyUISystemStats = z.infer<typeof ComfyUISystemStatsSchema>;

/**
 * `GET /object_info` — the installed node catalogue. Only the keys matter for
 * capability discovery (is this node class installed at all?), so values stay
 * `unknown` rather than modelling ComfyUI's full input-spec grammar.
 */
export const ComfyUIObjectInfoSchema = z.record(z.string(), z.unknown());
export type ComfyUIObjectInfo = z.infer<typeof ComfyUIObjectInfoSchema>;

/** `POST /upload/image` response — where ComfyUI actually put the file. */
export const ComfyUIUploadResponseSchema = z
  .object({
    name: z.string().min(1),
    subfolder: z.string().default(''),
    type: ComfyUIFolderTypeSchema.default('input'),
  })
  .passthrough();
export type ComfyUIUploadResponse = z.infer<typeof ComfyUIUploadResponseSchema>;

/**
 * WebSocket frames. ComfyUI multiplexes several event kinds over one socket
 * and adds new ones between releases, so unknown `type` values are ignored
 * rather than rejected — but the frames we *do* act on are parsed strictly
 * enough that a malformed one cannot be mistaken for a completion.
 */
export const ComfyUIWebSocketMessageSchema = z
  .object({
    type: z.string().min(1),
    data: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();
export type ComfyUIWebSocketMessage = z.infer<typeof ComfyUIWebSocketMessageSchema>;

/**
 * `executing` with `node: null` for our prompt id is ComfyUI's documented
 * end-of-execution signal (the reference client breaks its receive loop on
 * exactly this condition).
 */
export const ComfyUIExecutingDataSchema = z
  .object({
    node: z.string().nullable(),
    prompt_id: z.string().optional(),
  })
  .passthrough();

export const ComfyUIProgressDataSchema = z
  .object({
    value: z.number(),
    max: z.number(),
    prompt_id: z.string().optional(),
  })
  .passthrough();

export const ComfyUIExecutionErrorDataSchema = z
  .object({
    prompt_id: z.string().optional(),
    node_id: z.string().optional(),
    node_type: z.string().optional(),
    exception_message: z.string().optional(),
    exception_type: z.string().optional(),
  })
  .passthrough();

/** Video containers a generation workflow may hand back. */
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mkv', '.mov', '.gif'] as const;

export function hasVideoExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return VIDEO_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Pulls every saved video artefact out of a history entry's `outputs`, in a
 * stable order.
 *
 * Order matters: `candidateIndex` is derived from position here and is the key
 * the rest of the system uses to correlate a candidate with its persisted
 * asset across retries and workflow replays. Node ids are sorted numerically
 * where possible so a graph with nodes `2` and `10` does not order them
 * lexicographically as `10` then `2`.
 */
export function extractVideoOutputs(entry: ComfyUIHistoryEntry): ComfyUISavedResult[] {
  const nodeIds = Object.keys(entry.outputs).sort((a, b) => {
    const numericA = Number(a);
    const numericB = Number(b);
    if (Number.isFinite(numericA) && Number.isFinite(numericB) && numericA !== numericB) {
      return numericA - numericB;
    }
    return a.localeCompare(b);
  });

  const results: ComfyUISavedResult[] = [];
  for (const nodeId of nodeIds) {
    const nodeOutput = entry.outputs[nodeId];
    if (!nodeOutput) continue;
    for (const key of Object.keys(nodeOutput).sort()) {
      const value = nodeOutput[key];
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        const parsed = ComfyUISavedResultSchema.safeParse(item);
        if (parsed.success && hasVideoExtension(parsed.data.filename)) {
          results.push(parsed.data);
        }
      }
    }
  }
  return results;
}

/** Best-effort human-readable reason from a failed history entry. */
export function describeHistoryFailure(entry: ComfyUIHistoryEntry): string | undefined {
  const messages = entry.status?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (!Array.isArray(message) || message.length < 2) continue;
    const [name, payload] = message;
    if (name !== 'execution_error') continue;
    const parsed = ComfyUIExecutionErrorDataSchema.safeParse(payload);
    if (!parsed.success) continue;
    const { node_type: nodeType, exception_type: type, exception_message: text } = parsed.data;
    return [nodeType && `node ${nodeType}`, type, text].filter(Boolean).join(': ');
  }
  return undefined;
}
