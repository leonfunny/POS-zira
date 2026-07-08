import { useCallback, useEffect, type FocusEventHandler, type RefObject } from 'react';

export function useKeyboardAwareFocus(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): FocusEventHandler<HTMLElement> {
  const scrollFocusedFieldIntoView = useCallback(() => {
    if (!enabled) return;
    const container = containerRef.current;
    const activeElement = document.activeElement as HTMLElement | null;
    if (!container || !activeElement || !container.contains(activeElement)) return;
    const field = activeElement.closest('label') || activeElement;
    field.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  }, [containerRef, enabled]);

  useEffect(() => {
    if (!enabled || typeof ResizeObserver === 'undefined') return undefined;
    const container = containerRef.current;
    if (!container) return undefined;

    let frame = 0;
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(scrollFocusedFieldIntoView);
    });
    observer.observe(container);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [containerRef, enabled, scrollFocusedFieldIntoView]);

  return useCallback(() => {
    if (!enabled) return;
    window.requestAnimationFrame(scrollFocusedFieldIntoView);
  }, [enabled, scrollFocusedFieldIntoView]);
}
