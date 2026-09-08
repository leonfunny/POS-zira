import { useEffect, useRef, type RefObject } from 'react';

const dialogs = new Map<HTMLElement, number>();
const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function topDialog(): HTMLElement | undefined {
  let top: HTMLElement | undefined;
  for (const [panel, layer] of dialogs) {
    if (!panel.isConnected) continue;
    if (!top || layer > dialogs.get(top)!
      || (layer === dialogs.get(top)!
        && (top.contains(panel) || !!(top.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING)))) {
      top = panel;
    }
  }
  return top;
}

/** Keyboard ownership and focus lifecycle for the shared dialog surfaces. */
export function useDialogInteraction(
  panelRef: RefObject<HTMLElement | null>,
  open: boolean,
  layer: number,
  onEscape: () => void,
) {
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  // Capture before React's commit-time autoFocus can move focus into the dialog.
  if (open && !wasOpen.current) {
    openerRef.current = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  wasOpen.current = open;

  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const opener = openerRef.current;
    dialogs.set(panel, layer);
    // Child effects register before parents. Wait until the entire tree is registered.
    queueMicrotask(() => {
      if (topDialog() === panel && !panel.contains(document.activeElement)) panel.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || topDialog() !== panel) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        escapeRef.current();
      } else if (event.key === 'Tab') {
        const targets = Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector))
          .filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0);
        const first = targets[0];
        const last = targets[targets.length - 1];
        const active = document.activeElement;
        if (!first || !panel.contains(active) || active === panel
          || (event.shiftKey ? active === first : active === last)) {
          event.preventDefault();
          (event.shiftKey ? last || panel : first || panel).focus();
        }
      }
    };
    // Run after input/combobox handlers, but before window-level POS shortcuts.
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      dialogs.delete(panel);
      document.removeEventListener('keydown', handleKeyDown);
      queueMicrotask(() => {
        const top = topDialog();
        // Do not steal focus from another open dialog, or restore to an unmounted opener.
        if (opener?.isConnected && !opener.matches(':disabled') && (!top || top.contains(opener))) {
          opener.focus();
        } else if (top && !top.contains(document.activeElement)) {
          top.focus();
        }
      });
    };
  }, [open, layer, panelRef]);

  return () => topDialog() === panelRef.current;
}
