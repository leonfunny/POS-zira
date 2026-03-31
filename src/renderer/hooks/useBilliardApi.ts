import { useMemo } from 'react';

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
  return window.electronAPI.billiard.mutate(op, method, path, body);
}

/** Online-only API call. Throws clear error when offline. */
async function onlineApi(method: string, path: string, body?: any) {
  // Quick check — if sync status shows offline, fail fast
  try {
    const status = await window.electronAPI.billiard.getSyncStatus();
    if (!status.online) {
      throw new Error('This operation requires a network connection. Please reconnect and try again.');
    }
  } catch (err: any) {
    if (err.message?.includes('network connection')) throw err;
    // getSyncStatus failed — proceed anyway and let apiCall decide
  }
  return window.electronAPI.apiCall(method, path, body);
}

export function useBilliardApi() {
  const billiardApi = useMemo(() => ({
    // Online-only: creating a floor plan returns server-generated ID
    createFloorPlan: (data: any) => onlineApi('POST', '/billiard/floor-plans', data),

    // Queue-aware: layout updates work offline with optimistic local cache
    updateFloorPlan: (id: string, data: any) =>
      mutate('update_floor_plan', 'PATCH', `/billiard/floor-plans/${id}`, data),
    upsertTableLayout: (resourceId: string, data: any) =>
      mutate('upsert_layout', 'POST', '/billiard/layouts/upsert', { resourceId, ...data }),
    batchUpdateLayouts: (layouts: any[]) =>
      mutate('batch_update_layouts', 'POST', '/billiard/layouts/batch-update', { layouts }),
  }), []);

  const resourcesApi = useMemo(() => ({
    // Online-only: creating resources/types returns server-generated IDs
    listResourceTypes: () => onlineApi('GET', '/resources/types'),
    createResourceType: (data: any) => onlineApi('POST', '/resources/types', data),
    createResource: (data: any) => onlineApi('POST', '/resources', data),

    // Queue-aware: rename updates work offline
    updateResource: (id: string, data: any) =>
      mutate('update_resource', 'PUT', `/resources/${id}`, data),

    // Online-only: delete needs immediate server confirmation
    deleteResource: (id: string) => onlineApi('DELETE', `/resources/${id}`),
  }), []);

  return { billiardApi, resourcesApi };
}
