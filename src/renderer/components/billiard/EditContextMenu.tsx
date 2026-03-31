import { useEffect, useRef } from 'react';
import type { Language } from '../../i18n/translations';
import type { TableOverview, FloorPosition } from './types';
import { DEFAULT_TABLE_WIDTH_PCT, DEFAULT_TABLE_HEIGHT_PCT } from './constants';
import { MenuHeader } from './menu/MenuHeader';
import { MenuActionItems } from './menu/MenuActionItems';
import { MenuResizeControls } from './menu/MenuResizeControls';

interface EditContextMenuProps {
  table: TableOverview;
  position: FloorPosition;
  menuPosition: { x: number; y: number };
  roomWidthM: number;
  roomHeightM: number;
  hasImage: boolean;
  onClose: () => void;
  onStartRename: () => void;
  onRotate: (id: string, rotation: number) => void;
  onResize: (id: string, wPct: number, hPct: number) => void;
  onChangeImage: (id: string) => void;
  onMeasureStart: (id: string) => void;
  onDelete: (id: string) => void;
  language: Language;
}

export function EditContextMenu({
  table,
  position,
  menuPosition,
  roomWidthM,
  roomHeightM,
  hasImage,
  onClose,
  onStartRename,
  onRotate,
  onResize,
  onChangeImage,
  onMeasureStart,
  onDelete,
  language,
}: EditContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Clamp position to viewport
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = menuPosition.x;
    let y = menuPosition.y;
    if (x + rect.width > vw - 8) x = vw - rect.width - 8;
    if (y + rect.height > vh - 8) y = vh - rect.height - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [menuPosition]);

  const wPct = position.widthPct || DEFAULT_TABLE_WIDTH_PCT;
  const hPct = position.heightPct || DEFAULT_TABLE_HEIGHT_PCT;
  const rotation = position.rotation || 0;
  const widthM = +(wPct / 100 * roomWidthM).toFixed(1);
  const heightM = +(hPct / 100 * roomHeightM).toFixed(1);
  const hourlyRate = table.resource.pricingRules?.basePrice;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[60]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />

      {/* Menu popup */}
      <div
        ref={menuRef}
        className="fixed z-[61] w-52 bg-white border border-gray-200 rounded-lg shadow-xl overflow-hidden"
        style={{ left: menuPosition.x, top: menuPosition.y }}
      >
        <MenuHeader
          name={table.resource.name}
          widthM={widthM}
          heightM={heightM}
          hourlyRate={hourlyRate}
          hasImage={hasImage}
        />

        <MenuActionItems
          tableId={table.resource.id}
          rotation={rotation}
          onRename={onStartRename}
          onRotate={onRotate}
          onChangeImage={onChangeImage}
          onMeasureStart={onMeasureStart}
          onDelete={onDelete}
          onClose={onClose}
          language={language}
        />

        {!hasImage && (
          <MenuResizeControls
            tableId={table.resource.id}
            widthPct={wPct}
            heightPct={hPct}
            roomWidthM={roomWidthM}
            roomHeightM={roomHeightM}
            onResize={onResize}
            language={language}
          />
        )}
      </div>
    </>
  );
}
