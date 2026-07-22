import type {
  RestoredCartReconciliation,
  RestoredInterruptionContext,
} from '../../../shared/billiard-pos-handoff';

/**
 * Surface the durable restored-cart identity immediately after an uncertain
 * tender result. Waiting for an app restart would leave the owner action
 * hidden behind the still-mounted payment modal.
 */
export function buildImmediateRestoredCartReconciliation(
  context: RestoredInterruptionContext | null | undefined,
  message: string,
): RestoredCartReconciliation | undefined {
  if (!context) return undefined;
  return {
    holdId: context.holdId,
    checkoutId: context.checkoutId,
    orderId: context.orderId,
    clientAttemptId: context.clientAttemptId,
    reason: 'TENDER_OUTCOME_UNCERTAIN',
    message,
  };
}
