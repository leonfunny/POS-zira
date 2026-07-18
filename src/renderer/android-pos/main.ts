/**
 * Android POS web entry — installs the shim with the REAL transport (S6+S7)
 * and mounts the boot component (LoginScreen ↔ the real Windows POSApp).
 *
 * Packets S2 + S5 + S6+S7 of the Android parity port — see
 * docs/android-pos/PARITY_PORT_PLAN_2026-07-18.md (§5) and
 * docs/android-pos/SHIM_CONTRACT_S1.md.
 *
 * Ordering note: ES imports are hoisted, so POSApp's module graph loads before
 * the statements below run — that is safe because the renderer touches
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
import { ShimConfigStore } from './shim/config-store';
import { TokenStore } from './shim/token-store';
import { createRealTransport } from './shim/real-transport';
import AndroidBootApp from './AndroidBootApp';

const configStore = new ShimConfigStore();
const tokenStore = new TokenStore();
const transport = createRealTransport({ configStore, tokenStore });

// Install the electronAPI surface BEFORE the renderer mounts. This is the
// single allowed module-load side effect of the entry — the boundary verifier
// permits it because the shim installer is in this graph.
installShim({ transport, configStore });

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(
    React.createElement(React.StrictMode, null, React.createElement(AndroidBootApp)),
  );
}
