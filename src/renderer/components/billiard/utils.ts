import { resolveBilliardOutstandingBalance } from '../../../shared/billiard-contract';
import type { FloorPosition } from './types';


export function formatElapsed(startedAt: string, totalPausedSeconds: number, isPaused: boolean, pausedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const now = Date.now();
  let paused = totalPausedSeconds * 1000;
  if (isPaused && pausedAt) paused += now - new Date(pausedAt).getTime();
  const elapsed = Math.max(0, now - start - paused);
  const h = Math.floor(elapsed / 3600000);
  const m = Math.floor((elapsed % 3600000) / 60000);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

export function formatRemaining(autoEndAt: string): { text: string; totalMinutes: number } {
  const end = new Date(autoEndAt).getTime();
  const remaining = Math.max(0, end - Date.now());
  const totalMinutes = Math.ceil(remaining / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const text = h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
  return { text, totalMinutes };
}

export function calculateItemsTotal(items: Array<{ unitPrice: number; quantity: number }> | undefined | null): number {
  if (!items?.length) return 0;
  return items.reduce((sum, item) => sum + Number(item.unitPrice) * Number(item.quantity), 0);
}

export function estimateCharge(session: any): number {
  if (!session?.startedAt) return 0;

  // Package countdown: return fixed package price
  if (session.billingMode === 'PACKAGE_COUNTDOWN') {
    return Number(session.packagePrice ?? session.pricingSnapshot?.packagePrice ?? 0);
  }

  const start = new Date(session.startedAt).getTime();
  let paused = (session.totalPausedSeconds || 0) * 1000;
  // The server banks the pause interval into totalPausedSeconds only on
  // resume/end, so a PAUSED session must count its in-progress pause here or
  // the money keeps ticking while the elapsed clock stands still.
  if (String(session.status ?? '').toUpperCase() === 'PAUSED' && session.pausedAt) {
    paused += Math.max(0, Date.now() - new Date(session.pausedAt).getTime());
  }
  const elapsed = Math.max(0, Date.now() - start - paused);
  const hours = elapsed / 3600000;
  const hourlyRate = session.pricingSnapshot?.basePrice || session.hourlyRate || 0;
  if (session.billingMode === 'PER_HOUR_ROUNDED') {
    return Math.ceil(hours) * hourlyRate;
  }
  return +(hours * hourlyRate).toFixed(2);
}

/**
 * The time charge shown for a session in drawers/dialogs. The local cache
 * hydrates timeCharge to 0 while a session runs (the server only computes it
 * at end), so an authoritative value is trusted only once the session has
 * ended; live sessions always use the ticking, pause-aware estimate.
 */
export function resolveLiveTimeCharge(session: any): number {
  const status = String(session?.status ?? '').toUpperCase();
  const live = status === 'ACTIVE' || status === 'PAUSED';
  if (!live) {
    const authoritative = Number(session?.currentTimeCharge ?? session?.timeCharge);
    if (Number.isFinite(authoritative)) return authoritative;
  }
  return estimateCharge(session);
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(value);
}

export interface UnsettledSummary {
  count: number;
  totalOutstanding: number;
}

export function summarizeUnsettled(sessions: any[] | null | undefined): UnsettledSummary {
  if (!Array.isArray(sessions) || sessions.length === 0) return { count: 0, totalOutstanding: 0 };
  const total = sessions.reduce((sum, s) => sum + resolveBilliardOutstandingBalance(s), 0);
  return { count: sessions.length, totalOutstanding: Math.round(total * 100) / 100 };
}

export function sortUnsettledNewestFirst<T extends { endedAt?: string | null; startedAt?: string | null }>(
  sessions: T[],
): T[] {
  const ts = (s: T): number => new Date(s.endedAt || s.startedAt || 0).getTime();
  return [...sessions].sort((a, b) => ts(b) - ts(a));
}

/**
 * The seed for a new object's default name. One stray differently-named object
 * added last (e.g. "Ghế massage #1" among 14 "Bàn #n") must not hijack every
 * future default, so the LARGEST numbered family wins; ties go to the family
 * of the most recently added name (the old seed-from-last behavior).
 */
function dominantNumberedName(names: string[]): string | null {
  const families = new Map<string, { count: number; maxNum: number }>();
  let lastPrefix: string | null = null;
  for (const name of names) {
    const match = name.match(/^(.*?)(\d+)\s*$/);
    if (!match) continue;
    const prefix = match[1];
    const num = parseInt(match[2], 10);
    const family = families.get(prefix) ?? { count: 0, maxNum: 0 };
    family.count += 1;
    family.maxNum = Math.max(family.maxNum, num);
    families.set(prefix, family);
    lastPrefix = prefix;
  }
  let best: string | null = null;
  for (const [prefix, family] of families) {
    if (best === null) { best = prefix; continue; }
    const current = families.get(best)!;
    if (family.count > current.count || (family.count === current.count && prefix === lastPrefix)) {
      best = prefix;
    }
  }
  return best === null ? null : `${best}${families.get(best)!.maxNum}`;
}

/**
 * Default name for a freshly picked floor asset. Billiard assets continue the
 * venue's dominant table family; any other asset type names within its own
 * family (seeded from the asset's display name) so a massage bed never
 * becomes the next "Bàn #n".
 */
export function defaultNameForAsset(
  asset: { category: string; name: string } | undefined | null,
  existingNames: string[],
): string {
  if (!asset || asset.category === 'billiard') return getNextName('', existingNames);
  const base = asset.name.trim();
  const family = existingNames.filter((n) => n.toLowerCase().startsWith(base.toLowerCase()));
  return family.length > 0 ? getNextName('', family) : `${base} 1`;
}

export function getNextName(currentValue: string, existingNames: string[], direction: 'up' | 'down' = 'up'): string {
  const val = currentValue.trim();
  const source = val || dominantNumberedName(existingNames) || existingNames[existingNames.length - 1] || '';
  const match = source.match(/^(.*?)(\d+)\s*$/);
  if (match) {
    const prefix = match[1];
    const num = parseInt(match[2], 10);
    if (direction === 'down') {
      if (num <= 1) return `${prefix}1`;
      return `${prefix}${num - 1}`;
    }
    let next = num + 1;
    let guard = 0;
    while (existingNames.some((n) => n.toLowerCase() === `${prefix}${next}`.trim().toLowerCase()) && guard < 100) {
      next++;
      guard++;
    }
    return `${prefix}${next}`;
  }
  if (val) return direction === 'up' ? `${val} 2` : val;
  return 'Table 1';
}

// Default table dimensions (percentage of room) — keep in sync with constants.ts
const _DEF_W = 15.5;
const _DEF_H = 13.0;

/**
 * Edge-to-edge distance (meters) between two tables.
 * Traces a ray from center→center and subtracts each table's
 * half-extent along that ray so the result is gap between edges.
 */
export function calculateDistanceM(
  posA: FloorPosition, posB: FloorPosition,
  roomWidthM: number, roomHeightM: number,
): number {
  const dxM = ((posB.x - posA.x) / 100) * roomWidthM;
  const dyM = ((posB.y - posA.y) / 100) * roomHeightM;
  const centerDist = Math.sqrt(dxM * dxM + dyM * dyM);
  if (centerDist < 0.001) return 0;

  // Unit direction vector
  const ux = dxM / centerDist;
  const uy = dyM / centerDist;

  // Half-extents in meters (account for rotation swapping w/h)
  const halfExtent = (pos: FloorPosition): number => {
    const rot = pos.rotation || 0;
    const rotated = rot === 90 || rot === 270;
    const wPct = pos.widthPct || _DEF_W;
    const hPct = pos.heightPct || _DEF_H;
    // After rotation the visual bounding box swaps
    const effW = rotated ? hPct : wPct;
    const effH = rotated ? wPct : hPct;
    const hwM = (effW / 100) * roomWidthM / 2;
    const hhM = (effH / 100) * roomHeightM / 2;
    // Distance from center to edge along direction (ux, uy)
    const tx = Math.abs(ux) > 1e-9 ? hwM / Math.abs(ux) : Infinity;
    const ty = Math.abs(uy) > 1e-9 ? hhM / Math.abs(uy) : Infinity;
    return Math.min(tx, ty);
  };

  const gap = centerDist - halfExtent(posA) - halfExtent(posB);
  return Math.max(0, gap);
}

export function snapToGrid(value: number, stepPct: number): number {
  if (stepPct <= 0) return value;
  return Math.round(value / stepPct) * stepPct;
}
