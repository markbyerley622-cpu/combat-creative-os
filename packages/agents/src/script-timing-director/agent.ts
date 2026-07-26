import {
  DEFAULT_MODEL_POLICY,
  DEFAULT_TOKEN_BUDGET,
  NO_TOOL_POLICY,
  defineAgent,
} from '@combat/agent-runtime';
import { ScriptTimingDirectorInputSchema, ScriptTimingDirectorResultSchema } from './schema';
import { V3 } from './prompts/v3';

/**
 * Canonical registry id is `script-timing-director` (preserved from the
 * approved architecture); "Script Director" is a display label only — see
 * `displayName` below and `docs/adr/0003-agent-execution-framework.md`.
 */
export const scriptTimingDirectorAgent = defineAgent({
  name: 'script-timing-director',
  displayName: 'Script Director',
  description: 'Turns an approved creative concept into a shot-level script with frame timing.',
  implemented: true,
  disabledByDefault: false,
  inputSchema: ScriptTimingDirectorInputSchema,
  resultSchema: ScriptTimingDirectorResultSchema,
  promptVersion: V3,
  modelPolicy: { ...DEFAULT_MODEL_POLICY, effort: 'high' },
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  toolPolicy: NO_TOOL_POLICY,
});
