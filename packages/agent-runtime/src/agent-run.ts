import type { AgentEvaluation } from './agent-evaluation';
import type { AgentFailure } from './errors';
import type { CostRecord } from './cost';
import type { ReasoningBreakdown } from './reasoning-breakdown';

export interface AgentModelMeta {
  readonly model: string;
  readonly promptVersion: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly latencyMs: number;
}

/**
 * The complete, persistable record of one agent invocation (requirement 5:
 * "Persist model, prompt version, input hash, output hash, latency, token
 * usage and estimated cost"). Returned by `executeAgent` for every outcome —
 * success or failure — so a calling Activity always has one uniform shape to
 * write to `AgentInvocation` (architecture.md §4.1), never a bare thrown
 * error for expected failure modes.
 */
export interface AgentRun<TResult> {
  readonly invocationId: string;
  readonly agentName: string;
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly result: TResult | null;
  readonly reasoning: ReasoningBreakdown | null;
  readonly evaluation: AgentEvaluation | null;
  readonly modelMeta: AgentModelMeta;
  readonly cost: CostRecord;
  readonly failure: AgentFailure | null;
  readonly inputHash: string;
  readonly outputHash: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
}
