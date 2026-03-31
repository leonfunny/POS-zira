export type TableStatus = 'free' | 'occupied' | 'paused';

export interface FloorPosition {
  x: number; // percentage 0-100
  y: number;
  floor?: number;
  rotation?: number;  // 0, 90, 180, 270
  widthPct?: number;  // percentage of room width
  heightPct?: number; // percentage of room height
}

export interface BilliardFloorPlan {
  id: string;
  salonId: string;
  name: string;
  floorNumber: number;
  isDefault: boolean;
  isActive: boolean;
  backgroundImage: string | null;
  roomWidthM: number;
  roomHeightM: number;
  displayOrder: number;
  layouts?: BilliardTableLayout[];
}

export interface BilliardTableLayout {
  id: string;
  salonId: string;
  resourceId: string;
  floorPlanId: string | null;
  positionX: number;
  positionY: number;
  rotation: number;
  widthPct: number;
  heightPct: number;
  zoneName: string | null;
  zoneColor: string | null;
  floorPlan?: BilliardFloorPlan | null;
}

export interface Measurement {
  id: string;
  tableAId: string;
  tableBId: string;
}

export interface TableOverview {
  resource: {
    id: string;
    name: string;
    pricingRules?: { basePrice?: number; currency?: string };
    metadata?: Record<string, any>;
  };
  session: any;
  status: TableStatus;
  layout?: BilliardTableLayout | null;
}
