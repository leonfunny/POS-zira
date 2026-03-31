import { X } from 'lucide-react';
import type { Measurement, FloorPosition } from './types';
import { calculateDistanceM } from './utils';

export function MeasurementOverlay({
  measurements,
  positions,
  pendingTableId,
  roomWidthM,
  roomHeightM,
  editMode,
  onDelete,
}: {
  measurements: Measurement[];
  positions: Record<string, FloorPosition>;
  pendingTableId: string | null;
  roomWidthM: number;
  roomHeightM: number;
  editMode?: boolean;
  onDelete?: (measurementId: string) => void;
}) {
  return (
    <>
      {/* SVG layer -- no viewBox so user units = px, positions via %, sizes via px */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{ zIndex: 10 }}
      >
        {measurements.map((m) => {
          const a = positions[m.tableAId];
          const b = positions[m.tableBId];
          if (!a || !b) return null;
          return (
            <g key={m.id}>
              <line
                x1={`${a.x}%`} y1={`${a.y}%`}
                x2={`${b.x}%`} y2={`${b.y}%`}
                stroke="#ef4444" strokeWidth="2"
                strokeDasharray="6 3" strokeLinecap="round"
              />
              <circle cx={`${a.x}%`} cy={`${a.y}%`} r="4" fill="#ef4444" />
              <circle cx={`${b.x}%`} cy={`${b.y}%`} r="4" fill="#ef4444" />
            </g>
          );
        })}

        {/* Pending selection pulse */}
        {pendingTableId && positions[pendingTableId] && (
          <circle
            cx={`${positions[pendingTableId].x}%`}
            cy={`${positions[pendingTableId].y}%`}
            r="12"
            fill="none"
            stroke="#ef4444"
            strokeWidth="2"
          >
            <animate attributeName="r" values="10;20;10" dur="1.2s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.8;0.2;0.8" dur="1.2s" repeatCount="indefinite" />
          </circle>
        )}
      </svg>

      {/* HTML labels at midpoints */}
      {measurements.map((m) => {
        const a = positions[m.tableAId];
        const b = positions[m.tableBId];
        if (!a || !b) return null;
        const dist = calculateDistanceM(a, b, roomWidthM, roomHeightM);
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        return (
          <div
            key={m.id}
            className="absolute"
            style={{
              left: `${midX}%`,
              top: `${midY}%`,
              transform: 'translate(-50%, -50%)',
              zIndex: 11,
            }}
          >
            <span className="bg-red-500 text-white text-xs font-bold rounded-full px-2 py-0.5 shadow-sm whitespace-nowrap">
              {dist.toFixed(1)}m
            </span>
            {editMode && onDelete && (
              <button
                type="button"
                className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-600 hover:bg-red-700 text-white"
                onClick={(e) => { e.stopPropagation(); onDelete(m.id); }}
                aria-label="Delete measurement"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}
