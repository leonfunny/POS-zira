/**
 * ReservationPanel — Manage table reservations.
 *
 * Full-screen panel with add/edit form and a list grouped by date.
 * Overlap validation before save. Rose/pink color scheme.
 * Supports guest typeahead (local guest book) and recurring weekly reservations.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  CalendarClock, X, RefreshCw, Plus, Trash2, Save, ChevronDown, ChevronRight, Edit2,
  Phone, User, Repeat, Search,
} from 'lucide-react';
import type { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';

/* ─── Types ──────────────────────────────────────────── */

interface Reservation {
  id: string;
  resource_id: string;
  date: string;
  start_time: string;
  end_time: string;
  customer_name: string;
  customer_phone: string;
  notes: string;
  status: 'active' | 'cancelled' | 'completed' | 'no_show';
  created_at: string;
  updated_at: string;
  guest_id?: string | null;
  parent_id?: string | null;
  is_recurring?: number;
  recur_day?: number | null;
  recur_until?: string | null;
}

interface GuestResult {
  id: string;
  name: string;
  phone: string;
  notes: string;
  visit_count: number;
  last_seen: string | null;
}

interface TableInfo {
  id: string;
  name: string;
}

/* ─── Component ────────────────────────────────────────── */

interface ReservationPanelProps {
  language: Language;
  onClose?: () => void;
}

export function ReservationPanel({ language, onClose }: ReservationPanelProps) {
  const { t } = useTranslation(language);

  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [editId, setEditId] = useState<string | null>(null);
  const [formTable, setFormTable] = useState('');
  const [formDate, setFormDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [formStart, setFormStart] = useState('18:00');
  const [formEnd, setFormEnd] = useState('20:00');
  const [formName, setFormName] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [overlapError, setOverlapError] = useState<string | null>(null);

  // Guest typeahead state
  const [guestResults, setGuestResults] = useState<GuestResult[]>([]);
  const [selectedGuestId, setSelectedGuestId] = useState<string | null>(null);
  const [showGuestDropdown, setShowGuestDropdown] = useState(false);
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Recurring state
  const [formRecurring, setFormRecurring] = useState(false);
  const [formRecurUntil, setFormRecurUntil] = useState('');

  // Collapsed date groups
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const fetchReservations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.reservation?.getUpcoming?.();
      if (result?.success && result.data) {
        setReservations(result.data);
      } else {
        setError(result?.error || 'Failed to load');
      }
    } catch (e: any) {
      setError(e.message || 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchTables = useCallback(async () => {
    try {
      const result = await window.electronAPI?.billiard?.getFloorOverview?.();
      if (result?.success && result.data) {
        setTables(
          result.data.map((t: any) => ({ id: t.resource?.id, name: t.resource?.name }))
            .filter((t: TableInfo) => t.id && t.name)
            .sort((a: TableInfo, b: TableInfo) => a.name.localeCompare(b.name, undefined, { numeric: true })),
        );
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchReservations();
    fetchTables();
  }, [fetchReservations, fetchTables]);

  // Close guest dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        phoneInputRef.current && !phoneInputRef.current.contains(e.target as Node)
      ) {
        setShowGuestDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const resetForm = () => {
    setEditId(null);
    setFormTable('');
    setFormDate(new Date().toISOString().slice(0, 10));
    setFormStart('18:00');
    setFormEnd('20:00');
    setFormName('');
    setFormPhone('');
    setFormNotes('');
    setOverlapError(null);
    setGuestResults([]);
    setSelectedGuestId(null);
    setShowGuestDropdown(false);
    setFormRecurring(false);
    setFormRecurUntil('');
  };

  const openEdit = (r: Reservation) => {
    setEditId(r.id);
    setFormTable(r.resource_id);
    setFormDate(r.date);
    setFormStart(r.start_time);
    setFormEnd(r.end_time);
    setFormName(r.customer_name);
    setFormPhone(r.customer_phone);
    setFormNotes(r.notes);
    setOverlapError(null);
    setSelectedGuestId(r.guest_id || null);
    setGuestResults([]);
    setShowGuestDropdown(false);
    setFormRecurring(!!r.is_recurring);
    setFormRecurUntil(r.recur_until || '');
    setShowForm(true);
  };

  /* ─── Guest search ──────────────────────────────────── */

  const searchGuests = useCallback(async (query: string) => {
    if (query.length < 3) {
      setGuestResults([]);
      setShowGuestDropdown(false);
      return;
    }
    try {
      const result = await window.electronAPI?.billiardGuest?.search?.(query);
      if (result?.success && result.data) {
        setGuestResults(result.data);
        setShowGuestDropdown(result.data.length > 0);
      }
    } catch { /* ignore */ }
  }, []);

  const handlePhoneChange = (value: string) => {
    setFormPhone(value);
    setSelectedGuestId(null);
    setOverlapError(null);
    // Debounce guest search
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => searchGuests(value.trim()), 300);
  };

  const selectGuest = (guest: GuestResult) => {
    setFormName(guest.name);
    setFormPhone(guest.phone);
    if (guest.notes) setFormNotes(guest.notes);
    setSelectedGuestId(guest.id);
    setShowGuestDropdown(false);
    setGuestResults([]);
  };

  /* ─── Recurring helpers ─────────────────────────────── */

  const defaultRecurUntil = (fromDate: string): string => {
    const d = new Date(fromDate + 'T00:00:00');
    d.setDate(d.getDate() + 56); // 8 weeks
    return d.toISOString().slice(0, 10);
  };

  const getDayOfWeek = (dateStr: string): number => {
    return new Date(dateStr + 'T00:00:00').getDay(); // 0=Sun, 6=Sat
  };

  /* ─── Save ──────────────────────────────────────────── */

  const checkOverlap = (existing: Reservation[], start: string, end: string, excludeId?: string): boolean => {
    return existing.some((r) => {
      if (excludeId && r.id === excludeId) return false;
      return r.start_time < end && r.end_time > start;
    });
  };

  const handleSave = async () => {
    if (!formTable || !formDate || !formStart || !formEnd) return;
    if (formStart >= formEnd) {
      setOverlapError(t('reservation.invalidTimeRange') || 'End time must be after start time');
      return;
    }

    // Check overlap
    const sameTableDate = reservations.filter(
      (r) => r.resource_id === formTable && r.date === formDate && r.status === 'active',
    );
    if (checkOverlap(sameTableDate, formStart, formEnd, editId || undefined)) {
      setOverlapError(t('reservation.overlap') || 'This time slot overlaps with an existing reservation');
      return;
    }

    try {
      // Auto-create or bump guest
      let guestId = selectedGuestId;
      if (formPhone.trim() || formName.trim()) {
        if (!guestId) {
          // Create new guest
          const newGuestId = `guest_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          await window.electronAPI?.billiardGuest?.upsert?.({
            id: newGuestId,
            name: formName.trim(),
            phone: formPhone.trim(),
            notes: '',
          });
          guestId = newGuestId;
        } else {
          // Bump existing guest visit count
          // The bumpVisit is called server-side via search or can be done on save
          await window.electronAPI?.billiardGuest?.upsert?.({
            id: guestId,
            name: formName.trim(),
            phone: formPhone.trim(),
            notes: '',
          });
        }
      }

      const id = editId || `rsv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const isRecurring = formRecurring && !editId; // Only set recurring for new reservations
      const recurDay = isRecurring ? getDayOfWeek(formDate) : undefined;
      const recurUntil = isRecurring ? (formRecurUntil || defaultRecurUntil(formDate)) : undefined;

      await window.electronAPI?.reservation?.upsert?.({
        id,
        resourceId: formTable,
        date: formDate,
        startTime: formStart,
        endTime: formEnd,
        customerName: formName.trim(),
        customerPhone: formPhone.trim(),
        notes: formNotes.trim(),
        guestId: guestId || undefined,
        isRecurring: isRecurring,
        recurDay,
        recurUntil,
      });

      // Generate recurring instances
      if (isRecurring) {
        await window.electronAPI?.reservation?.generate?.(id);
      }

      setShowForm(false);
      resetForm();
      fetchReservations();
    } catch { /* ignore */ }
  };

  /* ─── Cancel / Delete ────────────────────────────────── */

  const handleCancel = async (id: string) => {
    try {
      await window.electronAPI?.reservation?.upsert?.({
        id,
        resourceId: '',
        date: '',
        startTime: '',
        endTime: '',
        status: 'cancelled',
      });
      fetchReservations();
    } catch { /* ignore */ }
  };

  const handleDelete = async (id: string) => {
    await window.electronAPI?.reservation?.delete?.(id).catch(() => {});
    fetchReservations();
  };

  const handleDeleteSeries = async (r: Reservation) => {
    // Delete the template + all future instances
    const parentId = r.parent_id || r.id;
    try {
      // Delete all future children
      await window.electronAPI?.reservation?.delete?.(parentId).catch(() => {});
      // The deleteFutureByParentId logic is in the repo —
      // but from UI we do: delete template (which cascades via repo),
      // or manually delete children. For simplicity, delete the template row:
      // The backend repo's delete handles parent cleanup.
      // Also remove child instances by fetching and deleting
      const siblings = reservations.filter(
        (s) => s.parent_id === parentId && s.date >= today && s.id !== parentId,
      );
      for (const s of siblings) {
        await window.electronAPI?.reservation?.delete?.(s.id).catch(() => {});
      }
      fetchReservations();
    } catch { /* ignore */ }
  };

  /* ─── Helpers ────────────────────────────────────────── */

  const tableName = (resourceId: string): string => {
    return tables.find((t) => t.id === resourceId)?.name || resourceId.slice(0, 8);
  };

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Group by date
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const grouped = reservations.reduce<Record<string, Reservation[]>>((acc, r) => {
    (acc[r.date] ||= []).push(r);
    return acc;
  }, {});

  const sortedDates = Object.keys(grouped).sort();

  const dateLabel = (date: string): string => {
    if (date === today) return t('reservation.today') || 'Today';
    if (date === tomorrow) return t('reservation.tomorrow') || 'Tomorrow';
    try {
      const d = new Date(date + 'T00:00:00');
      return d.toLocaleDateString(language === 'en' ? 'en-US' : language, {
        weekday: 'short', day: 'numeric', month: 'short',
      });
    } catch {
      return date;
    }
  };

  /** Count how many instances a recurring template has */
  const seriesCount = (templateId: string): number => {
    return reservations.filter((r) => r.parent_id === templateId && r.status === 'active').length;
  };

  const isRecurringTemplate = (r: Reservation): boolean => !!r.is_recurring;
  const isRecurringInstance = (r: Reservation): boolean => !!r.parent_id;

  return (
    <div className="h-full flex flex-col bg-slate-50">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-white border-b border-slate-200 shadow-sm">
        <div className="flex items-center gap-3">
          <CalendarClock className="w-5 h-5 text-rose-600" />
          <h1 className="text-lg font-bold text-slate-900">
            {t('reservation.title') || 'Reservations'}
          </h1>
          <span className="text-xs text-slate-400">
            ({reservations.length} {t('reservation.upcoming') || 'upcoming'})
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { if (showForm) { setShowForm(false); resetForm(); } else { resetForm(); setShowForm(true); } }}
            className="p-2 rounded-lg hover:bg-rose-50 text-rose-600 transition-colors"
            title={t('reservation.addReservation') || 'Add reservation'}
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            onClick={fetchReservations}
            disabled={loading}
            className="p-2 rounded-lg hover:bg-slate-100 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 text-slate-600 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {onClose && (
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-100 transition-colors">
              <X className="w-5 h-5 text-slate-600" />
            </button>
          )}
        </div>
      </div>

      {/* Add/Edit form */}
      {showForm && (
        <div className="px-4 py-3 bg-rose-50 border-b border-rose-100 space-y-3">
          <p className="text-xs font-semibold text-rose-700">
            {editId
              ? (t('reservation.editReservation') || 'Edit Reservation')
              : (t('reservation.addReservation') || 'New Reservation')}
          </p>

          {/* Table + Date */}
          <div className="flex items-end gap-2 flex-wrap">
            <div className="w-40">
              <label className="text-[10px] text-slate-500 block mb-0.5">{t('reservation.table') || 'Table'}</label>
              <select
                value={formTable}
                onChange={(e) => { setFormTable(e.target.value); setOverlapError(null); }}
                className="w-full px-2 py-1.5 text-sm rounded-md border border-slate-300 bg-white"
              >
                <option value="">{t('reservation.selectTable') || '-- Select --'}</option>
                {tables.map((tbl) => (
                  <option key={tbl.id} value={tbl.id}>{tbl.name}</option>
                ))}
              </select>
            </div>
            <div className="w-36">
              <label className="text-[10px] text-slate-500 block mb-0.5">{t('reservation.date') || 'Date'}</label>
              <input
                type="date"
                value={formDate}
                onChange={(e) => {
                  setFormDate(e.target.value);
                  setOverlapError(null);
                  if (formRecurring && !formRecurUntil) {
                    setFormRecurUntil(defaultRecurUntil(e.target.value));
                  }
                }}
                min={today}
                className="w-full px-2 py-1.5 text-sm rounded-md border border-slate-300 bg-white"
              />
            </div>
            <div className="w-24">
              <label className="text-[10px] text-slate-500 block mb-0.5">{t('reservation.startTime') || 'From'}</label>
              <input
                type="time"
                value={formStart}
                onChange={(e) => { setFormStart(e.target.value); setOverlapError(null); }}
                className="w-full px-2 py-1.5 text-sm rounded-md border border-slate-300 bg-white"
              />
            </div>
            <div className="w-24">
              <label className="text-[10px] text-slate-500 block mb-0.5">{t('reservation.endTime') || 'To'}</label>
              <input
                type="time"
                value={formEnd}
                onChange={(e) => { setFormEnd(e.target.value); setOverlapError(null); }}
                className="w-full px-2 py-1.5 text-sm rounded-md border border-slate-300 bg-white"
              />
            </div>
          </div>

          {/* Recurring toggle (only for new reservations) */}
          {!editId && (
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={formRecurring}
                  onChange={(e) => {
                    setFormRecurring(e.target.checked);
                    if (e.target.checked && !formRecurUntil) {
                      setFormRecurUntil(defaultRecurUntil(formDate));
                    }
                  }}
                  className="w-4 h-4 rounded border-slate-300 text-rose-600 focus:ring-rose-500"
                />
                <Repeat className="w-3.5 h-3.5 text-rose-500" />
                <span className="text-xs font-medium text-slate-700">
                  {t('reservation.repeatWeekly') || 'Repeat weekly'}
                </span>
              </label>
              {formRecurring && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-slate-500">{t('reservation.until') || 'Until'}</span>
                  <input
                    type="date"
                    value={formRecurUntil}
                    onChange={(e) => setFormRecurUntil(e.target.value)}
                    min={formDate}
                    className="px-2 py-1 text-xs rounded-md border border-slate-300 bg-white"
                  />
                </div>
              )}
            </div>
          )}

          {/* Customer info with guest typeahead */}
          <div className="flex items-end gap-2 flex-wrap">
            <div className="flex-1 min-w-[140px]">
              <label className="text-[10px] text-slate-500 block mb-0.5">{t('reservation.customerName') || 'Name'}</label>
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="Jan Kowalski"
                className="w-full px-2 py-1.5 text-sm rounded-md border border-slate-300 bg-white"
              />
            </div>
            <div className="w-44 relative">
              <label className="text-[10px] text-slate-500 block mb-0.5">
                {t('reservation.customerPhone') || 'Phone'}
                {selectedGuestId && (
                  <span className="ml-1 text-emerald-600">✓</span>
                )}
              </label>
              <div className="relative">
                <input
                  ref={phoneInputRef}
                  type="tel"
                  value={formPhone}
                  onChange={(e) => handlePhoneChange(e.target.value)}
                  onFocus={() => { if (guestResults.length > 0) setShowGuestDropdown(true); }}
                  placeholder="+48..."
                  className="w-full px-2 py-1.5 pr-7 text-sm rounded-md border border-slate-300 bg-white"
                />
                <Search className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
              </div>

              {/* Guest dropdown */}
              {showGuestDropdown && guestResults.length > 0 && (
                <div
                  ref={dropdownRef}
                  className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden"
                >
                  {guestResults.slice(0, 5).map((g) => (
                    <button
                      key={g.id}
                      onClick={() => selectGuest(g)}
                      className="w-full px-3 py-2 text-left hover:bg-rose-50 transition-colors border-b border-slate-100 last:border-b-0"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-slate-800 truncate">
                          {g.name || t('guest.newGuest') || 'Guest'}
                        </span>
                        <span className="text-[10px] text-slate-400 tabular-nums ml-2 shrink-0">
                          {g.visit_count} {t('guest.visits') || 'visits'}
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-400">{g.phone}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="text-[10px] text-slate-500 block mb-0.5">{t('reservation.notes') || 'Notes'}</label>
              <input
                type="text"
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
                placeholder={t('reservation.notesPlaceholder') || 'e.g. birthday party'}
                className="w-full px-2 py-1.5 text-sm rounded-md border border-slate-300 bg-white"
              />
            </div>
            <button
              onClick={handleSave}
              disabled={!formTable || !formDate || !formStart || !formEnd}
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40 flex items-center gap-1"
            >
              <Save className="w-3.5 h-3.5" />
              {t('common.save') || 'Save'}
            </button>
          </div>

          {/* Overlap error */}
          {overlapError && (
            <p className="text-xs text-red-600 font-medium">{overlapError}</p>
          )}
        </div>
      )}

      {/* Reservation list */}
      <div className="flex-1 overflow-y-auto">
        {loading && reservations.length === 0 && (
          <div className="flex items-center justify-center h-32">
            <RefreshCw className="w-8 h-8 animate-spin text-rose-500" />
          </div>
        )}

        {error && (
          <div className="mx-4 mt-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {!loading && reservations.length === 0 && !error && (
          <div className="text-center py-12 text-slate-400">
            <CalendarClock className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">{t('reservation.noReservations') || 'No upcoming reservations'}</p>
            <p className="text-xs mt-1">{t('reservation.noReservationsHint') || 'Click + to add a reservation'}</p>
          </div>
        )}

        {sortedDates.map((date) => {
          const items = grouped[date];
          const isCollapsed = collapsed.has(date);

          return (
            <div key={date}>
              {/* Date header */}
              <button
                onClick={() => toggleCollapse(date)}
                className="w-full flex items-center gap-2 px-4 py-2 bg-slate-100 border-b border-slate-200 hover:bg-slate-200 transition-colors"
              >
                {isCollapsed ? <ChevronRight className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
                <span className="text-xs font-bold text-slate-700 uppercase tracking-wide">
                  {dateLabel(date)}
                </span>
                <span className="text-[10px] text-slate-400 tabular-nums">{date}</span>
                <span className="ml-auto text-[10px] text-slate-400">{items.length}</span>
              </button>

              {/* Reservation items */}
              {!isCollapsed && (
                <div className="divide-y divide-slate-100">
                  {items.map((r) => (
                    <div
                      key={r.id}
                      className="px-4 py-2.5 flex items-center gap-3 bg-white hover:bg-rose-50/50 transition-colors"
                    >
                      {/* Time range */}
                      <div className="shrink-0 w-20 text-center">
                        <span className="text-sm font-mono font-semibold text-rose-700 tabular-nums">
                          {r.start_time}
                        </span>
                        <span className="text-[10px] text-slate-400 mx-0.5">–</span>
                        <span className="text-sm font-mono font-semibold text-rose-700 tabular-nums">
                          {r.end_time}
                        </span>
                      </div>

                      {/* Table badge */}
                      <span className="shrink-0 text-[10px] font-bold px-2 py-0.5 rounded bg-rose-100 text-rose-700">
                        {tableName(r.resource_id)}
                      </span>

                      {/* Recurring badge */}
                      {(isRecurringTemplate(r) || isRecurringInstance(r)) && (
                        <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 flex items-center gap-0.5">
                          <Repeat className="w-2.5 h-2.5" />
                          {isRecurringTemplate(r)
                            ? `${seriesCount(r.id)} ${t('reservation.occurrences') || 'occ.'}`
                            : (t('reservation.recurringBadge') || 'Weekly')}
                        </span>
                      )}

                      {/* Customer info */}
                      <div className="flex-1 min-w-0">
                        {r.customer_name && (
                          <div className="flex items-center gap-1 text-sm text-slate-800">
                            <User className="w-3 h-3 text-slate-400 shrink-0" />
                            <span className="truncate">{r.customer_name}</span>
                          </div>
                        )}
                        <div className="flex items-center gap-2 text-[10px] text-slate-400">
                          {r.customer_phone && (
                            <span className="flex items-center gap-0.5">
                              <Phone className="w-2.5 h-2.5" /> {r.customer_phone}
                            </span>
                          )}
                          {r.notes && <span className="truncate italic">{r.notes}</span>}
                        </div>
                      </div>

                      {/* Edit */}
                      <button
                        onClick={() => openEdit(r)}
                        className="shrink-0 p-1.5 rounded-md text-slate-400 hover:text-rose-500 hover:bg-rose-50 transition-colors"
                        title={t('common.edit') || 'Edit'}
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>

                      {/* Cancel this one (for recurring instances) */}
                      {isRecurringInstance(r) && r.status === 'active' && (
                        <button
                          onClick={() => handleCancel(r.id)}
                          className="shrink-0 p-1.5 rounded-md text-slate-400 hover:text-amber-500 hover:bg-amber-50 transition-colors"
                          title={t('reservation.cancelOne') || 'Cancel this one'}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}

                      {/* Delete / Delete series */}
                      {isRecurringTemplate(r) ? (
                        <button
                          onClick={() => handleDeleteSeries(r)}
                          className="shrink-0 p-1.5 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                          title={t('reservation.deleteSeries') || 'Delete series'}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      ) : (
                        <button
                          onClick={() => handleDelete(r.id)}
                          className="shrink-0 p-1.5 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                          title={t('common.delete') || 'Delete'}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
