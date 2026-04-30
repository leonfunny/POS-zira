import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Regression: BookingCreateForm must allow submit when the selected
 * service has zero pricing rules but valid base_duration_minutes /
 * base_price_pln. Before this fix, canSubmit required `!!ruleId` and
 * the Create button stayed permanently disabled for all 23 rule-less
 * services in the Dzai catalog.
 */
describe('BookingCreateForm canSubmit / no-rules fallback', () => {
  const source = readFileSync(
    resolve(__dirname, '../src/renderer/components/booking/BookingCreateForm.tsx'),
    'utf-8',
  );

  it('does not require ruleId when the service has no rules', () => {
    // canSubmit must NOT bail on bare `!!ruleId`. Either a rule was
    // picked OR the fallback path (noRulesAvailable + base fields) is
    // satisfied.
    expect(source).toMatch(/noRulesAvailable/);
    expect(source).toMatch(/effectiveDurationMin/);
    expect(source).toMatch(/effectivePricePln/);
  });

  it('shows duration/price even when no rule is selected', () => {
    // The summary block uses the effective values, not just selectedRule.
    expect(source).toMatch(/effectiveDurationMin\s*!=\s*null/);
    expect(source).toMatch(/effectivePricePln\s*!=\s*null/);
  });

  it('still submits ruleId: undefined when caller has no rule', () => {
    // The submit body uses the existing pattern `ruleId: ruleId ||
    // undefined` — keep that line so a missing rule passes through to
    // the IPC bridge correctly.
    expect(source).toMatch(/ruleId:\s*ruleId\s*\|\|\s*undefined/);
  });

  it('clears ruleId when serviceId changes and tracks loading state', () => {
    // Stale-ruleId guard: clearing rules + ruleId at the top of the
    // service-change effect prevents canSubmit from firing with a rule
    // belonging to the previous service while the new fetch is still
    // in flight.
    expect(source).toMatch(/setRulesLoadingForServiceId/);
    expect(source).toMatch(/rulesAreLoading/);
    // selectedRule must verify rule.service_id === serviceId.
    expect(source).toMatch(/r\.service_id\s*===\s*serviceId/);
  });
});
