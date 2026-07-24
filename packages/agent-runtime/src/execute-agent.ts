import { z, type ZodType } from 'zod';
import type { AgentInput } from '@combat/domain';
import type {
  ReasoningContentBlock,
  ReasoningMessage,
  ReasoningModelMeta,
  ReasoningProvider,
} from '@combat/providers';
import type { AgentDefinition } from './agent-definition';
import type { AgentExecutionContext } from './execution-context';
import type { AgentRun } from './agent-run';
import { ReasoningBreakdownSchema, type ReasoningBreakdown } from './reasoning-breakdown';
import { computeCost } from './cost';
import { stableHash, stableStringify } from './hash';
import { toStrictJsonSchema } from './json-schema';
import { redact } from './redact';
import {
  AgentDisabledError,
  AgentExecutionError,
  AgentInputInvalidError,
  AgentNotImplementedError,
  AgentProviderError,
  AgentSchemaInvalidError,
  toAgentFailure,
} from './errors';

const OUTPUT_TOOL_NAME = 'submit_agent_output';
const ZERO_MODEL_META: ReasoningModelMeta = {
  model: 'n/a',
  tokensIn: 0,
  tokensOut: 0,
  latencyMs: 0,
};

/**
 * The one place every specialist agent's reasoning call goes through
 * (requirements 1, 2, 4, 9): validates input, forces a strict structured
 * output via the reasoning provider, validates the response, retries once
 * with a corrective re-prompt on schema failure, and never returns
 * malformed data to the caller — a failure is reported as
 * `AgentRun.status === 'FAILED'`, not silently coerced into something
 * shaped like success. The caller (a future orchestrator Activity) is
 * expected to check `status` before applying any state change.
 */
export async function executeAgent<TInput, TResult>(
  definition: AgentDefinition<TInput, TResult>,
  input: AgentInput<TInput>,
  ctx: AgentExecutionContext,
): Promise<AgentRun<TResult>> {
  const now = ctx.now ?? Date.now;
  const startedAt = now();
  const inputHash = stableHash(input.input);

  if (!definition.implemented) {
    throw new AgentNotImplementedError(
      definition.name,
      definition.futureMilestone ?? 'unscheduled',
    );
  }
  if (definition.disabledByDefault) {
    throw new AgentDisabledError(definition.name);
  }

  const parsedInput = definition.inputSchema.safeParse(input.input);
  if (!parsedInput.success) {
    return finish(
      definition,
      input,
      ctx,
      startedAt,
      now(),
      inputHash,
      null,
      new AgentInputInvalidError(definition.name, parsedInput.error.issues),
      ZERO_MODEL_META,
    );
  }

  // `resultSchema` is cast to `ZodType<unknown>` here purely to keep TS's
  // generic instantiation of this envelope shallow — deeply threading the
  // generic `TResult` through a freshly-built `z.object(...)` inside a
  // generic function defeats TS's inference and either fails to typecheck
  // or blows the instantiation-depth limit. The cast back to
  // `EnvelopeResult<TResult>` below is safe because `definition.resultSchema`
  // (a `ZodType<TResult>`) is exactly what validated `result` at runtime.
  const envelopeSchema = z.object({
    result: definition.resultSchema as ZodType<unknown>,
    reasoning: ReasoningBreakdownSchema,
  });
  const jsonSchema = toStrictJsonSchema(envelopeSchema, OUTPUT_TOOL_NAME);
  const attachments = input.attachments ?? [];
  const inputText = stableStringify({ input: parsedInput.data, context: input.context });
  const baseMessages: ReasoningMessage[] = [
    {
      role: 'user',
      content:
        attachments.length === 0
          ? inputText
          : [
              { type: 'text', text: inputText },
              ...attachments.map((attachment): ReasoningContentBlock => ({
                type: 'image',
                mediaType: attachment.mediaType,
                base64Data: attachment.base64Data,
              })),
            ],
    },
  ];

  try {
    const first = await callProvider(
      ctx.reasoningProvider,
      definition,
      input,
      jsonSchema,
      baseMessages,
    );
    const parsedFirst = envelopeSchema.safeParse(safeJsonParse(first.raw));
    if (parsedFirst.success) {
      const success = parsedFirst.data as EnvelopeResult<TResult>;
      return finish(
        definition,
        input,
        ctx,
        startedAt,
        now(),
        inputHash,
        success,
        null,
        first.modelMeta,
      );
    }

    // One bounded corrective re-prompt (architecture.md §6) — never an
    // unbounded regeneration loop (CLAUDE.md "Workflow-idempotency rules").
    const correctiveMessages: ReasoningMessage[] = [
      ...baseMessages,
      { role: 'assistant', content: first.raw },
      {
        role: 'user',
        content:
          'Your previous response did not satisfy the required schema. Validation errors:\n' +
          JSON.stringify(parsedFirst.error.issues, null, 2) +
          '\nCall the tool again with a corrected response that satisfies the schema exactly.',
      },
    ];
    const second = await callProvider(
      ctx.reasoningProvider,
      definition,
      input,
      jsonSchema,
      correctiveMessages,
    );
    const parsedSecond = envelopeSchema.safeParse(safeJsonParse(second.raw));
    if (parsedSecond.success) {
      const success = parsedSecond.data as EnvelopeResult<TResult>;
      return finish(
        definition,
        input,
        ctx,
        startedAt,
        now(),
        inputHash,
        success,
        null,
        second.modelMeta,
      );
    }

    return finish(
      definition,
      input,
      ctx,
      startedAt,
      now(),
      inputHash,
      null,
      new AgentSchemaInvalidError(definition.name, parsedSecond.error.issues),
      second.modelMeta,
    );
  } catch (error) {
    if (error instanceof AgentExecutionError) {
      return finish(
        definition,
        input,
        ctx,
        startedAt,
        now(),
        inputHash,
        null,
        error,
        ZERO_MODEL_META,
      );
    }
    return finish(
      definition,
      input,
      ctx,
      startedAt,
      now(),
      inputHash,
      null,
      new AgentProviderError(definition.name, error),
      ZERO_MODEL_META,
    );
  }
}

async function callProvider<TInput, TResult>(
  provider: ReasoningProvider,
  definition: AgentDefinition<TInput, TResult>,
  input: AgentInput<TInput>,
  jsonSchema: Record<string, unknown>,
  messages: ReasoningMessage[],
): Promise<{ raw: string; modelMeta: ReasoningModelMeta }> {
  try {
    return await provider.invoke({
      idempotencyKey: input.invocationId,
      promptVersion: String(definition.promptVersion.version),
      systemPrompt: definition.promptVersion.systemPrompt,
      messages,
      maxOutputTokens: definition.tokenBudget.maxOutputTokens,
      modelPolicy: definition.modelPolicy,
      outputSchema: {
        name: OUTPUT_TOOL_NAME,
        description: `Structured output for the ${definition.name} agent.`,
        jsonSchema,
      },
    });
  } catch (error) {
    throw new AgentProviderError(definition.name, error);
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

interface EnvelopeResult<TResult> {
  readonly result: TResult;
  readonly reasoning: ReasoningBreakdown;
}

function finish<TInput, TResult>(
  definition: AgentDefinition<TInput, TResult>,
  input: AgentInput<TInput>,
  ctx: AgentExecutionContext,
  startedAt: number,
  completedAt: number,
  inputHash: string,
  success: EnvelopeResult<TResult> | null,
  error: AgentExecutionError | null,
  modelMeta: ReasoningModelMeta,
): AgentRun<TResult> {
  const cost = computeCost(modelMeta.model, modelMeta.tokensIn, modelMeta.tokensOut);
  const outputHash = success ? stableHash(success.result) : null;
  const evaluation =
    success && definition.deriveEvaluation ? definition.deriveEvaluation(success.result) : null;

  const run: AgentRun<TResult> = {
    invocationId: input.invocationId,
    agentName: definition.name,
    status: success ? 'SUCCEEDED' : 'FAILED',
    result: success ? success.result : null,
    reasoning: success ? success.reasoning : null,
    evaluation,
    modelMeta: {
      model: modelMeta.model,
      promptVersion: definition.promptVersion.version,
      tokensIn: modelMeta.tokensIn,
      tokensOut: modelMeta.tokensOut,
      latencyMs: modelMeta.latencyMs,
    },
    cost,
    failure: error ? toAgentFailure(error) : null,
    inputHash,
    outputHash,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
  };

  ctx.logger?.info(redact({ event: 'agent_run', ...run }), 'agent invocation completed');
  return run;
}
