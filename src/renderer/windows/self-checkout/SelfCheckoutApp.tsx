// Self-checkout terminal entry point. The kiosk runs full-screen on a
// shop counter. State machine in `useScreenState` drives which screen
// renders. Language is persisted via the Print Agent config so the
// last cashier-set choice survives terminal restarts.
import React, { useCallback, useEffect, useState } from 'react';
import { ScLanguage } from './i18n';
import { useScreenState } from './screen-state';
import WelcomeScreen from './screens/WelcomeScreen';

export default function SelfCheckoutApp() {
  const { screen, goTo, reset } = useScreenState('welcome');
  const [lang, setLang] = useState<ScLanguage>('pl');

  // Load persisted language preference on boot.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const config = await window.electronAPI.getConfig();
        if (cancelled) return;
        const saved = (config?.selfCheckoutLanguage as ScLanguage | undefined) || 'pl';
        if (saved === 'pl' || saved === 'en' || saved === 'vi') {
          setLang(saved);
        }
      } catch {
        /* ignore — defaults to Polish */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLangChange = useCallback(async (next: ScLanguage) => {
    setLang(next);
    try {
      await window.electronAPI.saveConfig({ selfCheckoutLanguage: next });
    } catch {
      /* persistence is best-effort */
    }
  }, []);

  const handleStart = useCallback(() => {
    goTo('scan');
  }, [goTo]);

  if (screen === 'welcome') {
    return (
      <WelcomeScreen lang={lang} onLangChange={handleLangChange} onStart={handleStart} />
    );
  }

  // Other screens land in follow-up commits. Until then, any non-welcome
  // state immediately resets so the terminal stays usable.
  return (
    <div
      className="flex h-screen w-screen items-center justify-center bg-slate-100 text-slate-700"
      onClick={reset}
    >
      <div className="text-center text-2xl">
        Screen <code className="font-mono text-emerald-700">{screen}</code> not
        implemented yet — tap anywhere to return to welcome.
      </div>
    </div>
  );
}
