import React, { useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Save } from 'lucide-react';
import type { ProductAdminCategory } from '../../../shared/types';
import Modal from '../shared/Modal';
import { createStableMutationKeyStore } from './mutation-idempotency';

interface CategoryManagerDialogProps {
  language: string;
  t: (key: string) => string;
  canCreateCategory: boolean;
  canUpdateCategory: boolean;
  localCategoryCount: number;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}

interface CategoryDraft {
  name: string;
  color: string;
  icon: string;
  sortOrder: string;
}

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function toDraft(category?: ProductAdminCategory): CategoryDraft {
  return {
    name: category?.name || '',
    color: category?.color || '',
    icon: category?.icon || '',
    sortOrder: category?.sortOrder == null ? '' : String(category.sortOrder),
  };
}

function parseSortOrder(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function CategoryRow({
  category,
  t,
  canUpdateCategory,
  onSaved,
}: {
  category: ProductAdminCategory;
  t: (key: string) => string;
  canUpdateCategory: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<CategoryDraft>(() => toDraft(category));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setDraft(toDraft(category));
    setMessage(null);
  }, [category.id, category.name, category.color, category.icon, category.sortOrder]);

  const handleSave = async () => {
    if (!draft.name.trim()) {
      setMessage({ ok: false, text: tOr(t, 'products.category.nameRequired', 'Enter category name') });
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const result = await window.electronAPI.pos.productAdmin.updateCategory(category.id, {
        name: draft.name.trim(),
        color: draft.color.trim() || null,
        icon: draft.icon.trim() || null,
        sortOrder: parseSortOrder(draft.sortOrder),
        expectedUpdatedAt: category.updatedAt || undefined,
        expectedVersion: category.version,
      });
      if (!result?.ok) {
        setMessage({
          ok: false,
          text: result?.error || result?.code || tOr(t, 'products.category.saveFailed', 'Could not save category'),
        });
        return;
      }
      setMessage({ ok: true, text: tOr(t, 'products.category.saved', 'Category saved') });
      await onSaved();
    } catch (err: any) {
      setMessage({ ok: false, text: err?.message || tOr(t, 'products.category.saveFailed', 'Could not save category') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-slate-200 p-3">
      <div className="grid gap-2 md:grid-cols-[minmax(0,1.5fr)_90px_80px_90px_44px]">
        <input
          value={draft.name}
          onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
          className="h-11 min-w-0 rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
          disabled={!canUpdateCategory}
        />
        <input
          value={draft.color}
          onChange={(event) => setDraft((prev) => ({ ...prev, color: event.target.value }))}
          placeholder="#2563eb"
          className="h-11 min-w-0 rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
          disabled={!canUpdateCategory}
        />
        <input
          value={draft.icon}
          onChange={(event) => setDraft((prev) => ({ ...prev, icon: event.target.value }))}
          placeholder="DR"
          className="h-11 min-w-0 rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
          disabled={!canUpdateCategory}
        />
        <input
          value={draft.sortOrder}
          onChange={(event) => setDraft((prev) => ({ ...prev, sortOrder: event.target.value }))}
          inputMode="numeric"
          className="h-11 min-w-0 rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
          disabled={!canUpdateCategory}
        />
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!canUpdateCategory || busy}
          className="flex h-11 w-11 items-center justify-center rounded-md border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          title={tOr(t, 'products.category.save', 'Save')}
        >
          <Save size={17} />
        </button>
      </div>
      {message ? (
        <div className={`mt-2 rounded-md border px-3 py-2 text-xs ${
          message.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'
        }`}>
          {message.text}
        </div>
      ) : null}
    </div>
  );
}

export default function CategoryManagerDialog({
  language,
  t,
  canCreateCategory,
  canUpdateCategory,
  localCategoryCount,
  onClose,
  onChanged,
}: CategoryManagerDialogProps) {
  const [categories, setCategories] = useState<ProductAdminCategory[]>([]);
  const [newCategory, setNewCategory] = useState<CategoryDraft>(() => toDraft());
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const mutationKeyStore = useRef(createStableMutationKeyStore());

  const loadCategories = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const result = await window.electronAPI.pos.productAdmin.listCategories();
      if (!result?.ok) {
        setMessage({
          ok: false,
          text: result?.error || result?.code || tOr(t, 'products.category.loadFailed', 'Could not load categories'),
        });
        return;
      }
      const rows = result.data?.categories || [];
      setCategories([...rows].sort((a, b) => {
        const order = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
        if (order !== 0) return order;
        return a.name.localeCompare(b.name, language);
      }));
    } catch (err: any) {
      setMessage({ ok: false, text: err?.message || tOr(t, 'products.category.loadFailed', 'Could not load categories') });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadCategories();
  }, []);

  const handleCreate = async () => {
    if (!newCategory.name.trim()) {
      setMessage({ ok: false, text: tOr(t, 'products.category.nameRequired', 'Enter category name') });
      return;
    }

    setCreating(true);
    setMessage(null);
    try {
      const payload = {
        name: newCategory.name.trim(),
        color: newCategory.color.trim() || null,
        icon: newCategory.icon.trim() || null,
        sortOrder: parseSortOrder(newCategory.sortOrder),
      };
      const result = await window.electronAPI.pos.productAdmin.createCategory({
        ...payload,
        idempotencyKey: mutationKeyStore.current.get(JSON.stringify(payload)),
      });
      if (!result?.ok) {
        setMessage({
          ok: false,
          text: result?.error || result?.code || tOr(t, 'products.category.createFailed', 'Could not create category'),
        });
        return;
      }
      mutationKeyStore.current.clear();
      setNewCategory(toDraft());
      setMessage({ ok: true, text: tOr(t, 'products.category.created', 'Category created') });
      await loadCategories();
      await onChanged();
    } catch (err: any) {
      setMessage({ ok: false, text: err?.message || tOr(t, 'products.category.createFailed', 'Could not create category') });
    } finally {
      setCreating(false);
    }
  };

  const handleSaved = async () => {
    await loadCategories();
    await onChanged();
  };

  return (
    <Modal
      open
      size="full"
      zLayer="nested"
      title={tOr(t, 'products.category.title', 'Manage categories')}
      onClose={onClose}
      busy={creating}
      panelClassName="sm:max-w-[720px]"
      closeLabel={tOr(t, 'products.drawer.close', 'Close')}
    >
        <div className="min-h-0 p-4">
          <div className="mb-3 flex justify-end">
            <button
              type="button"
              onClick={() => void loadCategories()}
              disabled={loading}
              className="flex h-11 w-11 items-center justify-center rounded-md border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              title={tOr(t, 'orders.refresh', 'Refresh')}
            >
              <RefreshCw size={17} className={loading ? 'animate-spin motion-reduce:animate-none' : ''} />
            </button>
          </div>
          <div className="mb-4 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
            <div>{tOr(t, 'products.category.backendHelp', 'Categories here are loaded from Product Admin backend. Create/save sends changes to backend; the product filter updates after catalog sync.')}</div>
            {localCategoryCount > 0 ? (
              <div className="mt-1 text-xs text-sky-700">
                {localCategoryCount} {tOr(t, 'products.category.localCount', 'categories are currently in the local POS catalog filter.')}
              </div>
            ) : null}
          </div>

          {canCreateCategory ? (
            <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2 text-xs font-semibold uppercase text-slate-500">
                {tOr(t, 'products.category.new', 'New category')}
              </div>
              <div className="grid gap-2 md:grid-cols-[minmax(0,1.5fr)_90px_80px_90px_44px]">
                <input
                  value={newCategory.name}
                  onChange={(event) => setNewCategory((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder={tOr(t, 'products.category.name', 'Name')}
                  className="h-11 min-w-0 rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
                />
                <input
                  value={newCategory.color}
                  onChange={(event) => setNewCategory((prev) => ({ ...prev, color: event.target.value }))}
                  placeholder="#2563eb"
                  className="h-11 min-w-0 rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
                />
                <input
                  value={newCategory.icon}
                  onChange={(event) => setNewCategory((prev) => ({ ...prev, icon: event.target.value }))}
                  placeholder="DR"
                  className="h-11 min-w-0 rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
                />
                <input
                  value={newCategory.sortOrder}
                  onChange={(event) => setNewCategory((prev) => ({ ...prev, sortOrder: event.target.value }))}
                  inputMode="numeric"
                  placeholder={tOr(t, 'products.category.sortOrder', 'Order')}
                  className="h-11 min-w-0 rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
                />
                <button
                  type="button"
                  onClick={() => void handleCreate()}
                  disabled={creating}
                  className="flex h-11 w-11 items-center justify-center rounded-md bg-brand-600 text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
                  title={tOr(t, 'products.category.create', 'Create')}
                >
                  <Plus size={17} />
                </button>
              </div>
            </div>
          ) : null}

          {message ? (
            <div className={`mb-4 rounded-md border px-3 py-2 text-sm ${
              message.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'
            }`}>
              {message.text}
            </div>
          ) : null}

          <div className="mb-2 grid gap-2 px-1 text-xs font-semibold uppercase text-slate-500 md:grid-cols-[minmax(0,1.5fr)_90px_80px_90px_44px]">
            <div>{tOr(t, 'products.category.name', 'Name')}</div>
            <div>{tOr(t, 'products.category.color', 'Color')}</div>
            <div>{tOr(t, 'products.category.icon', 'Icon')}</div>
            <div>{tOr(t, 'products.category.sortOrder', 'Order')}</div>
            <div />
          </div>

          {loading && categories.length === 0 ? (
            <div className="rounded-md border border-slate-200 p-6 text-center text-sm text-slate-500">
              {tOr(t, 'products.category.loading', 'Loading categories...')}
            </div>
          ) : categories.length === 0 ? (
            <div className="rounded-md border border-slate-200 p-6 text-center text-sm text-slate-500">
              {tOr(t, 'products.category.emptyAdmin', 'No backend categories returned. Create the first category here if category management should start now.')}
            </div>
          ) : (
            <div className="space-y-2">
              {categories.map((category) => (
                <CategoryRow
                  key={category.id}
                  category={category}
                  t={t}
                  canUpdateCategory={canUpdateCategory}
                  onSaved={handleSaved}
                />
              ))}
            </div>
          )}
        </div>
    </Modal>
  );
}
