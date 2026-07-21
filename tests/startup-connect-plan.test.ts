/**
 * resolveStartupConnectPlan — boot-time reconnect decision.
 *
 * Regression coverage for the silent-offline bug: after
 *   logout (isPaired=false, pa_ key wiped, salonId kept)
 *   → login to a DIFFERENT salon (archive/restore RELAUNCH branch,
 *     returns before its inline connect)
 * the post-relaunch start() was the only place left to open the
 * /print-agent socket, but it gated on isPaired and did nothing, so an
 * authenticated terminal sat OFFLINE with no user-visible signal.
 *
 * The plan must re-establish the socket whenever a user session exists
 * (auth token + salonId), independent of isPaired, while preserving the
 * device-credential (no user session) and stale-flag paths.
 *
 * PRD-driven: asserts the returned action per input state (not a source
 * grep). One focused case per branch.
 */

import { describe, expect, it } from 'vitest';
import {
  resolveStartupConnectPlan,
  type StartupConnectState,
} from '../src/main/network/startup-connect-plan';

// Defaults = fresh install: nothing paired, no session, no creds.
function makeState(overrides: Partial<StartupConnectState> = {}): StartupConnectState {
  return {
    isPaired: false,
    hasToken: false,
    hasSalonId: false,
    hasApiKey: false,
    hasSecureKey: false,
    hasMachineId: false,
    ...overrides,
  };
}

describe('resolveStartupConnectPlan — the silent-offline regression', () => {
  it('reconnects after logout → login-different-salon relaunch (token+salonId, key wiped, isPaired=false)', () => {
    // This is the reported bug. Logout wiped the pa_ key and set
    // isPaired=false; the different-salon login relaunched before its
    // inline connect. Only start() is left — it MUST fetch my-key.
    const plan = resolveStartupConnectPlan(
      makeState({ isPaired: false, hasToken: true, hasSalonId: true, hasMachineId: true }),
    );
    expect(plan.action).toBe('connect-with-key');
  });

  it('reconnects when authenticated with no key and no machineId (clean post-logout)', () => {
    const plan = resolveStartupConnectPlan(
      makeState({ isPaired: false, hasToken: true, hasSalonId: true }),
    );
    expect(plan.action).toBe('connect-with-key');
  });
});

describe('resolveStartupConnectPlan — normal authenticated boot', () => {
  it('uses the key path when paired with a stored pa_ key and a session', () => {
    const plan = resolveStartupConnectPlan(
      makeState({
        isPaired: true,
        hasToken: true,
        hasSalonId: true,
        hasApiKey: true,
        hasSecureKey: true,
        hasMachineId: true,
      }),
    );
    expect(plan.action).toBe('connect-with-key');
  });
});

describe('resolveStartupConnectPlan — device-credential (no user session) paths preserved', () => {
  it('legacy-connects a paired api-key-only terminal with no user token', () => {
    // No token ⇒ cannot call my-key; must connect with the stored key.
    const plan = resolveStartupConnectPlan(
      makeState({ isPaired: true, hasSalonId: true, hasApiKey: true, hasSecureKey: true, hasMachineId: true }),
    );
    expect(plan.action).toBe('legacy-connect');
  });

  it('legacy-connects a paired legacy machineId+token terminal (no pa_ key, no session)', () => {
    const plan = resolveStartupConnectPlan(
      makeState({ isPaired: true, hasSecureKey: true, hasMachineId: true }),
    );
    expect(plan.action).toBe('legacy-connect');
  });
});

describe('resolveStartupConnectPlan — stale flag and idle boots', () => {
  it('clears a stale isPaired flag when there are no usable credentials', () => {
    const plan = resolveStartupConnectPlan(makeState({ isPaired: true }));
    expect(plan.action).toBe('reset-paired');
  });

  it('does nothing on a fresh/logged-out boot with no salon', () => {
    const plan = resolveStartupConnectPlan(makeState());
    expect(plan.action).toBe('noop');
  });

  it('does nothing when a token exists but there is no salon to connect to', () => {
    const plan = resolveStartupConnectPlan(makeState({ hasToken: true }));
    expect(plan.action).toBe('noop');
  });
});
