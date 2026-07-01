export type ConfirmActionKind = 'void' | 'cancel' | 'deleteLocal' | 'deleteHeld';
export type ConfirmActionTier = 'light' | 'review';

export interface ConfirmActionContext {
  label?: string;
  total?: string;
  isSynced?: boolean;
}

export interface ConfirmActionCopy {
  tier: ConfirmActionTier;
  titleKey: string;
  titleFallback: string;
  bodyFallback: string;
  consequenceFallback: string;
  confirmLabelFallback: string;
}

function describeTarget(ctx: ConfirmActionContext): string {
  const label = ctx.label?.trim() || 'this order';
  return ctx.total ? `${label} (${ctx.total})` : label;
}

export function buildConfirmCopy(action: ConfirmActionKind, ctx: ConfirmActionContext = {}): ConfirmActionCopy {
  const target = describeTarget(ctx);

  switch (action) {
    case 'void':
      if (ctx.isSynced === false) {
        return {
          tier: 'review',
          titleKey: 'pos.confirm.voidLocal.title',
          titleFallback: 'Delete unsynced order',
          bodyFallback: `Review ${target} before deleting it from this register.`,
          consequenceFallback: 'This cannot be undone. The local order will be removed and stock will be restored.',
          confirmLabelFallback: 'Delete local order',
        };
      }
      return {
        tier: 'review',
        titleKey: 'pos.confirm.void.title',
        titleFallback: 'Void order',
        bodyFallback: `Review ${target} before voiding it on the server.`,
        consequenceFallback: 'This cannot be undone. Stock will be restored and the synced order will be closed.',
        confirmLabelFallback: 'Void order',
      };
    case 'cancel':
      return {
        tier: 'review',
        titleKey: 'pos.confirm.cancel.title',
        titleFallback: 'Cancel order',
        bodyFallback: `Review ${target} before cancelling it.`,
        consequenceFallback: 'This cannot be undone. The order will be cancelled and stock will be restored.',
        confirmLabelFallback: 'Cancel order',
      };
    case 'deleteLocal':
      return {
        tier: 'review',
        titleKey: 'pos.confirm.deleteLocal.title',
        titleFallback: 'Delete local order',
        bodyFallback: `Review ${target} before deleting it from this register.`,
        consequenceFallback: 'This cannot be undone. The local order will be removed and stock will be restored.',
        confirmLabelFallback: 'Delete local order',
      };
    case 'deleteHeld':
      return {
        tier: 'light',
        titleKey: 'pos.confirm.deleteHeld.title',
        titleFallback: 'Delete held cart',
        bodyFallback: `Delete ${target}? This only removes the held cart from this register.`,
        consequenceFallback: 'The active sale is not charged and stock is not changed.',
        confirmLabelFallback: 'Delete held cart',
      };
  }
}
