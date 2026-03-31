import { useRef, useCallback, useState } from 'react';
import { SNAP_STEP_M } from '../constants';
import { snapToGrid } from '../utils';

const ACTIVATION_DISTANCE = 5; // px — must move 5px before drag starts (prevents accidental drag on click)

interface UseFreeformDragOptions {
  id: string;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  posX: number; // current position 0-100%
  posY: number;
  roomWidthM: number;
  roomHeightM: number;
  enabled: boolean;
  onDrag: (id: string, x: number, y: number) => void;
  onDragEnd: (id: string, x: number, y: number) => void;
}

export function useFreeformDrag({
  id,
  canvasRef,
  posX,
  posY,
  roomWidthM,
  roomHeightM,
  enabled,
  onDrag,
  onDragEnd,
}: UseFreeformDragOptions) {
  const [isDragging, setIsDragging] = useState(false);

  // Refs to avoid stale closures in pointer move/up handlers
  const dragState = useRef({
    active: false,
    activated: false, // true once activation distance is exceeded
    pointerId: -1,
    startClientX: 0,
    startClientY: 0,
    startPosX: 0,
    startPosY: 0,
    lastX: 0,
    lastY: 0,
    canvasRect: null as DOMRect | null, // cached on pointerdown to avoid repeated getBoundingClientRect
  });

  const snap = useCallback(
    (rawPct: number, axis: 'x' | 'y') => {
      const stepPct =
        axis === 'x'
          ? (SNAP_STEP_M / roomWidthM) * 100
          : (SNAP_STEP_M / roomHeightM) * 100;
      return Math.max(2, Math.min(98, snapToGrid(rawPct, stepPct)));
    },
    [roomWidthM, roomHeightM],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return;
      // Only primary button (left click / single touch)
      if (e.button !== 0) return;

      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);

      // Cache canvas rect once — it won't change during drag (TransformWrapper disabled in editMode)
      const canvas = canvasRef.current;

      dragState.current = {
        active: true,
        activated: false,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPosX: posX,
        startPosY: posY,
        lastX: posX,
        lastY: posY,
        canvasRect: canvas ? canvas.getBoundingClientRect() : null,
      };
    },
    [enabled, posX, posY],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const ds = dragState.current;
      if (!ds.active || !ds.canvasRect) return;

      const rect = ds.canvasRect;

      const dx = e.clientX - ds.startClientX;
      const dy = e.clientY - ds.startClientY;

      // Activation threshold — don't start drag until moved 5px
      if (!ds.activated) {
        if (Math.abs(dx) < ACTIVATION_DISTANCE && Math.abs(dy) < ACTIVATION_DISTANCE) return;
        ds.activated = true;
        setIsDragging(true);
      }

      const dxPct = (dx / rect.width) * 100;
      const dyPct = (dy / rect.height) * 100;
      const newX = snap(ds.startPosX + dxPct, 'x');
      const newY = snap(ds.startPosY + dyPct, 'y');

      // Only call onDrag if position actually changed (avoids unnecessary renders)
      if (newX !== ds.lastX || newY !== ds.lastY) {
        ds.lastX = newX;
        ds.lastY = newY;
        onDrag(id, newX, newY);
      }
    },
    [snap, onDrag, id],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const ds = dragState.current;
      if (!ds.active) return;

      const el = e.currentTarget as HTMLElement;
      try {
        el.releasePointerCapture(ds.pointerId);
      } catch {
        // pointer capture may already be released
      }

      const wasDragging = ds.activated;
      ds.active = false;
      ds.activated = false;
      setIsDragging(false);

      if (wasDragging) {
        onDragEnd(id, ds.lastX, ds.lastY);
      }
    },
    [id, onDragEnd],
  );

  // Clean up if browser cancels the pointer (system dialog, touch interrupted, etc.)
  const handlePointerCancel = useCallback(
    (e: React.PointerEvent) => {
      const ds = dragState.current;
      if (!ds.active) return;

      const el = e.currentTarget as HTMLElement;
      try {
        el.releasePointerCapture(ds.pointerId);
      } catch {
        // already released
      }

      ds.active = false;
      ds.activated = false;
      setIsDragging(false);
      // Don't call onDragEnd — position wasn't finalized
    },
    [],
  );

  return {
    isDragging,
    dragHandlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerCancel,
    },
  };
}
