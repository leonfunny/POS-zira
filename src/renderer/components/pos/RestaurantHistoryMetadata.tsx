import React from 'react';

type Tr = (key: string) => string;
export interface RestaurantHistoryOrder {
  mode?: string | null;
  table_id?: string | null;
  covers?: number | null;
  order_type?: string | null;
}

export interface RestaurantHistoryItem {
  notes?: string | null;
  course?: number | null;
  restaurant_line_id?: string | null;
}

const courseKeys: Record<number, string> = {
  1: 'pos.restaurant.starter',
  2: 'pos.restaurant.main',
  3: 'pos.restaurant.dessert',
  4: 'pos.restaurant.drinks',
};
const serviceKeys: Record<string, string> = {
  dine_in: 'pos.restaurant.dineIn',
  takeout: 'pos.restaurant.takeout',
  delivery: 'pos.restaurant.delivery',
};

export function RestaurantHistoryHeader({ order, t }: { order: RestaurantHistoryOrder; t: Tr }) {
  if (order.mode !== 'restaurant') return null;
  const serviceKey = order.order_type && Object.prototype.hasOwnProperty.call(serviceKeys, order.order_type)
    ? serviceKeys[order.order_type] : undefined;
  const tableId = order.order_type === 'dine_in' && typeof order.table_id === 'string'
    && order.table_id.trim() && order.table_id.length <= 128 ? order.table_id : null;
  const covers = typeof order.covers === 'number' && Number.isInteger(order.covers)
    && order.covers >= 0 && order.covers <= 10000 ? order.covers : null;
  if (!serviceKey && tableId === null && covers === null) return null;

  return (
    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700" data-testid="restaurant-history-header">
      {serviceKey && <span className="font-bold">{t(serviceKey)}</span>}
      {tableId && <span className="min-w-0 break-words [overflow-wrap:anywhere]">{t('pos.restaurant.tables')} · ID: {tableId}</span>}
      {covers !== null && <span>{t('pos.restaurant.covers')}: {covers}</span>}
    </div>
  );
}

export function RestaurantHistoryLine({ mode, item, t, requireVerifiedLink = false }: {
  mode?: string | null;
  item: RestaurantHistoryItem;
  t: Tr;
  requireVerifiedLink?: boolean;
}) {
  if (mode !== 'restaurant') return null;
  if (requireVerifiedLink && (typeof item.restaurant_line_id !== 'string'
    || !item.restaurant_line_id.trim() || item.restaurant_line_id.length > 128)) return null;
  const course = typeof item.course === 'number' && Number.isInteger(item.course)
    && item.course >= 1 && item.course <= 99 ? item.course : null;
  const notes = typeof item.notes === 'string' && item.notes.trim() && item.notes.length <= 4000 ? item.notes : null;
  if (course === null && !notes) return null;

  return (
    <div className="mt-1 space-y-1 text-xs font-medium text-slate-600" data-testid="restaurant-history-line">
      {course !== null && <div>{t('pos.restaurant.course')}: {courseKeys[course] ? t(courseKeys[course]) : course}</div>}
      {notes && <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{notes}</div>}
    </div>
  );
}
