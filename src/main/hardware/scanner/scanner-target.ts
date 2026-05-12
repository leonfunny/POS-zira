export interface ScannerTargetWindow {
  id: number;
  isFocused: () => boolean;
  isDestroyed: () => boolean;
}

export interface ScannerTargetWindowCandidate<TWindow extends ScannerTargetWindow = ScannerTargetWindow> {
  label: string;
  window: TWindow;
}

export function chooseScannerTargetWindow<TWindow extends ScannerTargetWindow>(
  candidates: ScannerTargetWindowCandidate<TWindow>[],
  focusedWindowId: number | null | undefined,
): ScannerTargetWindowCandidate<TWindow> | null {
  const alive = candidates.filter((entry) => !entry.window.isDestroyed());

  return alive.find((entry) => entry.window.id === focusedWindowId)
    || alive.find((entry) => entry.window.isFocused())
    || alive.find((entry) => entry.label === 'main')
    || null;
}
