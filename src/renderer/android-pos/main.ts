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
 * Note: the renderer's Tailwind stylesheet (src/renderer/index.css) is NOT
 * imported here because the cross-platform boundary verifier flags non-TS
 * asset imports; S2's contract is "the real renderer boots behind the shim at
 * the bundle level". Tailwind injection is a follow-up (extend the verifier to
 * allow static asset imports in the shim graph, or link the compiled CSS from
 * index.html) — see the packet report.
 */

import { installShim } from './shim';
import React from 'react';
import { createRoot } from 'react-dom/client';
import POSApp from '../windows/pos/POSApp';

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
