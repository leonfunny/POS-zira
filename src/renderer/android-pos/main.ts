/**
 * Android POS web entry — installs the shim with the REAL transport (S6+S7)
 * and mounts AndroidBootApp (LoginScreen plus the shared POSLayout cashier).
 *
 * Packets S2 + S5 + S6+S7 of the Android parity port — see
 * docs/android-pos/PARITY_PORT_PLAN_2026-07-18.md (§5) and
 * docs/android-pos/SHIM_CONTRACT_S1.md.
 *
 * Ordering note: ES imports are hoisted, so AndroidBootApp's module graph loads
 * before the statements below run — that is safe because the renderer touches
 * `window.electronAPI` only at render time (useConfig/usePosStore), and
 * `installShim()` runs before the first render.
 *
 * Styling (S5): the SAME Tailwind stylesheet the Windows POS window imports
 * (src/renderer/index.css; Windows entry uses `../../index.css`, this entry is
 * one level shallower → `../index.css`).
 *
 * Wiring (S6+S7): the ONE ShimConfigStore instance is shared between the shim
 * surface and the real transport — login writes identity into the same store
 * the renderer reads (see InstallShimOptions.configStore).
 */

import '../index.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { installShim } from './shim';
import { ensureStableMachineId, ShimConfigStore, resolvePosMode } from './shim/config-store';
import { TokenStore } from './shim/token-store';
import { createRealTransport } from './shim/real-transport';
import { initStorageDurability } from './shim/storage-durability';
import { installBackGuard, nativeExitApp } from './shim/back-guard';
import AndroidBootApp from './AndroidBootApp';

const configStore = new ShimConfigStore();
// Must exist before createRealTransport(): the REST registration and Socket.IO
// handshake both use it to address this exact physical terminal.
ensureStableMachineId(configStore);
const tokenStore = new TokenStore();
const transport = createRealTransport({ configStore, tokenStore });

// Install the electronAPI surface BEFORE the renderer mounts. This is the
// single allowed module-load side effect of the entry — the boundary verifier
// permits it because the shim installer is in this graph.
const shim = installShim({ transport, configStore });

// Ask Android to stop treating our IndexedDB as disposable BEFORE the first
// write. Everything the money path depends on lives in that one blob — the
// handoff journal, the protected held carts, paid-but-unsynced orders — and
// `allowBackup="false"` means there is no second copy. The answer is cached in
// the module; AndroidBootApp reads it to warn the cashier when it was refused.
void initStorageDurability();

// Own the back button: MainActivity fires `ziraBackPressed` and never finishes
// on its own, so an accidental press can no longer end the app mid-sale without
// a word. The cart itself is already snapshotted, so this is about not
// surprising the cashier — not about losing the money.
installBackGuard(window, {
  getCartItemCount: () => shim.posStore.getState().cart.items.length,
  confirm: (message) => window.confirm(message),
  exitApp: nativeExitApp,
});

// E2a (salon mode): materialize the resolved POS mode into config so the
// unmodified Windows POSLayout (`posMode === 'salon'` → SalonTemplate,
// POSLayout.tsx:1642) renders the right template. `resolvePosMode` defaults a
// fresh/invalid Android config to 'salon' (the shared layout's fallback) and
// leaves an explicit 'retail' config untouched — so a salon boots salon, a
// retail-configured device stays retail. No-op when config already holds a
// supported mode.
const resolvedPosMode = resolvePosMode(configStore.getRawConfig());
if (configStore.getRawConfig().posMode !== resolvedPosMode) {
  configStore.setConfig({ posMode: resolvedPosMode });
}

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(
    React.createElement(React.StrictMode, null, React.createElement(AndroidBootApp)),
  );
}
