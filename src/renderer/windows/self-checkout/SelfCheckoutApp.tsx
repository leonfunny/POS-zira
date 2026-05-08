// Self-checkout terminal entry point. The kiosk runs full-screen on a
// shop counter. The customer drives every interaction: scan products,
// pay by BLIK or card, take the receipt. Staff intervene only via the
// "Wezwij obsługę" flow (handled by `WezwijOverlay`, not yet built).
//
// Screens (state machine driven by `useScreenState`):
//   welcome  -> tap to start
//   scan     -> active cart, scanning, +/- qty
//   nip      -> optional 10-digit NIP entry before payment
//   bag      -> ask if customer needs a bag (Polish bag-fee law)
//   payment  -> BLIK / Card chooser + numpad / terminal callback
//   thankyou -> auto-return to welcome after 8s
//
// This first scaffold renders a placeholder WelcomeScreen so the
// window opens cleanly and the build / packaging chain is exercised.
// Real screens land in follow-up commits.
import React from 'react';

export default function SelfCheckoutApp() {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-gradient-to-br from-emerald-50 via-white to-amber-50 text-slate-900">
      <div className="text-center">
        <h1 className="text-6xl font-black tracking-tight mb-6">
          Witamy w sklepie
        </h1>
        <p className="text-2xl text-slate-600 mb-12">
          Self-checkout terminal — scaffold ready
        </p>
        <button
          type="button"
          className="px-12 py-6 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white text-3xl font-bold shadow-lg transition-colors"
        >
          Rozpocznij zakupy
        </button>
      </div>
      <p className="absolute bottom-6 text-xs text-slate-400">
        Płatność tylko kartą lub BLIK
      </p>
    </div>
  );
}
