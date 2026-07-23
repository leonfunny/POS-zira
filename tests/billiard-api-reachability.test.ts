import { describe, expect, it } from 'vitest';
import { ApiReachabilityTracker } from '../src/shared/api-reachability';

describe('billiard REST reachability', () => {
  it('starts unknown and accepts the first completed probe', () => {
    const tracker = new ApiReachabilityTracker();
    const probe = tracker.beginProbe();

    expect(tracker.get()).toBeNull();
    expect(tracker.apply(probe, true)).toBe(true);
    expect(tracker.get()).toBe(true);
  });

  it('ignores a late failure from a request older than a successful probe', () => {
    const tracker = new ApiReachabilityTracker();
    const oldDashboardProbe = tracker.beginProbe();
    const cashierMutationProbe = tracker.beginProbe();

    expect(tracker.apply(cashierMutationProbe, true)).toBe(true);
    expect(tracker.apply(oldDashboardProbe, false)).toBe(false);
    expect(tracker.get()).toBe(true);
  });
});
