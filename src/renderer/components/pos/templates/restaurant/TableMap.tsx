import React from 'react';

interface TableState {
  id: string;
  name: string;
  zone: string | null;
  capacity: number;
  status: string;
  covers: number;
}

interface TableMapProps {
  tables: TableState[];
  activeTableId: string | null;
  onSelectTable: (id: string) => void;
  t: (key: string) => string;
}

const STATUS_COLORS: Record<string, string> = {
  free: 'bg-green-600/20 border-green-500/40 text-green-400 hover:bg-green-600/30',
  occupied: 'bg-amber-600/20 border-amber-500/40 text-amber-400 hover:bg-amber-600/30',
  reserved: 'bg-brand-600/20 border-brand-500/40 text-brand-400 hover:bg-brand-600/30',
  bill: 'bg-red-600/20 border-red-500/40 text-red-400 hover:bg-red-600/30',
};

export default function TableMap({ tables, activeTableId, onSelectTable, t }: TableMapProps) {
  // Group by zone
  const zones = new Map<string, TableState[]>();
  for (const table of tables) {
    const zone = table.zone || t('pos.otherZone');
    if (!zones.has(zone)) zones.set(zone, []);
    zones.get(zone)!.push(table);
  }

  return (
    <div className="flex-1 overflow-y-auto p-2 space-y-3">
      {Array.from(zones.entries()).map(([zone, zoneTables]) => (
        <div key={zone}>
          <h3 className="text-xs font-medium text-slate-500 mb-1 px-1">{zone}</h3>
          <div className="grid grid-cols-2 gap-1.5">
            {zoneTables.map((table) => {
              const isActive = table.id === activeTableId;
              const colorClass = STATUS_COLORS[table.status] || STATUS_COLORS.free;
              return (
                <button
                  key={table.id}
                  onClick={() => onSelectTable(table.id)}
                  className={`
                    p-2 rounded border text-center transition-all text-xs
                    ${colorClass}
                    ${isActive ? 'ring-2 ring-purple-500 ring-offset-1 ring-offset-slate-900' : ''}
                  `}
                >
                  <div className="font-semibold">{table.name}</div>
                  <div className="text-[10px] opacity-70">
                    {table.status === 'free' ? t('pos.restaurant.free') : `${table.covers}/${table.capacity}`}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
