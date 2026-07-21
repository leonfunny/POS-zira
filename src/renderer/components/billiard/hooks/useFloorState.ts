import { useState, useMemo } from 'react';
import type { TableOverview, BilliardFloorPlan } from '../types';
import { DEFAULT_FLOOR } from '../constants';

/** Get floor number for a table — prefer layout.floorPlan, fallback to JSONB metadata */
function getFloorNumber(t: TableOverview): number {
  if (t.layout?.floorPlan?.floorNumber != null) return t.layout.floorPlan.floorNumber;
  const f = t.resource.metadata?.floorPlan?.floor;
  return typeof f === 'number' ? f : DEFAULT_FLOOR;
}

/** Get floor plan ID for a table */
function getFloorPlanId(t: TableOverview): string | null {
  return t.layout?.floorPlanId || null;
}

export function useFloorState(tables: TableOverview[], floorPlans?: BilliardFloorPlan[]) {
  const [activeFloorId, setActiveFloorId] = useState<string | null>(null);
  const [activeFloorNum, setActiveFloorNum] = useState(DEFAULT_FLOOR);

  // Build floor list: prefer floor plans from API, fallback to extracting from table data
  const floors = useMemo(() => {
    if (floorPlans && floorPlans.length > 0) {
      return floorPlans
        .filter((fp) => fp.isActive)
        .sort((a, b) => {
          if (a.isDefault && !b.isDefault) return -1;
          if (!a.isDefault && b.isDefault) return 1;
          return a.floorNumber - b.floorNumber;
        });
    }
    // Fallback: extract unique floor numbers from table metadata
    const floorSet = new Set<number>();
    for (const t of tables) {
      floorSet.add(getFloorNumber(t));
    }
    if (floorSet.size === 0) floorSet.add(DEFAULT_FLOOR);
    return Array.from(floorSet)
      .sort((a, b) => a - b)
      .map((num) => ({
        id: `legacy-${num}`,
        name: `Floor ${num}`,
        floorNumber: num,
        isDefault: num === DEFAULT_FLOOR,
        isActive: true,
        backgroundImage: null,
        roomWidthM: 16,
        roomHeightM: 10,
      } as BilliardFloorPlan));
  }, [floorPlans, tables]);

  // Resolve active floor
  const activeFloor = useMemo(() => {
    if (activeFloorId) {
      const found = floors.find((f) => f.id === activeFloorId);
      if (found) return found;
    }
    // Fallback by number
    const byNum = floors.find((f) => f.floorNumber === activeFloorNum);
    if (byNum) return byNum;
    // Default floor
    return floors.find((f) => f.isDefault) || floors[0] || null;
  }, [floors, activeFloorId, activeFloorNum]);

  const setActiveFloor = (floorPlanOrNum: BilliardFloorPlan | number) => {
    if (typeof floorPlanOrNum === 'number') {
      setActiveFloorNum(floorPlanOrNum);
      setActiveFloorId(null);
    } else {
      setActiveFloorId(floorPlanOrNum.id);
      setActiveFloorNum(floorPlanOrNum.floorNumber);
    }
  };

  const filteredTables = useMemo(() => {
    if (!activeFloor) return tables;
    return tables.filter((t) => {
      const fpId = getFloorPlanId(t);
      if (fpId && !fpId.startsWith('legacy-')) {
        return fpId === activeFloor.id;
      }
      return getFloorNumber(t) === activeFloor.floorNumber;
    });
  }, [tables, activeFloor]);

  const tableCounts = useMemo(() => {
    const counts: Record<string, { total: number; occupied: number; paused: number }> = {};
    for (const floor of floors) {
      counts[floor.id] = { total: 0, occupied: 0, paused: 0 };
    }
    for (const t of tables) {
      const fpId = getFloorPlanId(t);
      let floorId: string | undefined;
      if (fpId) {
        floorId = floors.find((f) => f.id === fpId)?.id;
      }
      if (!floorId) {
        const num = getFloorNumber(t);
        floorId = floors.find((f) => f.floorNumber === num)?.id;
      }
      if (!floorId) floorId = floors[0]?.id;
      if (floorId && counts[floorId]) {
        counts[floorId].total++;
        if (t.status === 'occupied') counts[floorId].occupied++;
        if (t.status === 'paused') counts[floorId].paused++;
      }
    }
    return counts;
  }, [tables, floors]);

  return {
    activeFloor,
    setActiveFloor,
    floors,
    filteredTables,
    tableCounts,
    hasMultipleFloors: floors.length > 1,
  };
}
