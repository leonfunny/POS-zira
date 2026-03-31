/**
 * Floor plan asset catalog — maps asset keys to R2 CDN URLs + metadata.
 * Used by DraggableTable (image rendering) and AssetPickerGrid (selection UI).
 */

const CDN = 'https://img.zira.pl/floor-plan';

export interface FloorPlanAssetDef {
  key: string;
  category: string;
  name: string;
  url: string;
  aspectRatio: number; // width / height
  defaultWidthPct: number;  // % of room width when first placed
  defaultHeightPct: number; // % of room height when first placed
}

export const FLOOR_PLAN_CATEGORIES = [
  { key: 'billiard', label: 'Billiard' },
  { key: 'nail', label: 'Nail Salon' },
  { key: 'beauty', label: 'Beauty' },
  { key: 'massage', label: 'Massage / Spa' },
  { key: 'restaurant', label: 'Restaurant' },
  { key: 'retail', label: 'Retail' },
  { key: 'kitchen', label: 'Kitchen' },
  { key: 'general', label: 'General' },
] as const;

export const FLOOR_PLAN_ASSETS: FloorPlanAssetDef[] = [
  // Billiard
  { key: 'pool-table-green', category: 'billiard', name: 'Pool Table (Green)', url: `${CDN}/pool-table-green.webp`, aspectRatio: 1.8, defaultWidthPct: 15.5, defaultHeightPct: 13.0 },
  { key: 'pool-table-blue', category: 'billiard', name: 'Pool Table (Blue)', url: `${CDN}/pool-table-blue.webp`, aspectRatio: 1.8, defaultWidthPct: 15.5, defaultHeightPct: 13.0 },
  { key: 'snooker-table', category: 'billiard', name: 'Snooker Table', url: `${CDN}/snooker-table.webp`, aspectRatio: 2.0, defaultWidthPct: 18.0, defaultHeightPct: 13.0 },

  // Nail
  { key: 'nail-station', category: 'nail', name: 'Nail Station', url: `${CDN}/nail-station.webp`, aspectRatio: 1.3, defaultWidthPct: 10.0, defaultHeightPct: 11.5 },
  { key: 'pedicure-chair', category: 'nail', name: 'Pedicure Chair', url: `${CDN}/pedicure-chair.webp`, aspectRatio: 0.7, defaultWidthPct: 7.0, defaultHeightPct: 15.0 },
  { key: 'nail-chair', category: 'nail', name: 'Nail Chair', url: `${CDN}/nail-chair.webp`, aspectRatio: 1.0, defaultWidthPct: 6.0, defaultHeightPct: 9.0 },

  // Beauty
  { key: 'salon-chair', category: 'beauty', name: 'Salon Chair', url: `${CDN}/salon-chair.webp`, aspectRatio: 1.0, defaultWidthPct: 6.0, defaultHeightPct: 9.0 },
  { key: 'wash-basin', category: 'beauty', name: 'Wash Basin', url: `${CDN}/wash-basin.webp`, aspectRatio: 0.6, defaultWidthPct: 5.0, defaultHeightPct: 12.5 },
  { key: 'styling-mirror', category: 'beauty', name: 'Styling Station', url: `${CDN}/styling-mirror.webp`, aspectRatio: 1.5, defaultWidthPct: 12.0, defaultHeightPct: 12.0 },

  // Massage
  { key: 'massage-bed', category: 'massage', name: 'Massage Bed', url: `${CDN}/massage-bed.webp`, aspectRatio: 2.2, defaultWidthPct: 14.0, defaultHeightPct: 9.5 },
  { key: 'spa-bed', category: 'massage', name: 'Spa Bed', url: `${CDN}/spa-bed.webp`, aspectRatio: 2.0, defaultWidthPct: 13.0, defaultHeightPct: 9.8 },
  { key: 'eyelash-bed', category: 'massage', name: 'Eyelash Bed', url: `${CDN}/eyelash-bed.webp`, aspectRatio: 2.0, defaultWidthPct: 13.0, defaultHeightPct: 9.8 },

  // Restaurant
  { key: 'dining-round', category: 'restaurant', name: 'Round Table', url: `${CDN}/dining-round.webp`, aspectRatio: 1.0, defaultWidthPct: 8.0, defaultHeightPct: 12.0 },
  { key: 'dining-square', category: 'restaurant', name: 'Square Table', url: `${CDN}/dining-square.webp`, aspectRatio: 1.0, defaultWidthPct: 8.0, defaultHeightPct: 12.0 },
  { key: 'dining-rect', category: 'restaurant', name: 'Rectangular Table', url: `${CDN}/dining-rect.webp`, aspectRatio: 1.8, defaultWidthPct: 15.0, defaultHeightPct: 12.5 },
  { key: 'bar-counter', category: 'restaurant', name: 'Bar Counter', url: `${CDN}/bar-counter.webp`, aspectRatio: 3.0, defaultWidthPct: 22.0, defaultHeightPct: 11.0 },

  // Retail
  { key: 'shelf-unit', category: 'retail', name: 'Shelf Unit', url: `${CDN}/shelf-unit.webp`, aspectRatio: 2.5, defaultWidthPct: 18.0, defaultHeightPct: 10.8 },
  { key: 'asian-food-shelf', category: 'retail', name: 'Asian Food Shelf', url: `${CDN}/asian-food-shelf.webp`, aspectRatio: 2.5, defaultWidthPct: 18.0, defaultHeightPct: 10.8 },
  { key: 'meat-shelf', category: 'retail', name: 'Meat/Freezer', url: `${CDN}/meat-shelf.webp`, aspectRatio: 2.0, defaultWidthPct: 15.0, defaultHeightPct: 11.3 },
  { key: 'cash-register', category: 'retail', name: 'Cash Register', url: `${CDN}/cash-register.webp`, aspectRatio: 1.2, defaultWidthPct: 9.0, defaultHeightPct: 11.3 },

  // Kitchen
  { key: 'kitchen-station', category: 'kitchen', name: 'Kitchen Station', url: `${CDN}/kitchen-station.webp`, aspectRatio: 1.5, defaultWidthPct: 12.0, defaultHeightPct: 12.0 },
  { key: 'prep-table', category: 'kitchen', name: 'Prep Table', url: `${CDN}/prep-table.webp`, aspectRatio: 1.8, defaultWidthPct: 14.0, defaultHeightPct: 11.7 },

  // General
  { key: 'reception-desk', category: 'general', name: 'Reception Desk', url: `${CDN}/reception-desk.webp`, aspectRatio: 1.6, defaultWidthPct: 12.5, defaultHeightPct: 11.7 },
  { key: 'waiting-sofa', category: 'general', name: 'Waiting Sofa', url: `${CDN}/waiting-sofa.webp`, aspectRatio: 2.5, defaultWidthPct: 18.0, defaultHeightPct: 10.8 },
  { key: 'single-bed', category: 'general', name: 'Single Bed', url: `${CDN}/single-bed.webp`, aspectRatio: 2.0, defaultWidthPct: 13.0, defaultHeightPct: 9.8 },
  { key: 'plant', category: 'general', name: 'Plant / Decoration', url: `${CDN}/plant.webp`, aspectRatio: 1.0, defaultWidthPct: 4.0, defaultHeightPct: 6.0 },
];

export const FLOOR_PLAN_ASSET_MAP = new Map(
  FLOOR_PLAN_ASSETS.map((a) => [a.key, a]),
);
