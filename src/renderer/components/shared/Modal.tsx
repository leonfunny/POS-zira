import React, { useCallback, useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

export type ModalSize = 'sm' | 'md' | 'lg' | 'full';
export type ModalZLayer = 'base' | 'nested';

const sizeClasses: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  full: 'max-w-[calc(100vw-2rem)] sm:max-w-5xl',
};

const zLayerClasses: Record<ModalZLayer, string> = {
  base: 'z-50',
  nested: 'z-[60]',
};

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function modalClassNames(size: ModalSize = 'md', zLayer: ModalZLayer = 'base') {
  return {
    overlay: `fixed inset-0 ${zLayerClasses[zLayer]} flex items-center justify-center bg-slate-950/50 px-3 py-4`,
    panel: `flex max-h-[calc(100vh-2rem)] w-full ${sizeClasses[size]} flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl outline-none`,
    body: 'min-h-0 overflow-y-auto',
    footer: 'border-t border-slate-200 px-5 py-4',
  };
}

interface ModalProps {
  open?: boolean;
  title: React.ReactNode;
  children: React.ReactNode;
  onClose: () => void;
  size?: ModalSize;
  zLayer?: ModalZLayer;
  busy?: boolean;
  guardUnsaved?: boolean;
  onGuardedClose?: () => void;
  closeLabel?: string;
  showCloseButton?: boolean;
  titleIcon?: React.ReactNode;
  footer?: React.ReactNode;
  bodyClassName?: string;
  panelClassName?: string;
  footerClassName?: string;
}

export default function Modal({
  open = true,
  title,
  children,
  onClose,
  size = 'md',
  zLayer = 'base',
  busy = false,
  guardUnsaved = false,
  onGuardedClose,
  closeLabel = 'Close',
  showCloseButton = true,
  titleIcon,
  footer,
  bodyClassName = '',
  panelClassName = '',
  footerClassName,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const classes = modalClassNames(size, zLayer);

  const closeNow = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  const focusBoundary = useCallback((position: 'first' | 'last') => {
    const panel = panelRef.current;
    if (!panel) return;

    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector))
      .filter((element) => element.offsetParent !== null && element.tabIndex >= 0);
    const target = position === 'first' ? focusable[0] : focusable[focusable.length - 1];
    (target || panel).focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel || panel.contains(document.activeElement)) return;
    panel.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return;
      event.preventDefault();
      onClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [busy, onClose, open]);

  if (!open) return null;

  const handleBackdropClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || busy) return;
    if (guardUnsaved) {
      onGuardedClose?.();
      return;
    }
    onClose();
  };

  return (
    <div className={classes.overlay} onClick={handleBackdropClick}>
      <div tabIndex={0} onFocus={() => focusBoundary('last')} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`${classes.panel} ${panelClassName}`.trim()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            {titleIcon}
            <h2 id={titleId} className="truncate text-lg font-semibold text-slate-950">
              {title}
            </h2>
          </div>
          {showCloseButton && (
            <button
              type="button"
              onClick={closeNow}
              disabled={busy}
              aria-label={closeLabel}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          )}
        </div>
        <div className={`${classes.body} ${bodyClassName}`.trim()}>{children}</div>
        {footer && <div className={footerClassName || classes.footer}>{footer}</div>}
      </div>
      <div tabIndex={0} onFocus={() => focusBoundary('first')} />
    </div>
  );
}
