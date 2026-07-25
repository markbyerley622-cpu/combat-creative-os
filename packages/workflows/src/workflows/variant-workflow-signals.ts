import { defineQuery, defineSignal } from '@temporalio/workflow';
import type { VariantProgress } from '@combat/domain';

/** M12 VariantWorkflow signal/query definitions — no logic, no I/O (mirrors compositing-workflow-signals.ts). */
export const cancelVariantsSignal = defineSignal('cancelVariantsSignal');
export const getVariantProgressQuery = defineQuery<VariantProgress>('getVariantProgress');
