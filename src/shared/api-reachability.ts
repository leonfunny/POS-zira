/**
 * Tracks overlapping REST probes without allowing an older late result to
 * overwrite a newer observation.
 */
export class ApiReachabilityTracker {
  private sequence = 0;
  private lastAppliedProbe = 0;
  private reachable: boolean | null = null;

  beginProbe(): number {
    return ++this.sequence;
  }

  apply(probeId: number, reachable: boolean): boolean {
    if (probeId < this.lastAppliedProbe) return false;
    this.lastAppliedProbe = probeId;
    this.reachable = reachable;
    return true;
  }

  get(): boolean | null {
    return this.reachable;
  }
}
