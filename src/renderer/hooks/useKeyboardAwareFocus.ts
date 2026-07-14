import { useCallback, useEffect, useRef, type FocusEventHandler, type RefObject } from 'react';

const FOCUS_SETTLE_DELAY_MS = 350;

export function useKeyboardAwareFocus(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): FocusEventHandler<HTMLElement> {
  const frameRef = useRef(0);
  const settleTimerRef = useRef<number | null>(null);
  const scrollFocusedFieldIntoView = useCallback(() => {
    if (!enabled) return;
    const container = containerRef.current;
    const activeElement = document.activeElement as HTMLElement | null;
    if (!container || !activeElement || !container.contains(activeElement)) return;
    const field = activeElement.closest('label') || activeElement;
    field.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  }, [containerRef, enabled]);

  const scheduleFocusedFieldIntoView = useCallback(() => {
    if (!enabled) return;
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = window.requestAnimationFrame(scrollFocusedFieldIntoView);
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(
      scrollFocusedFieldIntoView,
      FOCUS_SETTLE_DELAY_MS,
    );
  }, [enabled, scrollFocusedFieldIntoView]);

  useEffect(() => {
    if (!enabled) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;

    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleFocusedFieldIntoView);
    observer?.observe(container);
    window.addEventListener('resize', scheduleFocusedFieldIntoView);
    window.visualViewport?.addEventListener('resize', scheduleFocusedFieldIntoView);

    return () => {
      window.cancelAnimationFrame(frameRef.current);
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
      observer?.disconnect();
      window.removeEventListener('resize', scheduleFocusedFieldIntoView);
      window.visualViewport?.removeEventListener('resize', scheduleFocusedFieldIntoView);
    };
  }, [containerRef, enabled, scheduleFocusedFieldIntoView]);

  return useCallback(scheduleFocusedFieldIntoView, [scheduleFocusedFieldIntoView]);
}
