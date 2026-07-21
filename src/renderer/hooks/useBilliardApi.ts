import { useMemo } from 'react';
import {
  buildBilliardAvailabilityPath,
  buildBilliardBookingsPath,
  normalizeBilliardAvailability,
  normalizeBilliardBookings,
  stripIpcErrorPrefix,
} from '../../shared/billiard-contract';

function rethrowClean(err: any): never {
  if (err?.message) err.message = stripIpcErrorPrefix(err.message);
  throw err;
}

/**
 * Billiard edit-mode API hooks.
 *
 * Layout updates (position, rotation, resize, batch) are routed through the
 * queue-aware billiard.mutate IPC so they work offline with optimistic local
 * updates. Create/delete operations that require server-generated IDs go
 * through the online-only API proxy with a clear offline guard.
 */

/** Queue-aware mutate (offline-safe, optimistic local update). */
function mutate(op: string, method: string, path: string, body?: any) {
  return window.electronAPI.billiard.mutate(op, method, path, body).catch(rethrowClean);
}

/** Online-only API call. REST itself is the availability probe. */
function onlineApi(method: string, path: string, body?: any) {
  return window.electronAPI.billiard.mutate('online_api', method, path, body).catch(rethrowClean);
}

export function useBilliardApi() {
  const billiardApi = useMemo(() => ({
    // Online-only: creating a floor plan returns server-generated ID
    createFloorPlan: (data: any) => onlineApi('POST', '/billiard/floor-plans', data),

    deleteFloorPlan: (id: string) => onlineApi('DELETE', `/billiard/floor-plans/${id}`),

    // Queue-aware: layout updates work offline with optimistic local cache
    updateFloorPlan: (id: string, data: any) =>
      mutate('update_floor_plan', 'PATCH', `/billiard/floor-plans/${id}`, data),
    upsertTableLayout: (resourceId: string, data: any) =>
      mutate('upsert_layout', 'PUT', `/billiard/table-layouts/${resourceId}`, data),
    batchUpdateLayouts: (layouts: any[]) =>
      mutate('batch_update_layouts', 'PUT', '/billiard/table-layouts/batch', { layouts }),
  }), []);

  const resourcesApi = useMemo(() => ({
    // Online-only: creating resources/types returns server-generated IDs
    listResourceTypes: () => onlineApi('GET', '/resources/types'),
    createResourceType: async (data: any) => {
      const response = await onlineApi('GET', '/resources/types');
      const types = Array.isArray(response) ? response : (response?.data || []);
      const existing = types.find(
        (type: any) => String(type?.code || '').toUpperCase() === String(data?.code || '').toUpperCase(),
      );
      if (existing) return existing;
      return onlineApi('POST', '/resources/types', data);
    },
    createResource: (data: any) => onlineApi('POST', '/resources', data),

    // Queue-aware: rename updates work offline
    updateResource: (id: string, data: any) =>
      mutate('update_resource', 'PUT', `/resources/${id}`, data),

    // Online-only: delete needs immediate server confirmation
    deleteResource: (id: string) => onlineApi('DELETE', `/resources/${id}`),
  }), []);

  const bookingsApi = useMemo(() => ({
    list: async (date: string) => normalizeBilliardBookings(
      await onlineApi('GET', buildBilliardBookingsPath(date)),
    ),
    availability: async (resourceId: string, date: string) => normalizeBilliardAvailability(
      await onlineApi('GET', buildBilliardAvailabilityPath(resourceId, date)),
    ),
    create: (data: any) => onlineApi('POST', '/billiard/bookings', data),
    cancel: (id: string) => onlineApi('POST', `/billiard/bookings/${id}/cancel`),
    checkIn: (id: string, data: { guestCount?: number } = {}) =>
      onlineApi('POST', `/billiard/bookings/${id}/check-in`, data),
  }), []);

  return { billiardApi, resourcesApi, bookingsApi };
}
