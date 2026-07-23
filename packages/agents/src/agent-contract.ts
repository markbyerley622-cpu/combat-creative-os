import type { AgentInput, AgentOutput } from '@combat/domain';

/**
 * The shape every future specialist agent module must implement. Not
 * implemented by anything yet — see registry.ts.
 */
export type SpecialistAgentHandler<TIn, TOut> = (
  input: AgentInput<TIn>,
) => Promise<AgentOutput<TOut>>;
