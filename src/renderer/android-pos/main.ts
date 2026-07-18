/**
 * Android POS web entry — mounts the REAL Windows POS renderer (POSApp) behind
 * the typed `window.electronAPI` shim.
 *
 * Packet S2 of the Android parity port — see
 * docs/android-pos/PARITY_PORT_PLAN_2026-07-18.md (§5, S2). The shim MUST be
 * installed before POSApp is imported: the renderer reads `window.electronAPI`
 * during its first render (useConfig / usePosStore). POSApp itself is the
 * unmodified Windows entry — never edit it from this packet.
 *
 * S5: the renderer is now STYLED. The SAME Tailwind stylesheet the Windows POS
 * window entry imports (`src/renderer/windows/pos/main.tsx` imports
 * `../../index.css`) is imported here — the relative path resolves to the same
 * `src/renderer/index.css`. The cross-platform boundary verifier was extended
 * (S5 GOAL A) to permit static asset imports (`.css`, vite `?url`) in a
 * shim-bearing graph; this import is the consumer of that allowance.
 */

import { installShim } from './shim';
import React from 'react';
import { createRoot } from 'react-dom/client';
import POSApp from '../windows/pos/POSApp';
// The SAME stylesheet the Windows POS window mounts (src/renderer/index.css).
// Windows's entry is at src/renderer/windows/pos/main.tsx and imports
// `../../index.css`; this entry is one level shallower
// (src/renderer/android-pos/main.ts), so the relative path to the same file is
// `../index.css`. Importing it styles the mounted renderer (Tailwind utilities).
import '../index.css';

// Install the electronAPI surface (synthetic fakes, no transport) BEFORE the
// renderer mounts. This is the single allowed module-load side effect of the
// entry — the boundary verifier permits it because the shim installer is in
// this graph (it is the contract that makes the real renderer safe to run).
installShim();

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(
    React.createElement(React.StrictMode, null, React.createElement(POSApp)),
  );
}
