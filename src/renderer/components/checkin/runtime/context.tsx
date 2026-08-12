import React, { createContext, useContext } from 'react';
import type { CheckinRuntime } from './types';
import { windowsCheckinRuntime } from './windows-runtime';

const RUNTIME_METHODS = [
  'checkins.getToday',
  'checkins.getStats',
  'checkins.createWithCustomer',
  'checkins.startService',
  'checkins.complete',
  'checkins.markNoShow',
  'bookings.getToday',
  'catalog.getServices',
  'catalog.getCategories',
  'catalog.getStaff',
  'customers.getByPhone',
  'customers.create',
] as const;

const OPTIONAL_RUNTIME_METHODS = [
  'checkins.printConfirmation',
  'bookings.search',
  'customers.getRecommendations',
  'servicePopularity.get',
] as const;

function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

export function normalizeCheckinRuntime(runtime: unknown): CheckinRuntime {
  if (!runtime || typeof runtime !== 'object') {
    throw new Error('Check-in runtime is required');
  }

  for (const path of RUNTIME_METHODS) {
    if (typeof readPath(runtime, path) !== 'function') {
      throw new Error(`Invalid check-in runtime: ${path} must be a function`);
    }
  }
  for (const path of OPTIONAL_RUNTIME_METHODS) {
    const method = readPath(runtime, path);
    if (method !== undefined && typeof method !== 'function') {
      throw new Error(`Invalid check-in runtime: optional ${path} must be undefined or a function`);
    }
  }

  const presentation = (runtime as { presentation?: unknown }).presentation;
  if (!presentation || typeof presentation !== 'object') {
    throw new Error('Invalid check-in runtime: presentation must be an object');
  }
  const policy = presentation as Record<string, unknown>;
  if (policy.audience !== 'staff' && policy.audience !== 'customer-kiosk') {
    throw new Error('Invalid check-in runtime: presentation.audience is invalid');
  }
  if (policy.audience === 'customer-kiosk' && typeof readPath(runtime, 'bookings.search') !== 'function') {
    throw new Error('Invalid check-in runtime: customer-kiosk presentation requires bookings.search');
  }
  for (const key of ['showQueue', 'showStats', 'allowStatusMutations', 'allowBookingStaffOverride', 'requireCustomerPhone']) {
    if (typeof policy[key] !== 'boolean') {
      throw new Error(`Invalid check-in runtime: presentation.${key} must be a boolean`);
    }
  }
  if (policy.maxSelectedServices !== undefined
    && (!Number.isInteger(policy.maxSelectedServices) || (policy.maxSelectedServices as number) <= 0)) {
    throw new Error('Invalid check-in runtime: presentation.maxSelectedServices must be a positive integer');
  }
  if (policy.minPhoneDigits !== undefined
    && (!Number.isInteger(policy.minPhoneDigits) || (policy.minPhoneDigits as number) <= 0)) {
    throw new Error('Invalid check-in runtime: presentation.minPhoneDigits must be a positive integer');
  }

  const session = (runtime as { session?: unknown }).session;
  if (session !== undefined) {
    if (!session || typeof session !== 'object') {
      throw new Error('Invalid check-in runtime: session must be an object');
    }
    const { scopeKey, inactivityResetMs } = session as Record<string, unknown>;
    if (typeof scopeKey !== 'string' || scopeKey.trim().length === 0) {
      throw new Error('Invalid check-in runtime: session.scopeKey must be a non-empty string');
    }
    if (
      inactivityResetMs !== undefined
      && (!Number.isInteger(inactivityResetMs) || (inactivityResetMs as number) <= 0)
    ) {
      throw new Error('Invalid check-in runtime: session.inactivityResetMs must be a positive integer');
    }
  }

  return runtime as CheckinRuntime;
}

const CheckinRuntimeContext = createContext<CheckinRuntime | null>(null);

export interface CheckinRuntimeProviderProps {
  runtime: CheckinRuntime;
  children: React.ReactNode;
}

export function CheckinRuntimeProvider({ runtime, children }: CheckinRuntimeProviderProps) {
  const normalizedRuntime = normalizeCheckinRuntime(runtime);
  return (
    <CheckinRuntimeContext.Provider value={normalizedRuntime}>
      {children}
    </CheckinRuntimeContext.Provider>
  );
}

export function useCheckinRuntime(): CheckinRuntime {
  return useContext(CheckinRuntimeContext) ?? windowsCheckinRuntime;
}
