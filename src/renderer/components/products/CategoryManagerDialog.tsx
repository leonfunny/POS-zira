import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Palette, Plus, RefreshCw, Save } from 'lucide-react';
import type { ProductAdminCategory } from '../../../shared/types';
import Modal from '../shared/Modal';
import {
  buildAdminCategoryOrderUpdates,
  isValidCategoryColor,
  isValidCategoryIcon,
  moveCategoryAndNormalize,
  nextCategorySortOrder,
  shouldKeepCategoryCreateAttemptLocked,
} from './category-admin-state';
import { createStableMutationKeyStore } from './mutation-idempotency';

interface CategoryManagerDialogProps {
  language: string;
  t: (key: string) => string;
  canCreateCategory: boolean;
  canUpdateCategory: boolean;
  canReorderCategory: boolean;
  localCategoryCount: number;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}

interface CategoryDraft {
  name: string;
  color: string;
  icon: string;
}

interface CategoryCreateAttempt {
  draftFingerprint: string;
  payload: {
    name: string;
    color: string | null;
    icon: string | null;
    sortOrder: number;
  };
  idempotencyKey: string;
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
  };
}

function categoryGlyph(draft: CategoryDraft): string {
  const icon = draft.icon.trim();
  if (icon && [...icon].length <= 2) return icon;
  const words = draft.name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
  return draft.name.trim().slice(0, 2).toUpperCase() || '?';
}

function CategoryAppearanceFields({
  draft,
  setDraft,
  t,
  disabled,
}: {
  draft: CategoryDraft;
  setDraft: React.Dispatch<React.SetStateAction<CategoryDraft>>;
  t: (key: string) => string;
  disabled?: boolean;
}) {
  const validColor = isValidCategoryColor(draft.color);
  const validIcon = isValidCategoryIcon(draft.icon);
  const previewColor = validColor && draft.color.trim() ? draft.color.trim() : '#da7756';
  const fieldId = useId();
  const colorHintId = `${fieldId}-color-hint`;
  const iconHintId = `${fieldId}-icon-hint`;

  return (
    <details className="mt-2 rounded-md border border-slate-200 bg-slate-50/70">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium text-slate-700">
        <span className="flex items-center gap-2">
          <Palette size={16} />
          {tOr(t, 'products.category.displaySettings', 'Display settings')}
        </span>
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm font-bold"
          style={{ backgroundColor: `${previewColor}2E`, color: previewColor }}
          aria-label={tOr(t, 'products.category.preview', 'Preview')}
        >
          {categoryGlyph(draft)}
        </span>
      </summary>
      <div className="grid gap-3 border-t border-slate-200 p-3 sm:grid-cols-2">
        <label className="min-w-0 text-xs font-medium text-slate-600">
          {tOr(t, 'products.category.color', 'Color')}
          <div className="mt-1 flex gap-2">
            <input
              type="color"
              value={previewColor}
              onChange={(event) => setDraft((prev) => ({ ...prev, color: event.target.value }))}
              className="h-11 w-12 cursor-pointer rounded-md border border-slate-300 bg-white p-1"
              disabled={disabled}
              aria-label={tOr(t, 'products.category.colorPicker', 'Choose category color')}
            />
            <input
              value={draft.color}
              onChange={(event) => setDraft((prev) => ({ ...prev, color: event.target.value }))}
              placeholder="#2563eb"
              aria-label={tOr(t, 'products.category.colorHex', 'Category color hex value')}
              aria-invalid={!validColor}
              aria-describedby={colorHintId}
              className={`h-11 min-w-0 flex-1 rounded-md border px-3 text-sm outline-none focus:border-brand-500 ${
                validColor ? 'border-slate-300' : 'border-rose-400'
              }`}
              disabled={disabled}
            />
          </div>
          <span
            id={colorHintId}
            aria-live="polite"
            className={`mt-1 block font-normal ${validColor ? 'text-slate-500' : 'text-rose-600'}`}
          >
            {validColor
              ? tOr(t, 'products.category.colorHint', 'Optional, format #RRGGBB')
              : tOr(t, 'products.category.invalidColor', 'Color must use #RRGGBB format')}
          </span>
        </label>
        <label className="min-w-0 text-xs font-medium text-slate-600">
          {tOr(t, 'products.category.icon', 'Icon')}
          <input
            value={draft.icon}
            onChange={(event) => setDraft((prev) => ({ ...prev, icon: event.target.value }))}
            placeholder="🥤"
            aria-invalid={!validIcon}
            aria-describedby={iconHintId}
            className={`mt-1 h-11 w-full rounded-md border px-3 text-sm outline-none focus:border-brand-500 ${
              validIcon ? 'border-slate-300' : 'border-rose-400'
            }`}
            disabled={disabled}
          />
          <span
            id={iconHintId}
            aria-live="polite"
            className={`mt-1 block font-normal ${validIcon ? 'text-slate-500' : 'text-rose-600'}`}
          >
            {validIcon
              ? tOr(t, 'products.category.iconHint', 'Optional, maximum 2 characters or emoji')
              : tOr(t, 'products.category.invalidIcon', 'Icon can contain at most 2 characters or emoji')}
          </span>
        </label>
      </div>
    </details>
  );
}

function validateDraft(draft: CategoryDraft, t: (key: string) => string): string | null {
  if (!draft.name.trim()) return tOr(t, 'products.category.nameRequired', 'Enter category name');
  if (!isValidCategoryColor(draft.color)) {
    return tOr(t, 'products.category.invalidColor', 'Color must use #RRGGBB format');
  }
  if (!isValidCategoryIcon(draft.icon)) {
    return tOr(t, 'products.category.invalidIcon', 'Icon can contain at most 2 characters or emoji');
  }
  return null;
}

function CategoryRow({
  category,
  index,
  total,
  t,
  canUpdateCategory,
  canReorderCategory,
  mutationDisabled,
  ordering,
  onMove,
  onSavingChange,
  onSaved,
}: {
  category: ProductAdminCategory;
  index: number;
  total: number;
  t: (key: string) => string;
  canUpdateCategory: boolean;
  canReorderCategory: boolean;
  mutationDisabled: boolean;
  ordering: boolean;
  onMove: (categoryId: string, direction: -1 | 1) => Promise<void> | void;
  onSavingChange: (categoryId: string, saving: boolean) => void;
  onSaved: () => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<CategoryDraft>(() => toDraft(category));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setDraft(toDraft(category));
    setMessage(null);
  }, [category.id, category.name, category.color, category.icon]);

  const handleSave = async () => {
    if (mutationDisabled) return;
    const validationError = validateDraft(draft, t);
    if (validationError) {
      setMessage({ ok: false, text: validationError });
      return;
    }

    setBusy(true);
    onSavingChange(category.id, true);
    setMessage(null);
    let saveCommitted = false;
    try {
      const result = await window.electronAPI.pos.productAdmin.updateCategory(category.id, {
        name: draft.name.trim(),
        color: draft.color.trim() || null,
        icon: draft.icon.trim() || null,
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
      saveCommitted = true;
      const refreshed = await onSaved();
      setMessage(refreshed
        ? { ok: true, text: tOr(t, 'products.category.saved', 'Category saved') }
        : {
            ok: false,
            text: tOr(t, 'products.category.savedRefreshFailed', 'Category was saved, but categories could not be refreshed'),
          });
    } catch (err: any) {
      setMessage({
        ok: false,
        text: saveCommitted
          ? tOr(t, 'products.category.savedRefreshFailed', 'Category was saved, but categories could not be refreshed')
          : err?.message || tOr(t, 'products.category.saveFailed', 'Could not save category'),
      });
    } finally {
      setBusy(false);
      onSavingChange(category.id, false);
    }
  };

  const controlsDisabled = !canUpdateCategory || !canReorderCategory || mutationDisabled || busy;

  return (
    <div className="rounded-md border border-slate-200 p-3">
      <div className="flex items-center gap-2">
        {canReorderCategory ? (
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              onClick={() => void onMove(category.id, -1)}
              disabled={controlsDisabled || index === 0}
              className="flex h-11 w-9 items-center justify-center rounded-md border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-35"
              title={tOr(t, 'products.category.moveUp', 'Move up')}
              aria-label={tOr(t, 'products.category.moveUp', 'Move up')}
            >
              <ChevronUp size={17} />
            </button>
            <button
              type="button"
              onClick={() => void onMove(category.id, 1)}
              disabled={controlsDisabled || index === total - 1}
              className="flex h-11 w-9 items-center justify-center rounded-md border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-35"
              title={tOr(t, 'products.category.moveDown', 'Move down')}
              aria-label={tOr(t, 'products.category.moveDown', 'Move down')}
            >
              <ChevronDown size={17} />
            </button>
          </div>
        ) : null}
        <span className="w-7 shrink-0 text-center text-xs font-semibold tabular-nums text-slate-400">
          {index + 1}
        </span>
        <input
          value={draft.name}
          onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
          className="h-11 min-w-0 flex-1 rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
          disabled={!canUpdateCategory || ordering || busy}
          aria-label={tOr(t, 'products.category.name', 'Name')}
        />
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!canUpdateCategory || busy || mutationDisabled}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          title={tOr(t, 'products.category.save', 'Save')}
          aria-label={tOr(t, 'products.category.save', 'Save')}
        >
          <Save size={17} />
        </button>
      </div>
      <CategoryAppearanceFields draft={draft} setDraft={setDraft} t={t} disabled={!canUpdateCategory || ordering || busy} />
      {message ? (
        <div role={message.ok ? 'status' : 'alert'} className={`mt-2 rounded-md border px-3 py-2 text-xs ${
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
  canReorderCategory,
  localCategoryCount,
  onClose,
  onChanged,
}: CategoryManagerDialogProps) {
  const [categories, setCategories] = useState<ProductAdminCategory[]>([]);
  const [newCategory, setNewCategory] = useState<CategoryDraft>(() => toDraft());
  const [loading, setLoading] = useState(true);
  const [categoriesLoaded, setCategoriesLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const [savingCategoryIds, setSavingCategoryIds] = useState<Set<string>>(() => new Set());
  const [createAttemptLocked, setCreateAttemptLocked] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const mutationKeyStore = useRef(createStableMutationKeyStore());
  const createAttemptRef = useRef<CategoryCreateAttempt | null>(null);

  const loadCategories = async (): Promise<boolean> => {
    setLoading(true);
    setCategoriesLoaded(false);
    setMessage(null);
    try {
      const result = await window.electronAPI.pos.productAdmin.listCategories();
      if (!result?.ok) {
        setMessage({
          ok: false,
          text: result?.error || result?.code || tOr(t, 'products.category.loadFailed', 'Could not load categories'),
        });
        return false;
      }
      const rows = result.data?.categories || [];
      setCategories([...rows].sort((a, b) => {
        const order = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
        if (order !== 0) return order;
        return a.name.localeCompare(b.name, language);
      }));
      setCategoriesLoaded(true);
      return true;
    } catch (err: any) {
      setMessage({ ok: false, text: err?.message || tOr(t, 'products.category.loadFailed', 'Could not load categories') });
      return false;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadCategories();
  }, []);

  const mutationBusy = loading || creating || ordering || savingCategoryIds.size > 0;

  const handleSavingChange = (categoryId: string, saving: boolean) => {
    setSavingCategoryIds((current) => {
      const next = new Set(current);
      if (saving) next.add(categoryId);
      else next.delete(categoryId);
      return next;
    });
  };

  const handleCreate = async () => {
    if ((!categoriesLoaded && !createAttemptLocked) || mutationBusy) return;
    const validationError = validateDraft(newCategory, t);
    if (validationError) {
      setMessage({ ok: false, text: validationError });
      return;
    }

    setCreating(true);
    setMessage(null);
    let createCommitted = false;
    try {
      const draftPayload = {
        name: newCategory.name.trim(),
        color: newCategory.color.trim() || null,
        icon: newCategory.icon.trim() || null,
      };
      const draftFingerprint = JSON.stringify(draftPayload);
      let attempt = createAttemptRef.current;
      if (!attempt || (!createAttemptLocked && attempt.draftFingerprint !== draftFingerprint)) {
        const payload = {
          ...draftPayload,
          sortOrder: nextCategorySortOrder(categories),
        };
        attempt = {
          draftFingerprint,
          payload,
          idempotencyKey: mutationKeyStore.current.get(JSON.stringify(payload)),
        };
        createAttemptRef.current = attempt;
      }
      const result = await window.electronAPI.pos.productAdmin.createCategory({
        ...attempt.payload,
        idempotencyKey: attempt.idempotencyKey,
      });
      if (!result?.ok) {
        if (shouldKeepCategoryCreateAttemptLocked(createAttemptLocked, result)) {
          setCreateAttemptLocked(true);
        } else {
          mutationKeyStore.current.clear();
          createAttemptRef.current = null;
          setCreateAttemptLocked(false);
        }
        setMessage({
          ok: false,
          text: result?.error || result?.code || tOr(t, 'products.category.createFailed', 'Could not create category'),
        });
        return;
      }
      createCommitted = true;
      mutationKeyStore.current.clear();
      createAttemptRef.current = null;
      setCreateAttemptLocked(false);
      setNewCategory(toDraft());
      const refreshed = await loadCategories();
      if (refreshed) {
        setMessage({ ok: true, text: tOr(t, 'products.category.created', 'Category created') });
      }
      await onChanged();
    } catch (err: any) {
      if (!createCommitted) {
        setCreateAttemptLocked(true);
      }
      setMessage({
        ok: false,
        text: err?.message || tOr(
          t,
          createCommitted ? 'products.category.loadFailed' : 'products.category.createFailed',
          createCommitted ? 'Category was created, but categories could not be refreshed' : 'Could not create category',
        ),
      });
    } finally {
      setCreating(false);
    }
  };

  const handleMove = async (categoryId: string, direction: -1 | 1) => {
    if (!canReorderCategory || !categoriesLoaded || mutationBusy) return;
    const ordered = moveCategoryAndNormalize(categories, categoryId, direction);
    if (ordered === categories) return;

    const previousCategories = categories;
    setOrdering(true);
    setMessage(null);
    setCategories(ordered);
    let orderCommitted = false;
    try {
      const result = await window.electronAPI.pos.productAdmin.updateCategoryOrder(
        buildAdminCategoryOrderUpdates(ordered),
      );
      if (!result?.ok) {
        const refreshedAfterFailure = await loadCategories();
        if (!refreshedAfterFailure) setCategories(previousCategories);
        if (refreshedAfterFailure) {
          setMessage({
            ok: false,
            text: result?.error || result?.code || tOr(t, 'products.category.orderFailed', 'Could not save category order'),
          });
        }
        return;
      }

      orderCommitted = true;
      const canonicalCategories: ProductAdminCategory[] = Array.isArray(result.data?.categories)
        ? result.data.categories
        : [];
      const canonicalById = new Map<string, ProductAdminCategory>(
        canonicalCategories.map((category) => [category.id, category]),
      );
      setCategories(ordered.map((category) => canonicalById.get(category.id) || category));
      await onChanged();
      setMessage({ ok: true, text: tOr(t, 'products.category.orderSaved', 'Category order saved') });
    } catch (err: any) {
      if (orderCommitted) {
        setMessage({
          ok: false,
          text: tOr(t, 'products.category.orderRefreshFailed', 'Category order was saved, but products could not be refreshed'),
        });
      } else {
        const refreshedAfterFailure = await loadCategories();
        if (!refreshedAfterFailure) setCategories(previousCategories);
        if (refreshedAfterFailure) {
          setMessage({
            ok: false,
            text: err?.message || tOr(t, 'products.category.orderFailed', 'Could not save category order'),
          });
        }
      }
    } finally {
      setOrdering(false);
    }
  };

  const handleSaved = async (): Promise<boolean> => {
    const refreshed = await loadCategories();
    try {
      await onChanged();
      return refreshed;
    } catch {
      return false;
    }
  };

  return (
    <Modal
      open
      keyboardAware
      size="full"
      zLayer="nested"
      title={tOr(t, 'products.category.title', 'Manage categories')}
      onClose={onClose}
      busy={mutationBusy}
      panelClassName="sm:max-w-[720px]"
      closeLabel={tOr(t, 'products.drawer.close', 'Close')}
    >
      <div className="min-h-0 p-4">
        <div className="mb-3 flex justify-end">
          <button
            type="button"
            onClick={() => void loadCategories()}
            disabled={loading || mutationBusy}
            className="flex h-11 w-11 items-center justify-center rounded-md border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            title={tOr(t, 'orders.refresh', 'Refresh')}
            aria-label={tOr(t, 'orders.refresh', 'Refresh')}
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
            <div className="flex gap-2">
              <input
                value={newCategory.name}
                onChange={(event) => setNewCategory((prev) => ({ ...prev, name: event.target.value }))}
                placeholder={tOr(t, 'products.category.name', 'Name')}
                className="h-11 min-w-0 flex-1 rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
                aria-label={tOr(t, 'products.category.name', 'Name')}
                disabled={mutationBusy || !categoriesLoaded || createAttemptLocked}
              />
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={creating || mutationBusy || (!categoriesLoaded && !createAttemptLocked)}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-brand-600 text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
                title={tOr(t, 'products.category.create', 'Create')}
                aria-label={tOr(t, 'products.category.create', 'Create')}
              >
                <Plus size={17} />
              </button>
            </div>
            <CategoryAppearanceFields
              draft={newCategory}
              setDraft={setNewCategory}
              t={t}
              disabled={mutationBusy || !categoriesLoaded || createAttemptLocked}
            />
            {createAttemptLocked ? (
              <div role="status" className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {tOr(
                  t,
                  'products.category.createOutcomeUncertain',
                  'The previous create result is uncertain. Fields are locked; choose Create again to safely retry the exact same request.',
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        {message ? (
          <div role={message.ok ? 'status' : 'alert'} className={`mb-4 rounded-md border px-3 py-2 text-sm ${
            message.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'
          }`}>
            {message.text}
          </div>
        ) : null}

        <div className="mb-2 flex items-center justify-between px-1 text-xs font-semibold uppercase text-slate-500">
          <span>{tOr(t, 'products.category.name', 'Name')}</span>
          {canReorderCategory ? (
            <span>{tOr(t, 'products.category.reorderHint', 'Use arrows to reorder')}</span>
          ) : null}
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
            {categories.map((category, index) => (
              <CategoryRow
                key={category.id}
                category={category}
                index={index}
                total={categories.length}
                t={t}
                canUpdateCategory={canUpdateCategory}
                canReorderCategory={canReorderCategory}
                mutationDisabled={mutationBusy || !categoriesLoaded}
                ordering={ordering}
                onMove={handleMove}
                onSavingChange={handleSavingChange}
                onSaved={handleSaved}
              />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
