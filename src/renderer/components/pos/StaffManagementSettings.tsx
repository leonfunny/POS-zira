import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Pencil, Plus, RefreshCw, Save, UserCheck, UserX, X } from 'lucide-react';

interface StaffRow {
  id: string;
  name: string;
  commission_rate: number;
  is_active: number;
  role?: string | null;
  backend_synced_at?: string | null;
}

interface StaffFormState {
  name: string;
  role: string;
  commissionPercent: string;
}

const emptyForm: StaffFormState = {
  name: '',
  role: '',
  commissionPercent: '',
};

function toPercent(rate: number): string {
  const value = rate / 100;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function toBasisPoints(value: string): number {
  const parsed = Number(value.replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed * 100);
}

export default function StaffManagementSettings() {
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [form, setForm] = useState<StaffFormState>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingForm, setEditingForm] = useState<StaffFormState>(emptyForm);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeCount = useMemo(() => rows.filter((row) => row.is_active !== 0).length, [rows]);

  const readLocal = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const api = window.electronAPI.pos.staff;
      const nextRows = api.getAllForSettings ? await api.getAllForSettings() : await api.getAll();
      setRows(nextRows || []);
    } catch (err: any) {
      setError(err?.message || 'Could not load staff');
    } finally {
      setLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const syncStaff = window.electronAPI.pos.sync.staff;
      if (syncStaff) await syncStaff().catch(() => null);
    } finally {
      setLoading(false);
    }
    await readLocal();
  }, [readLocal]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    return window.electronAPI.pos.sync.onStaffUpdated?.(() => {
      readLocal();
    });
  }, [readLocal]);

  const saveNew = async () => {
    if (!form.name.trim() || saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const result = await window.electronAPI.pos.staff.create({
        name: form.name.trim(),
        role: form.role.trim() || null,
        commissionRate: toBasisPoints(form.commissionPercent),
        isActive: true,
      });
      if (!result.success) throw new Error(result.error || 'Could not add staff');
      setForm(emptyForm);
      setMessage('Staff added');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Could not add staff');
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (row: StaffRow) => {
    setEditingId(row.id);
    setEditingForm({
      name: row.name,
      role: row.role || '',
      commissionPercent: toPercent(row.commission_rate || 0),
    });
    setMessage(null);
    setError(null);
  };

  const saveEdit = async (row: StaffRow) => {
    if (!editingForm.name.trim() || saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const result = await window.electronAPI.pos.staff.update(row.id, {
        name: editingForm.name.trim(),
        role: editingForm.role.trim() || null,
        commissionRate: toBasisPoints(editingForm.commissionPercent),
        isActive: row.is_active !== 0,
      });
      if (!result.success) throw new Error(result.error || 'Could not save staff');
      setEditingId(null);
      setMessage('Staff saved');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Could not save staff');
    } finally {
      setSaving(false);
    }
  };

  const setActive = async (row: StaffRow, active: boolean) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const result = await window.electronAPI.pos.staff.setActive(row.id, active);
      if (!result.success) throw new Error(result.error || 'Could not update staff');
      setMessage(active ? 'Staff activated' : 'Staff deactivated');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Could not update staff');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
            <UserCheck size={16} />
            Staff
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            Active staff appear as choices when opening a POS shift.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_120px_auto] gap-2">
        <input
          value={form.name}
          onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
          placeholder="Employee name"
          className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
        />
        <input
          value={form.role}
          onChange={(event) => setForm((prev) => ({ ...prev, role: event.target.value }))}
          placeholder="Role"
          className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
        />
        <input
          value={form.commissionPercent}
          onChange={(event) => {
            if (/^\d*([,.]\d{0,2})?$/.test(event.target.value)) {
              setForm((prev) => ({ ...prev, commissionPercent: event.target.value }));
            }
          }}
          placeholder="0%"
          inputMode="decimal"
          className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
        />
        <button
          type="button"
          onClick={saveNew}
          disabled={saving || !form.name.trim()}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-brand-600 text-white text-sm font-semibold hover:bg-brand-700 disabled:opacity-50"
        >
          <Plus size={15} />
          Add
        </button>
      </div>

      <div className="rounded-lg border border-slate-200 overflow-hidden">
        <div className="hidden md:grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_90px_96px_112px] gap-2 px-3 py-2 bg-slate-50 text-xs font-semibold text-slate-500">
          <span>Name</span>
          <span>Role</span>
          <span>Commission</span>
          <span>Status</span>
          <span className="text-right">Actions</span>
        </div>
        <div className="divide-y divide-slate-100 bg-white">
          {rows.length === 0 && (
            <div className="px-3 py-4 text-sm text-slate-500">
              {loading ? 'Loading staff...' : 'No staff yet.'}
            </div>
          )}
          {rows.map((row) => {
            const editing = editingId === row.id;
            return (
              <div
                key={row.id}
                className={`grid grid-cols-1 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_90px_96px_112px] gap-2 px-3 py-2 text-sm items-center ${
                  row.is_active === 0 ? 'bg-slate-50 text-slate-500' : 'text-slate-800'
                }`}
              >
                {editing ? (
                  <>
                    <input
                      value={editingForm.name}
                      onChange={(event) => setEditingForm((prev) => ({ ...prev, name: event.target.value }))}
                      className="px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    />
                    <input
                      value={editingForm.role}
                      onChange={(event) => setEditingForm((prev) => ({ ...prev, role: event.target.value }))}
                      className="px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    />
                    <input
                      value={editingForm.commissionPercent}
                      onChange={(event) => {
                        if (/^\d*([,.]\d{0,2})?$/.test(event.target.value)) {
                          setEditingForm((prev) => ({ ...prev, commissionPercent: event.target.value }));
                        }
                      }}
                      inputMode="decimal"
                      className="px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                    />
                  </>
                ) : (
                  <>
                    <span className="font-semibold truncate">{row.name}</span>
                    <span className="truncate">{row.role || '-'}</span>
                    <span>{toPercent(row.commission_rate || 0)}%</span>
                  </>
                )}
                <span className={`inline-flex w-fit items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold ${
                  row.is_active === 0 ? 'bg-slate-100 text-slate-500' : 'bg-emerald-50 text-emerald-700'
                }`}>
                  {row.is_active === 0 ? <UserX size={13} /> : <CheckCircle2 size={13} />}
                  {row.is_active === 0 ? 'Inactive' : 'Active'}
                </span>
                <div className="flex items-center justify-end gap-1">
                  {editing ? (
                    <>
                      <button
                        type="button"
                        onClick={() => saveEdit(row)}
                        disabled={saving || !editingForm.name.trim()}
                        className="w-8 h-8 inline-flex items-center justify-center rounded-md text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                        title="Save"
                      >
                        <Save size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="w-8 h-8 inline-flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100"
                        title="Cancel"
                      >
                        <X size={16} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => startEdit(row)}
                        className="w-8 h-8 inline-flex items-center justify-center rounded-md text-slate-600 hover:bg-slate-100"
                        title="Edit"
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setActive(row, row.is_active === 0)}
                        disabled={saving}
                        className="w-8 h-8 inline-flex items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                        title={row.is_active === 0 ? 'Activate' : 'Deactivate'}
                      >
                        {row.is_active === 0 ? <UserCheck size={16} /> : <UserX size={16} />}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-500">{activeCount} active / {rows.length} total</span>
        {message && <span className="text-emerald-700">{message}</span>}
        {error && <span className="text-red-600">{error}</span>}
      </div>
    </section>
  );
}
