// Self-checkout state machine. Each screen owns its own component;
// this hook owns the transitions so reset paths (idle timeout, abandon,
// payment success) all go through one place. Payment selection is an overlay
// owned by the shopping screen, not a separate route.
import { useCallback, useState } from 'react';

export type ScScreen =
  | 'unavailable'
  | 'welcome'
  | 'shopping'
  | 'receipt'
  | 'thankyou';

export interface ScreenStateApi {
  screen: ScScreen;
  goTo: (screen: ScScreen) => void;
  reset: () => void;
}

export function useScreenState(initial: ScScreen = 'welcome'): ScreenStateApi {
  const [screen, setScreen] = useState<ScScreen>(initial);
  const goTo = useCallback((next: ScScreen) => setScreen(next), []);
  const reset = useCallback(() => setScreen(initial), [initial]);
  return { screen, goTo, reset };
}
