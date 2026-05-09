// Full-screen overlay shown after the customer hits "Wezwij obsługę"
// and a help-request was created on the backend. The terminal is
// frozen until staff resolves the request (kiosk polls or receives
// a socket event with the resolved status).
import React from 'react';
import { ScLanguage, getScStrings } from '../i18n';

interface HelpLockedOverlayProps {
  lang: ScLanguage;
  acknowledged: boolean;
  reason: string;
  onCancel: () => void;
}

export default function HelpLockedOverlay({
  lang,
  acknowledged,
  reason,
  onCancel,
}: HelpLockedOverlayProps) {
  const t = getScStrings(lang);
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-amber-50 select-none">
      <div className="mb-6 text-9xl">{acknowledged ? '🚶' : '🆘'}</div>
      <h1 className="mb-3 text-5xl font-extrabold text-amber-900 text-center px-4">
        {acknowledged ? 'Obsługa idzie' : 'Wezwano obsługę'}
      </h1>
      <p className="mb-2 text-2xl text-amber-700">{reason}</p>
      <p className="mb-12 text-lg text-amber-600">
        {acknowledged
          ? 'Pracownik jest w drodze do kasy.'
          : 'Czekamy na pracownika…'}
      </p>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-xl border-2 border-amber-300 bg-white px-6 py-3 text-base font-semibold text-amber-800 hover:bg-amber-100"
      >
        {t.cancel}
      </button>
    </div>
  );
}
