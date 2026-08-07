/**
 * PARITY GUARD 1/2 — the Windows preload surface vs the Android shim surface.
 *
 * Why this exists: the Windows renderer is shared byte-for-byte with Android
 * (vite.android.config.ts mounts src/renderer/windows/pos/POSApp), but the
 * layer BELOW `window.electronAPI` is implemented twice — Electron main for
 * Windows, the hand-written shim for Android. Every capability Windows adds is
 * therefore a silent Android regression until someone ports it, and nothing
 * used to fail when nobody did. That is exactly how the billiard POS-handoff
 * gap shipped: the shared PaymentDialog moved to a handoff-only settle flow and
 * the tablet quietly lost its ability to close a table.
 *
 * How it works: both surfaces are captured AT RUNTIME (no regex over source) —
 * the Windows one by importing the real preload with `electron` mocked so
 * `contextBridge.exposeInMainWorld` hands us the object, the Android one by
 * calling `installShim()`. Every function path present on Windows must either
 * exist on Android or be registered below WITH A REASON.
 *
 * The registry is deliberately two-way (the lesson from
 * scripts/verify-production-readiness.mjs REQUIRED_REGISTER_IDS): a stale
 * waiver fails too, so an entry cannot outlive the gap it documents.
 *
 * LIMIT — read before trusting a green run: this checks NAMES, not behaviour.
 * `pos.billiardCheckout` exists on both sides today, yet all 8 Android methods
 * return `'desktop-only'` (shim/index.ts:103-112). Name parity is necessary,
 * not sufficient; behavioural parity for the money path is pinned by the
 * per-feature tests (and by guard 2/2, android-shell-props-parity.test.tsx).
 */
import { describe, expect, test, vi } from 'vitest';

const captured = vi.hoisted(() => ({ api: null as any }));

// The real preload runs `contextBridge.exposeInMainWorld('electronAPI', {...})`
// at import time (preload.ts:103) — mocking electron turns that into a capture.
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, value: any) => { captured.api = value; },
  },
  ipcRenderer: {
    invoke: async () => undefined,
    on: () => undefined,
    off: () => undefined,
    send: () => undefined,
    removeListener: () => undefined,
    removeAllListeners: () => undefined,
  },
}));

// ── Registry ────────────────────────────────────────────────────────────────

const HARDWARE = 'Windows-only hardware surface: serial/USB drivers, printer ports, device scans. The tablet drives none of it directly — fiscal/receipt printing goes through the remote print-agent.';
const DESKTOP_SHELL = 'Desktop shell capability (OS windows, folders, auto-start, updater, dev tools). No Android equivalent.';
const BACK_OFFICE = 'Back-office module never mounted on the tablet POS shell. Porting it is a product decision, not a parity bug.';
const DESKTOP_INTEGRATION = 'Desktop-host integration that needs a long-lived process on the salon LAN.';

/**
 * Whole top-level namespaces the Android shim intentionally does not carry.
 * Adding a METHOD inside one of these stays silent; adding a whole NEW
 * namespace on Windows fails this test until someone decides.
 */
const NOT_PORTED_NAMESPACES: Record<string, string> = {
  // Hardware / drivers
  autoSetupPrinter: HARDWARE,
  calibratePrinter: HARDWARE,
  display: HARDWARE,
  getPosnetDriverStatus: HARDWARE,
  installPosnetDriver: HARDWARE,
  listPorts: HARDWARE,
  onDeviceStatus: HARDWARE,
  onPrintJob: HARDWARE,
  onTestPrintProgress: HARDWARE,
  posnetDiagnosePort: HARDWARE,
  posnetListDevices: HARDWARE,
  posnetRescanKnown: HARDWARE,
  posnetScanDevices: HARDWARE,
  posnetSelectDevice: HARDWARE,
  printAgentPrinters: HARDWARE,
  printFiscalDailyReportNow: HARDWARE,
  scanForDriver: HARDWARE,
  testPrinterByConfig: HARDWARE,
  universalListDevices: HARDWARE,
  universalRecoverDevice: HARDWARE,
  universalRescanKnown: HARDWARE,
  universalScanDevices: HARDWARE,
  validatePrinterPort: HARDWARE,

  // Desktop shell
  backup: DESKTOP_SHELL,
  chrome: DESKTOP_SHELL,
  debug: DESKTOP_SHELL,
  getAutoStart: DESKTOP_SHELL,
  openLogFolder: DESKTOP_SHELL,
  selectFolder: DESKTOP_SHELL,
  setAutoStart: DESKTOP_SHELL,
  shell: DESKTOP_SHELL,
  update: DESKTOP_SHELL,

  // Desktop-host integrations
  booksy: DESKTOP_INTEGRATION,
  lanFirstKitchen: DESKTOP_INTEGRATION,
  remote: DESKTOP_INTEGRATION,
  sshTunnel: DESKTOP_INTEGRATION,
  telegram: DESKTOP_INTEGRATION,
  tvAdGetStatus: DESKTOP_INTEGRATION,
  tvAdPickVideo: DESKTOP_INTEGRATION,
  tvAdSave: DESKTOP_INTEGRATION,

  // Back-office modules
  ai: BACK_OFFICE,
  bookings: BACK_OFFICE,
  checkin: BACK_OFFICE,
  forecast: BACK_OFFICE,
  invoice: BACK_OFFICE,
  salonCustomer: BACK_OFFICE,
  security: BACK_OFFICE,
  servicePopularity: BACK_OFFICE,
  services: BACK_OFFICE,
  warehouse: 'Owner stock/product admin is served on Android by the narrower productAdmin surface (shim/product-admin.ts), not by this desktop namespace.',

  // Pairing / credential entry points that belong to the desktop pairing flow
  changeSalon: DESKTOP_SHELL,
  connectWithApiKey: 'Android pairs through the post-login agent-connect flow (shim/agent-connect.ts), not a manual key-entry screen.',
  deleteConfirm: DESKTOP_SHELL,
  getRemotePin: DESKTOP_SHELL,
  setRemotePin: DESKTOP_SHELL,
  setAiApiKey: DESKTOP_SHELL,
};

/**
 * Individual gaps INSIDE a namespace Android does implement. These are the
 * dangerous ones — the renderer mounts that namespace, so a missing method is
 * a live hole rather than a hidden module.
 */
const KNOWN_PATH_GAPS: Record<string, string> = {
  'pos.loyalty.lookupCustomer': 'Loyalty lookup is not wired on the tablet yet; the rest of pos.loyalty is stubbed identically on both platforms. Port together with the loyalty wave.',
  'pos.onReceiptPrintStatus': 'Windows streams the local receipt-print-outbox lifecycle (QUEUED/DISPATCHING/PRINTED) for jobs it spools itself. Android never spools locally — remote-print.ts owns the whole create-and-poll cycle against the print-agent and returns a terminal outcome to the caller, so there is no outbox to observe. Port only if Android ever gains a local spooler.',
  'pos.listReceiptPrintStatuses': 'Reads the same Windows-only receipt-print-outbox table as pos.onReceiptPrintStatus. Android has no local outbox to list; the print outcome is the return value of the remote-print call. Port only if Android ever gains a local spooler.',
};

// ── Surface capture ─────────────────────────────────────────────────────────

/** Dotted paths of every function on an exposed API object. */
function functionPaths(obj: any, prefix = '', out: string[] = [], depth = 0): string[] {
  if (!obj || typeof obj !== 'object' || depth > 4) return out;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'function') out.push(path);
    else if (value && typeof value === 'object') functionPaths(value, path, out, depth + 1);
  }
  return out;
}

async function captureSurfaces() {
  await import('../src/preload/preload');
  const { installShim, __resetShimForTest } = await import('../src/renderer/android-pos/shim/index');
  __resetShimForTest();
  const { api } = installShim();
  return {
    windows: functionPaths(captured.api).sort(),
    android: new Set(functionPaths(api)),
  };
}

describe('Windows preload ↔ Android shim surface parity', () => {
  test('every Windows capability is either implemented on Android or registered with a reason', async () => {
    const { windows, android } = await captureSurfaces();
    expect(windows.length).toBeGreaterThan(300); // capture actually worked

    const unregistered = windows.filter((path) => {
      if (android.has(path)) return false;
      if (KNOWN_PATH_GAPS[path]) return false;
      return !NOT_PORTED_NAMESPACES[path.split('.')[0]];
    });

    // A failure here means Windows grew a capability the tablet silently lost.
    // Port it into the shim, or register it above with the reason it is
    // desktop-only. Do not delete this test to make a build green.
    expect(unregistered, `Unregistered Windows-only capabilities:\n  ${unregistered.join('\n  ')}`).toEqual([]);
  });

  test('the registry has no stale entries (a waiver cannot outlive its gap)', async () => {
    const { windows, android } = await captureSurfaces();
    const windowsSet = new Set(windows);
    const windowsTopLevel = new Set(windows.map((p) => p.split('.')[0]));

    const staleNamespaces = Object.keys(NOT_PORTED_NAMESPACES).filter(
      (ns) => !windowsTopLevel.has(ns) || windows.filter((p) => p.split('.')[0] === ns).every((p) => android.has(p)),
    );
    expect(staleNamespaces, `Namespaces no longer needing a waiver — delete them:\n  ${staleNamespaces.join('\n  ')}`).toEqual([]);

    const stalePaths = Object.keys(KNOWN_PATH_GAPS).filter((p) => !windowsSet.has(p) || android.has(p));
    expect(stalePaths, `Path gaps that are now closed — delete them:\n  ${stalePaths.join('\n  ')}`).toEqual([]);
  });

  test('the money-path namespaces are present on both sides', async () => {
    const { windows, android } = await captureSurfaces();
    // These are the surfaces a cashier touches to move money. They must never
    // fall into the "whole namespace not ported" bucket by accident.
    const MONEY_PATHS = [
      'pos.getState', 'pos.dispatch',
      'pos.orders.create', 'pos.orders.refund', 'pos.orders.retrySync',
      'pos.payment.printReceipt', 'pos.payment.printFiscalReceipt',
      'pos.shift.open', 'pos.shift.close', 'pos.shift.getActive',
      'pos.billiardCheckout.preflight', 'pos.billiardCheckout.prepare',
      'pos.billiardCheckout.beginTender', 'pos.billiardCheckout.complete',
      'billiard.mutate', 'billiard.getFloorOverview', 'billiard.getFnbProducts',
    ];
    for (const path of MONEY_PATHS) {
      expect(windows, `${path} vanished from the Windows preload`).toContain(path);
      expect(android.has(path), `${path} is missing from the Android shim`).toBe(true);
    }
  });
});
