import { defineQuery, defineSignal } from '@temporalio/workflow';
import type { CompositingProgress } from '@combat/domain';

/** M9 CompositingWorkflow signal/query definitions — no logic, no I/O (mirrors shot-generation-workflow-signals.ts). */
export const cancelCompositingSignal = defineSignal('cancelCompositingSignal');
export const getCompositingProgressQuery =
  defineQuery<CompositingProgress>('getCompositingProgress');
