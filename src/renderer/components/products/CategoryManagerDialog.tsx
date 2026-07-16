import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Image as ImageIcon,
  ImagePlus,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import type { ProductAdminCategory } from '../../../shared/types';
import Modal from '../shared/Modal';
import type { PendingProductImage } from './ProductImageField';
import {
  buildAdminCategoryOrderUpdates,
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
  canDeleteCategory: boolean;
  canReplaceCategoryImage: boolean;
  supportsCategoryImageUpload: boolean;
  localCategoryCount: number;
  localProductCounts: Record<string, number>;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}

interface CategoryDraft {
  name: string;
  imageUrl: string;
  pendingImage: PendingProductImage | null;
  removeImage: boolean;
}

interface CategoryCreateAttempt {
  draftFingerprint: string;
  payload: {
    name: string;
    sortOrder: number;
  };
  pendingImage: PendingProductImage | null;
  idempotencyKey: string;
}

const MAX_CATEGORY_IMAGE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_CATEGORY_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function toDraft(category?: ProductAdminCategory): CategoryDraft {
  return {
    name: category?.name || '',
    imageUrl: category?.imageUrl || '',
    pendingImage: null,
    removeImage: false,
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read image'));
    reader.readAsDataURL(file);
  });
}

function CategoryImagePicker({
  draft,
  setDraft,
  t,
  disabled,
  supportsUpload,
}: {
  draft: CategoryDraft;
  setDraft: React.Dispatch<React.SetStateAction<CategoryDraft>>;
  t: (key: string) => string;
  disabled: boolean;
  supportsUpload: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewUrl = draft.pendingImage?.dataUrl || (draft.removeImage ? '' : draft.imageUrl);

  useEffect(() => {
    setPreviewFailed(false);
  }, [previewUrl]);

  const selectFile = async (file?: File) => {
    if (!file) return;
    setError(null);
    if (!ACCEPTED_CATEGORY_IMAGE_TYPES.has(file.type)) {
      setError(tOr(t, 'products.category.imageInvalidFile', 'Choose a JPG, PNG, or WebP image'));
      return;
    }
    if (file.size > MAX_CATEGORY_IMAGE_BYTES) {
      setError(tOr(t, 'products.category.imageTooLarge', 'Category image must be smaller than 5 MB'));
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setDraft((current) => ({
        ...current,
        pendingImage: {
          dataUrl,
          fileName: file.name,
          mimeType: file.type as PendingProductImage['mimeType'],
          source: 'file',
        },
        removeImage: false,
      }));
    } catch {
      setError(tOr(t, 'products.category.imageReadFailed', 'Could not read the selected image'));
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const removeImage = () => {
    setError(null);
    setDraft((current) => ({
      ...current,
      imageUrl: '',
      pendingImage: null,
      removeImage: true,
    }));
  };

  return (
    <section className="rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center gap-4">
        <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md border border-slate-200 bg-white text-slate-400">
          {previewUrl && !previewFailed ? (
            <img
              src={previewUrl}
              alt={tOr(t, 'products.category.imagePreview', 'Category image preview')}
              onError={() => setPreviewFailed(true)}
              className="h-full w-full object-cover"
            />
          ) : (
            <ImageIcon size={30} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900">
            {tOr(t, 'products.category.image', 'Category image')}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {tOr(t, 'products.category.imageHint', 'Square JPG, PNG, or WebP image, maximum 5 MB')}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(event) => void selectFile(event.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={disabled || !supportsUpload}
              className="inline-flex h-11 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              title={!supportsUpload
                ? tOr(t, 'products.category.imageUnavailable', 'Category image upload is unavailable')
                : undefined}
            >
              <ImagePlus size={17} />
              {previewUrl
                ? tOr(t, 'products.category.imageChange', 'Change image')
                : tOr(t, 'products.category.imageChoose', 'Choose image')}
            </button>
            {previewUrl ? (
              <button
                type="button"
                onClick={removeImage}
                disabled={disabled || !supportsUpload}
                className="inline-flex h-11 items-center gap-2 rounded-md border border-rose-200 bg-white px-3 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
              >
                <X size={17} />
                {tOr(t, 'products.category.imageRemove', 'Remove image')}
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {draft.pendingImage ? (
        <div role="status" className="mt-3 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
          {tOr(t, 'products.category.imagePending', 'The new image will upload when you save')}: {draft.pendingImage.fileName}
        </div>
      ) : null}
      {!supportsUpload ? (
        <div role="status" className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {tOr(t, 'products.category.imageUnavailable', 'Category image upload is unavailable')}
        </div>
      ) : null}
      {previewFailed ? (
        <div role="alert" className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {tOr(t, 'products.category.imagePreviewFailed', 'The current category image could not be previewed')}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </div>
      ) : null}
    </section>
  );
}

function CategoryEditorDialog({
  mode,
  category,
  draft,
  setDraft,
  t,
  busy,
  createAttemptLocked,
  supportsImageUpload,
  message,
  onClose,
  onSave,
}: {
  mode: 'create' | 'edit';
  category: ProductAdminCategory | null;
  draft: CategoryDraft;
  setDraft: React.Dispatch<React.SetStateAction<CategoryDraft>>;
  t: (key: string) => string;
  busy: boolean;
  createAttemptLocked: boolean;
  supportsImageUpload: boolean;
  message: { ok: boolean; text: string } | null;
  onClose: () => void;
  onSave: () => void;
}) {
  const locked = busy || createAttemptLocked;
  return (
    <Modal
      open
      keyboardAware
      zLayer="nested"
      size="md"
      title={mode === 'create'
        ? tOr(t, 'products.category.createTitle', 'Create category')
        : tOr(t, 'products.category.editTitle', 'Edit category')}
      onClose={onClose}
      busy={locked}
      closeLabel={tOr(t, 'products.edit.cancel', 'Cancel')}
      footer={(
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={locked}
            className="h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            {tOr(t, 'products.edit.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={busy || (!draft.name.trim() && !createAttemptLocked)}
            className="inline-flex h-11 items-center gap-2 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {mode === 'create' ? <Plus size={17} /> : <Save size={17} />}
            {mode === 'create'
              ? tOr(t, 'products.category.create', 'Create')
              : tOr(t, 'products.category.save', 'Save')}
          </button>
        </div>
      )}
    >
      <div className="space-y-4 p-4">
        <label className="block text-sm font-semibold text-slate-700">
          {tOr(t, 'products.category.name', 'Name')}
          <input
            autoFocus
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            disabled={locked}
            maxLength={255}
            className="mt-2 h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-brand-500 disabled:bg-slate-100"
          />
        </label>
        <CategoryImagePicker
          draft={draft}
          setDraft={setDraft}
          t={t}
          disabled={locked}
          supportsUpload={supportsImageUpload}
        />
        {mode === 'edit' && category ? (
          <div className="text-xs text-slate-500">
            {tOr(t, 'products.category.imageSyncHint', 'Saved images sync to other POS devices through the backend catalog.')}
          </div>
        ) : null}
        {createAttemptLocked ? (
          <div role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {tOr(
              t,
              'products.category.createOutcomeUncertain',
              'The previous create result is uncertain. Fields are locked; choose Create again to safely retry the exact same request.',
            )}
          </div>
        ) : null}
        {message ? (
          <div role={message.ok ? 'status' : 'alert'} className={`rounded-md border px-3 py-2 text-sm ${
            message.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'
          }`}>
            {message.text}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function DeleteCategoryDialog({
  category,
  productCount,
  t,
  busy,
  message,
  onClose,
  onConfirm,
}: {
  category: ProductAdminCategory;
  productCount: number;
  t: (key: string) => string;
  busy: boolean;
  message: { ok: boolean; text: string } | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open
      zLayer="nested"
      size="sm"
      title={tOr(t, 'products.category.deleteTitle', 'Delete category?')}
      onClose={onClose}
      busy={busy}
      closeLabel={tOr(t, 'products.edit.cancel', 'Cancel')}
      footer={(
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            {tOr(t, 'products.edit.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex h-11 items-center gap-2 rounded-md bg-rose-600 px-4 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
          >
            <Trash2 size={17} />
            {busy
              ? tOr(t, 'products.category.deleting', 'Deleting...')
              : tOr(t, 'products.category.delete', 'Delete')}
          </button>
        </div>
      )}
    >
      <div className="p-4">
        <div className="flex gap-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-rose-800">
          <AlertTriangle size={20} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="font-semibold">{category.name}</div>
            <div className="mt-1 text-sm">
              {tOr(t, 'products.category.deleteDescription', 'The category will be permanently removed.')}
            </div>
          </div>
        </div>
        {productCount > 0 ? (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {tOr(
              t,
              'products.category.deleteWithProducts',
              '{count} products will not be deleted; they will move to Uncategorised.',
            ).replace('{count}', String(productCount))}
          </div>
        ) : null}
        {message ? (
          <div role="alert" className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {message.text}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function CategoryRow({
  category,
  index,
  total,
  productCount,
  t,
  canUpdateCategory,
  canReorderCategory,
  canDeleteCategory,
  mutationDisabled,
  onMove,
  onEdit,
  onDelete,
}: {
  category: ProductAdminCategory;
  index: number;
  total: number;
  productCount: number;
  t: (key: string) => string;
  canUpdateCategory: boolean;
  canReorderCategory: boolean;
  canDeleteCategory: boolean;
  mutationDisabled: boolean;
  onMove: (categoryId: string, direction: -1 | 1) => Promise<void> | void;
  onEdit: (category: ProductAdminCategory) => void;
  onDelete: (category: ProductAdminCategory) => void;
}) {
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => setPreviewFailed(false), [category.imageUrl]);

  return (
    <div className="flex items-center gap-3 rounded-md border border-slate-200 bg-white p-3">
      <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-slate-200 bg-slate-50 text-slate-400">
        {category.imageUrl && !previewFailed ? (
          <img
            src={category.imageUrl}
            alt={category.name}
            onError={() => setPreviewFailed(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <ImageIcon size={24} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-slate-950">{category.name}</div>
        <div className="mt-1 text-xs text-slate-500">
          {productCount} {tOr(t, 'products.category.products', 'products')}
        </div>
      </div>
      <span className="w-7 shrink-0 text-center text-xs font-semibold tabular-nums text-slate-400">
        {index + 1}
      </span>
      {canReorderCategory ? (
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => void onMove(category.id, -1)}
            disabled={mutationDisabled || index === 0}
            className="flex h-11 w-11 items-center justify-center rounded-md border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-35"
            title={tOr(t, 'products.category.moveUp', 'Move up')}
            aria-label={tOr(t, 'products.category.moveUp', 'Move up')}
          >
            <ChevronUp size={18} />
          </button>
          <button
            type="button"
            onClick={() => void onMove(category.id, 1)}
            disabled={mutationDisabled || index === total - 1}
            className="flex h-11 w-11 items-center justify-center rounded-md border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-35"
            title={tOr(t, 'products.category.moveDown', 'Move down')}
            aria-label={tOr(t, 'products.category.moveDown', 'Move down')}
          >
            <ChevronDown size={18} />
          </button>
        </div>
      ) : null}
      {canUpdateCategory ? (
        <button
          type="button"
          onClick={() => onEdit(category)}
          disabled={mutationDisabled}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          title={tOr(t, 'products.category.edit', 'Edit')}
          aria-label={`${tOr(t, 'products.category.edit', 'Edit')} ${category.name}`}
        >
          <Pencil size={17} />
        </button>
      ) : null}
      {canDeleteCategory ? (
        <button
          type="button"
          onClick={() => onDelete(category)}
          disabled={mutationDisabled}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-rose-200 text-rose-700 hover:bg-rose-50 disabled:opacity-50"
          title={tOr(t, 'products.category.delete', 'Delete')}
          aria-label={`${tOr(t, 'products.category.delete', 'Delete')} ${category.name}`}
        >
          <Trash2 size={17} />
        </button>
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
  canDeleteCategory,
  canReplaceCategoryImage,
  supportsCategoryImageUpload,
  localCategoryCount,
  localProductCounts,
  onClose,
  onChanged,
}: CategoryManagerDialogProps) {
  const [categories, setCategories] = useState<ProductAdminCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [categoriesLoaded, setCategoriesLoaded] = useState(false);
  const [savingEditor, setSavingEditor] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editorMode, setEditorMode] = useState<'create' | 'edit' | null>(null);
  const [editingCategory, setEditingCategory] = useState<ProductAdminCategory | null>(null);
  const [draft, setDraft] = useState<CategoryDraft>(() => toDraft());
  const [deleteTarget, setDeleteTarget] = useState<ProductAdminCategory | null>(null);
  const [createAttemptLocked, setCreateAttemptLocked] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const mutationKeyStore = useRef(createStableMutationKeyStore());
  const createAttemptRef = useRef<CategoryCreateAttempt | null>(null);
  const supportsImageUpload = canReplaceCategoryImage && supportsCategoryImageUpload;

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

  const mutationBusy = loading || savingEditor || ordering || deleting;

  const openCreate = () => {
    setMessage(null);
    setEditingCategory(null);
    setDraft(toDraft());
    setEditorMode('create');
  };

  const openEdit = (category: ProductAdminCategory) => {
    setMessage(null);
    setEditingCategory(category);
    setDraft(toDraft(category));
    setEditorMode('edit');
  };

  const closeEditor = () => {
    if (mutationBusy || createAttemptLocked) return;
    setEditorMode(null);
    setEditingCategory(null);
    setDraft(toDraft());
  };

  const openDelete = (category: ProductAdminCategory) => {
    setMessage(null);
    setDeleteTarget(category);
  };

  const refreshAfterMutation = async (): Promise<boolean> => {
    const refreshed = await loadCategories();
    try {
      await onChanged();
      return refreshed;
    } catch {
      return false;
    }
  };

  const handleCreate = async () => {
    if ((!categoriesLoaded && !createAttemptLocked) || mutationBusy) return;
    if (!draft.name.trim() && !createAttemptLocked) {
      setMessage({ ok: false, text: tOr(t, 'products.category.nameRequired', 'Enter category name') });
      return;
    }

    setSavingEditor(true);
    setMessage(null);
    let createCommitted = false;
    try {
      const draftPayload = { name: draft.name.trim() };
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
          pendingImage: draft.pendingImage ? Object.freeze({ ...draft.pendingImage }) : null,
          idempotencyKey: mutationKeyStore.current.get(JSON.stringify(payload)),
        };
        createAttemptRef.current = attempt;
      }

      const result = await window.electronAPI.pos.productAdmin.createCategory({
        ...attempt.payload,
        idempotencyKey: attempt.idempotencyKey,
      });
      if (!result?.ok || !result.data?.category) {
        if (shouldKeepCategoryCreateAttemptLocked(createAttemptLocked, result || {})) {
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
      let canonicalCategory = result.data.category;
      let warning: string | null = null;
      if (attempt.pendingImage) {
        const uploadResult = await window.electronAPI.pos.productAdmin.uploadCategoryImage(canonicalCategory.id, {
          dataUrl: attempt.pendingImage.dataUrl,
          fileName: attempt.pendingImage.fileName,
          mimeType: attempt.pendingImage.mimeType,
          expectedUpdatedAt: canonicalCategory.updatedAt,
        });
        if (!uploadResult?.ok || !uploadResult.data?.category) {
          warning = uploadResult?.error
            || uploadResult?.code
            || tOr(
              t,
              'products.category.imageUploadFailedAfterCreate',
              'The category was created, but its image could not be uploaded',
            );
        } else {
          canonicalCategory = uploadResult.data.category;
        }
      }

      mutationKeyStore.current.clear();
      createAttemptRef.current = null;
      setCreateAttemptLocked(false);
      setEditorMode(null);
      setDraft(toDraft());
      const refreshed = await refreshAfterMutation();
      setMessage(warning
        ? { ok: false, text: warning }
        : refreshed
          ? { ok: true, text: tOr(t, 'products.category.created', 'Category created') }
          : {
              ok: false,
              text: tOr(
                t,
                'products.category.createdRefreshFailed',
                'Category was created, but categories could not be refreshed',
              ),
            });
    } catch (err: any) {
      if (createCommitted) {
        mutationKeyStore.current.clear();
        createAttemptRef.current = null;
        setCreateAttemptLocked(false);
        setEditorMode(null);
        setDraft(toDraft());
        await refreshAfterMutation();
        setMessage({
          ok: false,
          text: err?.message || tOr(
            t,
            'products.category.imageUploadFailedAfterCreate',
            'The category was created, but its image could not be uploaded',
          ),
        });
      } else {
        setCreateAttemptLocked(true);
        setMessage({
          ok: false,
          text: err?.message || tOr(t, 'products.category.createFailed', 'Could not create category'),
        });
      }
    } finally {
      setSavingEditor(false);
    }
  };

  const handleUpdate = async () => {
    const category = editingCategory;
    if (!category || mutationBusy) return;
    if (!draft.name.trim()) {
      setMessage({ ok: false, text: tOr(t, 'products.category.nameRequired', 'Enter category name') });
      return;
    }

    const nameChanged = draft.name.trim() !== category.name;
    const shouldRemoveImage = draft.removeImage && !!category.imageUrl;
    if (!nameChanged && !shouldRemoveImage && !draft.pendingImage) {
      closeEditor();
      return;
    }

    setSavingEditor(true);
    setMessage(null);
    let canonicalCategory = category;
    let updateCommitted = false;
    try {
      if (nameChanged || shouldRemoveImage) {
        const result = await window.electronAPI.pos.productAdmin.updateCategory(category.id, {
          name: draft.name.trim(),
          ...(shouldRemoveImage ? { imageUrl: null } : {}),
          expectedUpdatedAt: category.updatedAt || undefined,
          expectedVersion: category.version,
        });
        if (!result?.ok || !result.data?.category) {
          const failure = {
            ok: false,
            text: result?.error || result?.code || tOr(t, 'products.category.saveFailed', 'Could not save category'),
          };
          if (result?.status === 409) {
            setEditorMode(null);
            setEditingCategory(null);
            setDraft(toDraft());
            await refreshAfterMutation();
          }
          setMessage(failure);
          return;
        }
        canonicalCategory = result.data.category;
        updateCommitted = true;
      }

      let warning: string | null = null;
      if (draft.pendingImage) {
        const uploadResult = await window.electronAPI.pos.productAdmin.uploadCategoryImage(category.id, {
          dataUrl: draft.pendingImage.dataUrl,
          fileName: draft.pendingImage.fileName,
          mimeType: draft.pendingImage.mimeType,
          expectedUpdatedAt: canonicalCategory.updatedAt,
        });
        if (!uploadResult?.ok || !uploadResult.data?.category) {
          warning = uploadResult?.error
            || uploadResult?.code
            || tOr(t, 'products.category.imageUploadFailed', 'Category saved, but the image could not be uploaded');
        } else {
          canonicalCategory = uploadResult.data.category;
          updateCommitted = true;
        }
      }

      setEditorMode(null);
      setEditingCategory(null);
      setDraft(toDraft());
      const refreshed = await refreshAfterMutation();
      setMessage(warning
        ? { ok: false, text: warning }
        : refreshed
          ? { ok: true, text: tOr(t, 'products.category.saved', 'Category saved') }
          : {
              ok: false,
              text: tOr(t, 'products.category.savedRefreshFailed', 'Category was saved, but categories could not be refreshed'),
            });
    } catch (err: any) {
      if (updateCommitted) {
        setEditorMode(null);
        setEditingCategory(null);
        setDraft(toDraft());
        await refreshAfterMutation();
        setMessage({
          ok: false,
          text: err?.message || tOr(t, 'products.category.imageUploadFailed', 'Category saved, but the image could not be uploaded'),
        });
      } else {
        setMessage({
          ok: false,
          text: err?.message || tOr(t, 'products.category.saveFailed', 'Could not save category'),
        });
      }
    } finally {
      setSavingEditor(false);
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
      const canonicalById = new Map(canonicalCategories.map((category) => [category.id, category]));
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

  const handleDelete = async () => {
    const category = deleteTarget;
    if (!category || mutationBusy) return;
    setDeleting(true);
    setMessage(null);
    try {
      const result = await window.electronAPI.pos.productAdmin.deleteCategory(category.id, {
        expectedUpdatedAt: category.updatedAt,
      });
      if (!result?.ok) {
        const alreadyDeleted =
          result?.status === 404
          || result?.code === 'CATEGORY_NOT_FOUND'
          || result?.code === 'NOT_FOUND';
        if (alreadyDeleted) {
          setDeleteTarget(null);
          const refreshed = await refreshAfterMutation();
          setMessage(refreshed
            ? {
                ok: true,
                text: tOr(
                  t,
                  'products.category.alreadyDeleted',
                  'Category was already removed; the catalog has been refreshed',
                ),
              }
            : {
                ok: false,
                text: tOr(
                  t,
                  'products.category.deletedRefreshFailed',
                  'Category was deleted, but categories could not be refreshed',
                ),
              });
          return;
        }
        const failure = {
          ok: false,
          text: result?.error || result?.code || tOr(t, 'products.category.deleteFailed', 'Could not delete category'),
        };
        if (result?.status === 409) {
          setDeleteTarget(null);
          await refreshAfterMutation();
        }
        setMessage(failure);
        return;
      }
      setDeleteTarget(null);
      const refreshed = await refreshAfterMutation();
      setMessage(refreshed
        ? { ok: true, text: tOr(t, 'products.category.deleted', 'Category deleted') }
        : {
            ok: false,
            text: tOr(
              t,
              'products.category.deletedRefreshFailed',
              'Category was deleted, but categories could not be refreshed',
            ),
          });
    } catch (err: any) {
      setMessage({
        ok: false,
        text: err?.message || tOr(t, 'products.category.deleteFailed', 'Could not delete category'),
      });
    } finally {
      setDeleting(false);
    }
  };

  const parentModalBusy =
    mutationBusy || editorMode !== null || deleteTarget !== null || createAttemptLocked;

  return (
    <>
      <Modal
        open
        keyboardAware
        size="full"
        zLayer="nested"
        title={tOr(t, 'products.category.title', 'Manage categories')}
        onClose={onClose}
        busy={parentModalBusy}
        panelClassName="sm:max-w-[820px]"
        closeLabel={tOr(t, 'products.drawer.close', 'Close')}
      >
        <div className="min-h-0 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-slate-600">
              {localCategoryCount} {tOr(t, 'products.category.localCount', 'categories are currently in the local POS catalog filter.')}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void loadCategories()}
                disabled={mutationBusy}
                className="flex h-11 w-11 items-center justify-center rounded-md border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                title={tOr(t, 'orders.refresh', 'Refresh')}
                aria-label={tOr(t, 'orders.refresh', 'Refresh')}
              >
                <RefreshCw size={17} className={loading ? 'animate-spin motion-reduce:animate-none' : ''} />
              </button>
              {canCreateCategory ? (
                <button
                  type="button"
                  onClick={openCreate}
                  disabled={mutationBusy || !categoriesLoaded}
                  className="inline-flex h-11 items-center gap-2 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  <Plus size={17} />
                  {tOr(t, 'products.category.new', 'New category')}
                </button>
              ) : null}
            </div>
          </div>

          <div className="mb-4 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
            {tOr(
              t,
              'products.category.backendHelp',
              'Category names, images, order, and deletions are saved to Product Admin backend and synced to other POS devices.',
            )}
          </div>

          {message ? (
            <div role={message.ok ? 'status' : 'alert'} className={`mb-4 rounded-md border px-3 py-2 text-sm ${
              message.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'
            }`}>
              {message.text}
            </div>
          ) : null}

          <div className="mb-2 flex items-center justify-between px-1 text-xs font-semibold uppercase text-slate-500">
            <span>{tOr(t, 'products.category.title', 'Manage categories')}</span>
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
              {tOr(t, 'products.category.emptyAdmin', 'No backend categories returned. Create the first category here.')}
            </div>
          ) : (
            <div className="space-y-2">
              {categories.map((category, index) => (
                <CategoryRow
                  key={category.id}
                  category={category}
                  index={index}
                  total={categories.length}
                  productCount={category.productCount ?? localProductCounts[category.id] ?? 0}
                  t={t}
                  canUpdateCategory={canUpdateCategory}
                  canReorderCategory={canReorderCategory}
                  canDeleteCategory={canDeleteCategory}
                  mutationDisabled={mutationBusy || !categoriesLoaded}
                  onMove={handleMove}
                  onEdit={openEdit}
                  onDelete={openDelete}
                />
              ))}
            </div>
          )}
        </div>
      </Modal>

      {editorMode ? (
        <CategoryEditorDialog
          mode={editorMode}
          category={editingCategory}
          draft={draft}
          setDraft={setDraft}
          t={t}
          busy={savingEditor}
          createAttemptLocked={createAttemptLocked}
          supportsImageUpload={supportsImageUpload}
          message={message}
          onClose={closeEditor}
          onSave={() => void (editorMode === 'create' ? handleCreate() : handleUpdate())}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteCategoryDialog
          category={deleteTarget}
          productCount={deleteTarget.productCount ?? localProductCounts[deleteTarget.id] ?? 0}
          t={t}
          busy={deleting}
          message={message}
          onClose={() => {
            if (!deleting) setDeleteTarget(null);
          }}
          onConfirm={() => void handleDelete()}
        />
      ) : null}
    </>
  );
}
