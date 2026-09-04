/**
 * The revision a product-admin write must carry.
 *
 * The server refuses a write whose `expectedUpdatedAt` is not the row's
 * current revision, so nobody overwrites an edit they have not seen. That
 * revision is the newer of the row's own and its template's, so a write that
 * touches the template — a category move, a style rename — moves the revision
 * of every sibling row too, and a row read from the local mirror a moment ago
 * is already behind. Asked of the server right before the write, then; the
 * mirror's copy only when the server cannot be asked.
 */
export async function latestRevision(
  variantId: string,
  mirrored?: string | null,
): Promise<string | undefined> {
  const bridge = (window as any).electronAPI?.pos?.productAdmin;
  try {
    const detail = await Promise.resolve().then(() => bridge?.getVariant?.(variantId));
    const variant = detail?.ok ? detail.data?.variant : null;
    const fresh = variant?.canonicalUpdatedAt || variant?.updatedAt;
    if (typeof fresh === 'string' && fresh.trim()) return fresh.trim();
  } catch {
    // Offline, or a server without the detail route: the mirror's revision
    // is the best there is, and the server will still refuse it if stale.
  }
  const fallback = typeof mirrored === 'string' ? mirrored.trim() : '';
  return fallback || undefined;
}
