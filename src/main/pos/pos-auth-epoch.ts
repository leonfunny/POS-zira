import type { PosSnapshotScope } from '../../shared/pos/billiard-pos-handoff';

export interface PosAuthContext {
  epoch: number;
  scope: PosSnapshotScope;
}

export class PosAuthEpochGuard {
  private epoch = 0;

  capture(scope: PosSnapshotScope): PosAuthContext {
    return { epoch: this.epoch, scope: { ...scope } };
  }

  advance(): void {
    this.epoch++;
  }

  isCurrent(context: PosAuthContext, scope: PosSnapshotScope): boolean {
    return context.epoch === this.epoch
      && context.scope.salonId === scope.salonId
      && context.scope.userId === scope.userId
      && context.scope.registerId === scope.registerId;
  }
}
