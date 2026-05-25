import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowRightLeft,
  ArrowUpRight,
  ClipboardCheck,
  FileText,
  PackageSearch,
  Plus,
  RefreshCw,
  Save,
  ScanBarcode,
  Trash2,
} from 'lucide-react';
import { resolveName } from '../../../shared/catalog-names';
import type {
  WarehouseCapabilities,
  WarehouseDocument,
  WarehouseDocumentCreateInput,
  WarehouseDocumentLineInput,
  WarehouseInfo,
  WarehouseInventoryCount,
  WarehouseInventoryCountCreateInput,
  WarehouseInventoryCountLineInput,
} from '../../../shared/types';
import { Language } from '../../i18n/translations';
import { useTranslation } from '../../i18n/useTranslation';
import type { Product } from '../../hooks/usePosDb';
import rlog from '../../utils/logger';

type WarehouseDocType = 'PZ' | 'WZ' | 'RW' | 'PW' | 'MM' | 'INW';

interface WarehouseModuleProps {
  language: Language;
}

interface DraftLine {
  id: string;
  variantId: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  unit: string;
  bookStock: number;
  quantity: number;
  countedQuantity: number;
  unitValueGrosze: number;
}

const DOC_TYPES: Array<{
  type: WarehouseDocType;
  label: string;
  tone: string;
  icon: React.ReactNode;
}> = [
  { type: 'PZ', label: 'PZ', tone: 'emerald', icon: <ArrowDownLeft size={18} /> },
  { type: 'WZ', label: 'WZ', tone: 'rose', icon: <ArrowUpRight size={18} /> },
  { type: 'RW', label: 'RW', tone: 'amber', icon: <ArrowUpRight size={18} /> },
  { type: 'PW', label: 'PW', tone: 'sky', icon: <ArrowDownLeft size={18} /> },
  { type: 'MM', label: 'MM', tone: 'violet', icon: <ArrowRightLeft size={18} /> },
  { type: 'INW', label: 'Spis', tone: 'slate', icon: <ClipboardCheck size={18} /> },
];

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function numberOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatMoney(amountGrosze: number, currency: string): string {
  return `${((Number(amountGrosze) || 0) / 100).toFixed(2)} ${currency}`;
}

function formatMoneyInput(amountGrosze: number): string {
  const value = (Number(amountGrosze) || 0) / 100;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function parseMoneyToGrosze(value: string): number {
  const amount = Number(value.replace(',', '.'));
  return Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100)) : 0;
}

function formatQty(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function createLine(product: Product, quantity: number): DraftLine {
  const stock = numberOrZero(product.available_qty ?? product.in_stock);
  return {
    id: `${product.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    variantId: product.id,
    name: product.name,
    sku: product.sku,
    barcode: product.barcode,
    unit: product.sale_unit || 'szt',
    bookStock: stock,
    quantity,
    countedQuantity: quantity,
    unitValueGrosze: numberOrZero(product.price_gross || product.retail_price),
  };
}

function lineDelta(type: WarehouseDocType, line: DraftLine): number {
  if (type === 'PZ' || type === 'PW') return line.quantity;
  if (type === 'WZ' || type === 'RW') return -line.quantity;
  if (type === 'MM') return line.quantity;
  return line.countedQuantity - line.bookStock;
}

function documentEffectLabel(type: WarehouseDocType): string {
  if (type === 'PZ') return '+ stock';
  if (type === 'PW') return '+ internal';
  if (type === 'WZ') return '- external';
  if (type === 'RW') return '- internal';
  if (type === 'MM') return 'transfer';
  return 'count';
}

interface WarehouseLineRowProps {
  line: DraftLine;
  docType: WarehouseDocType;
  language: string;
  currency: string;
  removeLabel: string;
  onUpdate: (lineId: string, patch: Partial<Pick<DraftLine, 'quantity' | 'countedQuantity' | 'unitValueGrosze'>>) => void;
  onRemove: (lineId: string) => void;
}

// Memoized so typing in a quantity input only re-renders the touched row
// instead of all lines (every keystroke calls setLines). onUpdate/onRemove
// must be stable (useCallback) for the memo to actually skip work.
const WarehouseLineRow = React.memo(function WarehouseLineRow({
  line,
  docType,
  language,
  currency,
  removeLabel,
  onUpdate,
  onRemove,
}: WarehouseLineRowProps) {
  const delta = lineDelta(docType, line);
  const isInventory = docType === 'INW';
  const displayQty = isInventory ? line.countedQuantity : line.quantity;

  return (
    <tr className="bg-white">
      <td className="border-b border-slate-100 px-4 py-3">
        <div className="truncate text-sm font-semibold text-slate-950">{resolveName(line as any, language) || line.name}</div>
        <div className="mt-1 text-xs text-slate-500">{line.unit}</div>
      </td>
      <td className="border-b border-slate-100 px-3 py-3 text-sm tabular-nums text-slate-700">{formatQty(line.bookStock)}</td>
      <td className="border-b border-slate-100 px-3 py-3">
        <input
          value={displayQty}
          onChange={(event) => {
            const value = numberOrZero(event.target.value);
            onUpdate(line.id, isInventory ? { countedQuantity: value } : { quantity: value });
          }}
          className="h-10 w-full rounded-md border border-slate-300 px-2 text-sm font-semibold tabular-nums text-slate-950 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          inputMode="decimal"
        />
      </td>
      <td className={`border-b border-slate-100 px-3 py-3 text-sm font-semibold tabular-nums ${
        delta > 0 ? 'text-emerald-700' : delta < 0 ? 'text-rose-700' : 'text-slate-500'
      }`}>
        {delta > 0 ? '+' : ''}{formatQty(delta)}
      </td>
      <td className="border-b border-slate-100 px-3 py-3 text-xs text-slate-600">
        <div className="truncate font-mono">{line.barcode || '-'}</div>
        <div className="truncate font-mono text-slate-400">{line.sku || '-'}</div>
      </td>
      <td className="border-b border-slate-100 px-3 py-3">
        <input
          type="number"
          min="0"
          step="0.01"
          value={formatMoneyInput(line.unitValueGrosze)}
          onChange={(event) => onUpdate(line.id, { unitValueGrosze: parseMoneyToGrosze(event.target.value) })}
          className="h-10 w-full rounded-md border border-slate-300 px-2 text-sm font-semibold tabular-nums text-slate-950 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          inputMode="decimal"
        />
        <div className="mt-1 truncate text-xs tabular-nums text-slate-500">
          {formatMoney(Math.abs(delta) * line.unitValueGrosze, currency)}
        </div>
      </td>
      <td className="border-b border-slate-100 px-2 py-3">
        <button
          type="button"
          onClick={() => onRemove(line.id)}
          className="flex h-10 w-10 items-center justify-center rounded-md text-slate-500 transition hover:bg-rose-50 hover:text-rose-700"
          title={removeLabel}
        >
          <Trash2 size={17} />
        </button>
      </td>
    </tr>
  );
});

export default function WarehouseModule({ language }: WarehouseModuleProps) {
  const { t } = useTranslation(language);
  const scanRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState<WarehouseDocType>('PZ');
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [backendMessage, setBackendMessage] = useState<string | null>(null);
  const [backendStatus, setBackendStatus] = useState<'unknown' | 'ready' | 'unavailable'>('unknown');
  const [warehouseCapabilities, setWarehouseCapabilities] = useState<WarehouseCapabilities | null>(null);
  const [barcode, setBarcode] = useState('');
  const [scanQuantity, setScanQuantity] = useState(1);
  const [warehouseCode, setWarehouseCode] = useState('MAIN');
  const [targetWarehouseCode, setTargetWarehouseCode] = useState('');
  const [sourceDocumentNo, setSourceDocumentNo] = useState('');
  const [contractorName, setContractorName] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftNumber, setDraftNumber] = useState<string | null>(null);
  const [draftKind, setDraftKind] = useState<'document' | 'inventory' | null>(null);
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);

  const currency = tOr(t, 'pos.currency', 'zl');
  const removeLineLabel = tOr(t, 'warehouse.remove', 'Remove');
  const selectedType = DOC_TYPES.find((item) => item.type === docType) || DOC_TYPES[0];
  const isDocTypeAvailable = useCallback((type: WarehouseDocType): boolean => {
    if (!warehouseCapabilities) return true;
    if (type === 'INW') return warehouseCapabilities.canCreateInventoryCount;
    return warehouseCapabilities.supportedDocumentTypes?.includes(type) === true;
  }, [warehouseCapabilities]);
  const isSelectedTypeSupported = useMemo(() => {
    if (!warehouseCapabilities) return false;
    if (docType === 'INW') {
      return warehouseCapabilities.canCreateInventoryCount
        && warehouseCapabilities.canSetInventoryLines
        && warehouseCapabilities.canPostInventory;
    }
    return warehouseCapabilities.supportedDocumentTypes?.includes(docType)
      && warehouseCapabilities.canCreateDocument
      && warehouseCapabilities.canSetDocumentLines
      && warehouseCapabilities.canPostDocument;
  }, [docType, warehouseCapabilities]);
  const canUseWarehouseBackend = backendStatus === 'ready' && isSelectedTypeSupported;
  const backendActionTitle = !canUseWarehouseBackend
    ? backendStatus === 'unknown'
      ? tOr(t, 'warehouse.backendChecking', 'Checking warehouse backend...')
      : backendStatus === 'ready'
        ? warehouseCapabilities
          ? tOr(t, 'warehouse.documentUnsupportedShort', 'Document type unsupported')
          : tOr(t, 'warehouse.contractUnsupportedShort', 'Document contract pending')
        : tOr(t, 'warehouse.backendRequiredShort', 'Backend required')
    : undefined;
  const backendActionDisabled = !canUseWarehouseBackend || saving || posting || lines.length === 0;

  // O(1) lookup by id OR code — findWarehouse used to do .find() on every call,
  // and the module calls it 3-4 times per render (label, select fallback, summary).
  const warehouseByKey = useMemo(() => {
    const map = new Map<string, WarehouseInfo>();
    for (const warehouse of warehouses) {
      if (warehouse.id) map.set(warehouse.id, warehouse);
      if (warehouse.code) map.set(warehouse.code, warehouse);
    }
    return map;
  }, [warehouses]);

  const findWarehouse = (value: string): WarehouseInfo | undefined => warehouseByKey.get(value);

  const warehouseLabel = (value: string): string => {
    const warehouse = findWarehouse(value);
    return warehouse?.code || value || '-';
  };

  const warehouseRef = (value: string): { warehouseId?: string; warehouseCode?: string } => {
    const trimmed = value.trim();
    const warehouse = findWarehouse(trimmed);
    return {
      warehouseId: warehouse?.id,
      warehouseCode: warehouse?.code || trimmed || undefined,
    };
  };

  const loadProducts = async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const rows = await window.electronAPI.pos.products.getAll();
      setProducts((rows || []) as Product[]);
    } catch (err: any) {
      rlog.warn('[WarehouseModule] failed to load products', err?.message || err);
      setError(err?.message || 'warehouse.loadFailed');
    } finally {
      setLoading(false);
    }
  };

  const loadWarehouses = async () => {
    const warehousesApi = window.electronAPI?.warehouse?.warehouses;
    if (!warehousesApi?.list) {
      setBackendStatus('unavailable');
      setBackendMessage(tOr(t, 'warehouse.backendUnavailable', 'Warehouse backend is not available in this build.'));
      setWarehouseCapabilities(null);
      return;
    }

    try {
      const result = await warehousesApi.list();
      if (!result.success || !result.data?.warehouses?.length) {
        setBackendStatus('unavailable');
        setBackendMessage(result.error || tOr(t, 'warehouse.backendUnavailable', 'Warehouse backend is not available yet.'));
        setWarehouseCapabilities(null);
        return;
      }

      const list: WarehouseInfo[] = (result.data.warehouses as WarehouseInfo[])
        .filter((warehouse: WarehouseInfo) => warehouse.isActive !== false);
      setWarehouses(list);
      setBackendStatus('ready');
      setBackendMessage(null);
      const preferred = list.find((warehouse: WarehouseInfo) => warehouse.isDefault) || list[0];
      if (preferred && (warehouseCode === 'MAIN' || !warehouseCode.trim())) {
        setWarehouseCode(preferred.id || preferred.code);
      }

      const capabilitiesApi = window.electronAPI?.warehouse?.capabilities;
      if (!capabilitiesApi) {
        setWarehouseCapabilities(null);
        setBackendMessage(tOr(t, 'warehouse.contractUnsupported', 'Warehouse list is available, but desktop document posting is paused until the app supports the live accounting routes.'));
        return;
      }

      const capabilitiesResult = await capabilitiesApi();
      if (!capabilitiesResult.success || !capabilitiesResult.data) {
        setWarehouseCapabilities(null);
        setBackendMessage(tOr(t, 'warehouse.contractUnsupported', 'Warehouse list is available, but desktop document posting is paused until the app supports the live accounting routes.'));
        return;
      }

      setWarehouseCapabilities(capabilitiesResult.data);
      setBackendMessage(null);
    } catch (err: any) {
      rlog.warn('[WarehouseModule] failed to load warehouses', err?.message || err);
      setBackendStatus('unavailable');
      setBackendMessage(err?.message || tOr(t, 'warehouse.backendUnavailable', 'Warehouse backend is not available yet.'));
      setWarehouseCapabilities(null);
    }
  };

  useEffect(() => {
    void loadProducts(false);
    void loadWarehouses();
    const unsubscribe = window.electronAPI.pos.sync.onProductsSynced(() => void loadProducts(true));
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    scanRef.current?.focus();
  }, [docType]);

  useEffect(() => {
    if (!warehouseCapabilities || isDocTypeAvailable(docType)) return;
    const fallback = DOC_TYPES.find((item) => isDocTypeAvailable(item.type));
    if (fallback) setDocType(fallback.type);
  }, [docType, isDocTypeAvailable, warehouseCapabilities]);

  useEffect(() => {
    setDraftId(null);
    setDraftNumber(null);
    setDraftKind(null);
    setBackendMessage(null);
  }, [docType]);

  const productByCode = useMemo(() => {
    const map = new Map<string, Product>();
    for (const product of products) {
      if (product.barcode) map.set(product.barcode, product);
      if (product.sku) map.set(product.sku, product);
    }
    return map;
  }, [products]);

  const totals = useMemo(() => {
    let quantity = 0;
    let value = 0;
    let positive = 0;
    let negative = 0;
    for (const line of lines) {
      const delta = lineDelta(docType, line);
      quantity += docType === 'INW' ? Math.abs(delta) : line.quantity;
      value += Math.abs(delta) * line.unitValueGrosze;
      if (delta > 0) positive += delta;
      if (delta < 0) negative += Math.abs(delta);
    }
    return { quantity, value, positive, negative };
  }, [docType, lines]);

  const addProduct = async (codeOverride?: string) => {
    const code = (codeOverride ?? barcode).trim();
    if (!code) {
      setError(tOr(t, 'warehouse.scanMissing', 'Enter or scan a barcode first'));
      return;
    }
    const quantity = Math.max(0.001, numberOrZero(scanQuantity) || 1);
    setError(null);
    let product = productByCode.get(code) || null;
    if (!product) {
      try {
        product = await window.electronAPI.pos.products.getByBarcode(code);
      } catch (err: any) {
        rlog.warn('[WarehouseModule] barcode lookup failed', err?.message || err);
      }
    }
    if (!product) {
      setError(tOr(t, 'warehouse.scanNotFound', 'Product not found in POS catalog'));
      return;
    }

    setLines((current) => {
      const existing = current.find((line) => line.variantId === product!.id);
      if (existing) {
        return current.map((line) => {
          if (line.variantId !== product!.id) return line;
          return docType === 'INW'
            ? { ...line, countedQuantity: line.countedQuantity + quantity }
            : { ...line, quantity: line.quantity + quantity };
        });
      }
      return [...current, createLine(product!, quantity)];
    });
    setBarcode('');
    requestAnimationFrame(() => scanRef.current?.focus());
  };

  // Stable identity so memoized line rows skip re-renders when other rows change.
  const updateLine = useCallback(
    (lineId: string, patch: Partial<Pick<DraftLine, 'quantity' | 'countedQuantity' | 'unitValueGrosze'>>) => {
      setLines((current) => current.map((line) => line.id === lineId ? { ...line, ...patch } : line));
    },
    [],
  );

  const removeLine = useCallback((lineId: string) => {
    setLines((current) => current.filter((line) => line.id !== lineId));
  }, []);

  const clearDocument = () => {
    setLines([]);
    setSourceDocumentNo('');
    setContractorName('');
    setNotes('');
    setDraftId(null);
    setDraftNumber(null);
    setDraftKind(null);
    setError(null);
    requestAnimationFrame(() => scanRef.current?.focus());
  };

  const validateDocument = (): boolean => {
    if (lines.length === 0) {
      setError(tOr(t, 'warehouse.noLines', 'Add at least one product line first.'));
      return false;
    }
    if (!warehouseCode.trim()) {
      setError(tOr(t, 'warehouse.warehouseRequired', 'Warehouse is required.'));
      return false;
    }
    if ((docType === 'PZ' || docType === 'WZ') && !contractorName.trim()) {
      setError(tOr(t, 'warehouse.contractorRequired', 'Contractor/receiver is required for PZ/WZ.'));
      return false;
    }
    if (docType === 'MM') {
      if (!targetWarehouseCode.trim()) {
        setError(tOr(t, 'warehouse.targetRequired', 'Target warehouse is required for MM.'));
        return false;
      }
      const source = warehouseRef(warehouseCode);
      const target = warehouseRef(targetWarehouseCode);
      if ((source.warehouseId && source.warehouseId === target.warehouseId) || source.warehouseCode === target.warehouseCode) {
        setError(tOr(t, 'warehouse.targetDifferent', 'Source and target warehouse must be different.'));
        return false;
      }
    }
    return true;
  };

  const ensureWarehouseBackendReady = (): boolean => {
    if (canUseWarehouseBackend) return true;
    const message = backendActionTitle || tOr(t, 'warehouse.backendRequiredShort', 'Backend required');
    setError(message);
    setBackendMessage(message);
    return false;
  };

  const buildDocumentLines = (): WarehouseDocumentLineInput[] => lines.map((line) => ({
    productVariantId: line.variantId,
    sku: line.sku,
    barcode: line.barcode,
    name: line.name,
    unit: line.unit,
    quantity: docType === 'INW' ? Math.max(0, line.countedQuantity) : Math.max(0, line.quantity),
    countedQuantity: docType === 'INW' ? Math.max(0, line.countedQuantity) : undefined,
    unitCostGrosze: Math.round(numberOrZero(line.unitValueGrosze)),
    bookStock: line.bookStock,
  }));

  const buildInventoryLines = (): WarehouseInventoryCountLineInput[] => lines.map((line) => ({
    productVariantId: line.variantId,
    sku: line.sku,
    barcode: line.barcode,
    name: line.name,
    unit: line.unit,
    bookStock: line.bookStock,
    countedQuantity: Math.max(0, line.countedQuantity),
    unitCostGrosze: Math.round(numberOrZero(line.unitValueGrosze)),
  }));

  const buildDocumentPayload = (): WarehouseDocumentCreateInput => {
    const sourceWarehouse = warehouseRef(warehouseCode);
    const targetWarehouse = warehouseRef(targetWarehouseCode);
    return {
      type: docType,
      warehouseId: sourceWarehouse.warehouseId,
      warehouseCode: sourceWarehouse.warehouseCode,
      targetWarehouseId: docType === 'MM' ? targetWarehouse.warehouseId : undefined,
      targetWarehouseCode: docType === 'MM' ? targetWarehouse.warehouseCode : undefined,
      contractorName: contractorName.trim() || undefined,
      sourceDocumentNo: sourceDocumentNo.trim() || undefined,
      issueDate: new Date().toISOString(),
      operationDate: new Date().toISOString(),
      notes: notes.trim() || undefined,
      lines: buildDocumentLines(),
      idempotencyKey: `warehouse-${docType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
  };

  const buildInventoryPayload = (): WarehouseInventoryCountCreateInput => {
    const sourceWarehouse = warehouseRef(warehouseCode);
    return {
      warehouseId: sourceWarehouse.warehouseId,
      warehouseCode: sourceWarehouse.warehouseCode,
      notes: notes.trim() || undefined,
      lines: buildInventoryLines(),
      idempotencyKey: `inventory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
  };

  const handleBackendFailure = (result: { error?: string; code?: string }) => {
    const message = result.error || tOr(t, 'warehouse.saveFailed', 'Warehouse backend rejected the request.');
    setError(message);
    if (result.code === 'WAREHOUSE_BACKEND_UNAVAILABLE' || result.code === 'NOT_AUTHENTICATED') {
      setBackendStatus('unavailable');
      setBackendMessage(message);
    }
  };

  const saveDraft = async (): Promise<{ id: string; kind: 'document' | 'inventory' } | null> => {
    if (!validateDocument()) return null;
    if (!ensureWarehouseBackendReady()) return null;
    setSaving(true);
    setError(null);
    setBackendMessage(null);

    try {
      if (docType === 'INW') {
        let result;
        let createdNumber: string | null = null;
        if (draftId && draftKind === 'inventory') {
          result = await window.electronAPI.warehouse.inventory.setLines(draftId, buildInventoryLines());
        } else {
          const createResult = await window.electronAPI.warehouse.inventory.create(buildInventoryPayload());
          if (!createResult.success || !createResult.data?.id) {
            handleBackendFailure(createResult);
            return null;
          }
          const created = createResult.data as WarehouseInventoryCount;
          createdNumber = created.number || null;
          setDraftId(created.id);
          setDraftNumber(createdNumber);
          setDraftKind('inventory');
          result = await window.electronAPI.warehouse.inventory.setLines(created.id, buildInventoryLines());
        }
        if (!result.success || !result.data?.id) {
          handleBackendFailure(result);
          return null;
        }
        const count = result.data as WarehouseInventoryCount;
        setDraftId(count.id);
        setDraftNumber(count.number || createdNumber || draftNumber || null);
        setDraftKind('inventory');
        setBackendStatus('ready');
        setBackendMessage(tOr(t, 'warehouse.draftSaved', 'Draft saved on backend.'));
        return { id: count.id, kind: 'inventory' };
      }

      const payload = buildDocumentPayload();
      let result;
      let createdNumber: string | null = null;
      if (draftId && draftKind === 'document') {
        const updateResult = await window.electronAPI.warehouse.documents.update(draftId, {
          warehouseId: payload.warehouseId,
          warehouseCode: payload.warehouseCode,
          targetWarehouseId: payload.targetWarehouseId,
          targetWarehouseCode: payload.targetWarehouseCode,
          contractorName: payload.contractorName,
          sourceDocumentNo: payload.sourceDocumentNo,
          issueDate: payload.issueDate,
          operationDate: payload.operationDate,
          notes: payload.notes,
        });
        if (!updateResult.success) {
          handleBackendFailure(updateResult);
          return null;
        }
        result = await window.electronAPI.warehouse.documents.setLines(draftId, payload.lines || []);
      } else {
        const createResult = await window.electronAPI.warehouse.documents.create(payload);
        if (!createResult.success || !createResult.data?.id) {
          handleBackendFailure(createResult);
          return null;
        }
        const created = createResult.data as WarehouseDocument;
        createdNumber = created.number || null;
        setDraftId(created.id);
        setDraftNumber(createdNumber);
        setDraftKind('document');
        result = await window.electronAPI.warehouse.documents.setLines(created.id, payload.lines || []);
      }

      if (!result.success || !result.data?.id) {
        handleBackendFailure(result);
        return null;
      }

      const document = result.data as WarehouseDocument;
      setDraftId(document.id);
      setDraftNumber(document.number || createdNumber || draftNumber || null);
      setDraftKind('document');
      setBackendStatus('ready');
      setBackendMessage(tOr(t, 'warehouse.draftSaved', 'Draft saved on backend.'));
      return { id: document.id, kind: 'document' };
    } catch (err: any) {
      rlog.warn('[WarehouseModule] save draft failed', err?.message || err);
      setError(err?.message || tOr(t, 'warehouse.saveFailed', 'Could not save draft.'));
      return null;
    } finally {
      setSaving(false);
    }
  };

  const postDocument = async () => {
    const saved = await saveDraft();
    if (!saved) return;

    setPosting(true);
    setError(null);
    try {
      const result = saved.kind === 'inventory'
        ? await window.electronAPI.warehouse.inventory.post(saved.id)
        : await window.electronAPI.warehouse.documents.post(saved.id);

      if (!result.success || !result.data) {
        handleBackendFailure(result);
        return;
      }

      const posted: any = result.data;
      setDraftId(posted.id || saved.id);
      setDraftNumber(posted.number || draftNumber || null);
      setBackendStatus('ready');
      setBackendMessage(tOr(t, 'warehouse.posted', 'Document posted. Product sync will refresh stock.'));
      void loadProducts(true);
      void window.electronAPI.pos.sync.products().catch(() => undefined);
    } catch (err: any) {
      rlog.warn('[WarehouseModule] post document failed', err?.message || err);
      setError(err?.message || tOr(t, 'warehouse.postFailed', 'Could not post document.'));
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="flex h-[calc(100vh-2rem)] min-h-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-950">{tOr(t, 'warehouse.title', 'Magazyn')}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {tOr(t, 'warehouse.subtitle', 'Warehouse document workspace for PZ, WZ, RW, PW, MM, and inventory count.')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-slate-600">
          <span className="rounded-md border border-slate-200 bg-white px-3 py-2">{lines.length} {tOr(t, 'warehouse.lines', 'lines')}</span>
          <span className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-700">+{formatQty(totals.positive)}</span>
          <span className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">-{formatQty(totals.negative)}</span>
          <span className="rounded-md border border-slate-200 bg-white px-3 py-2">{formatMoney(totals.value, currency)}</span>
        </div>
      </header>

      <section className="grid gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {DOC_TYPES.map((item) => {
              const active = item.type === docType;
              const available = isDocTypeAvailable(item.type);
              return (
                <button
                  key={item.type}
                  type="button"
                  onClick={() => { if (available) setDocType(item.type); }}
                  disabled={!available}
                  title={!available ? tOr(t, 'warehouse.documentUnsupportedShort', 'Document type unsupported') : undefined}
                  className={`inline-flex h-11 items-center gap-2 rounded-md border px-3 text-sm font-semibold transition ${
                    active
                      ? 'border-brand-600 bg-brand-50 text-brand-700'
                      : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  {item.icon}
                  {item.label}
                </button>
              );
            })}
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase text-slate-500">{tOr(t, 'warehouse.type', 'Type')}</span>
              <div className="flex h-11 items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-900">
                {selectedType.icon}
                {docType} · {documentEffectLabel(docType)}
              </div>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase text-slate-500">{tOr(t, 'warehouse.warehouse', 'Warehouse')}</span>
              {warehouses.length > 0 ? (
                <select
                  value={warehouseCode}
                  onChange={(event) => setWarehouseCode(event.target.value)}
                  className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                >
                  {!findWarehouse(warehouseCode) ? <option value={warehouseCode}>{warehouseCode}</option> : null}
                  {warehouses.map((warehouse) => (
                    <option key={warehouse.id} value={warehouse.id}>
                      {warehouse.code} - {warehouse.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={warehouseCode}
                  onChange={(event) => setWarehouseCode(event.target.value)}
                  className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                />
              )}
            </label>
            {docType === 'MM' ? (
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase text-slate-500">{tOr(t, 'warehouse.targetWarehouse', 'Target warehouse')}</span>
                {warehouses.length > 0 ? (
                  <select
                    value={targetWarehouseCode}
                    onChange={(event) => setTargetWarehouseCode(event.target.value)}
                    className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                  >
                    <option value="">-</option>
                    {warehouses.map((warehouse) => (
                      <option key={warehouse.id} value={warehouse.id}>
                        {warehouse.code} - {warehouse.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={targetWarehouseCode}
                    onChange={(event) => setTargetWarehouseCode(event.target.value)}
                    className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                  />
                )}
              </label>
            ) : (
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase text-slate-500">{tOr(t, 'warehouse.sourceDoc', 'Source document')}</span>
                <input
                  value={sourceDocumentNo}
                  onChange={(event) => setSourceDocumentNo(event.target.value)}
                  className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm text-slate-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                  placeholder="FV / WZ / note"
                />
              </label>
            )}
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase text-slate-500">{docType === 'WZ' ? tOr(t, 'warehouse.receiver', 'Receiver') : tOr(t, 'warehouse.contractor', 'Contractor')}</span>
              <input
                value={contractorName}
                onChange={(event) => setContractorName(event.target.value)}
                className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm text-slate-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
            </label>
          </div>
        </div>

        <div className={`rounded-md border p-3 text-sm ${
          canUseWarehouseBackend
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
            : 'border-amber-200 bg-amber-50 text-amber-800'
        }`}>
          <div className="flex gap-2">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <span>
              {backendMessage || (
                backendStatus === 'ready'
                  ? warehouseCapabilities && isSelectedTypeSupported
                    ? tOr(t, 'warehouse.backendReady', 'Warehouse backend responded. Drafts and posting will be sent to the server.')
                    : warehouseCapabilities
                      ? tOr(t, 'warehouse.documentUnsupported', 'This document type is not enabled by the warehouse backend.')
                      : tOr(t, 'warehouse.contractUnsupported', 'Warehouse list is available, but desktop document posting is paused until the app supports the live accounting routes.')
                  : backendStatus === 'unknown'
                    ? tOr(t, 'warehouse.backendChecking', 'Checking warehouse backend...')
                  : tOr(t, 'warehouse.backendRequired', 'Posting and official print require backend warehouse-document support. This draft does not change stock.')
              )}
            </span>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
        <div className="grid gap-3 lg:grid-cols-[minmax(220px,1fr)_140px_auto_auto]">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase text-slate-500">{tOr(t, 'warehouse.scan', 'Scan')}</span>
            <div className="relative">
              <ScanBarcode size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                ref={scanRef}
                value={barcode}
                onChange={(event) => setBarcode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void addProduct();
                  }
                }}
                className="h-12 w-full rounded-md border border-slate-300 pl-10 pr-3 text-base font-semibold tracking-wide text-slate-950 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                autoComplete="off"
              />
            </div>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase text-slate-500">{tOr(t, 'warehouse.qty', 'Qty')}</span>
            <input
              value={scanQuantity}
              onChange={(event) => setScanQuantity(numberOrZero(event.target.value))}
              className="h-12 w-full rounded-md border border-slate-300 px-3 text-base font-semibold tabular-nums text-slate-950 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              inputMode="decimal"
            />
          </label>
          <button
            type="button"
            onClick={() => void addProduct()}
            className="mt-5 inline-flex h-12 items-center justify-center gap-2 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white transition hover:bg-brand-700"
          >
            <Plus size={18} />
            {tOr(t, 'warehouse.addLine', 'Add')}
          </button>
          <button
            type="button"
            onClick={() => void loadProducts(false)}
            disabled={loading}
            className="mt-5 inline-flex h-12 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
          >
            <RefreshCw size={17} className={loading ? 'animate-spin' : ''} />
            {tOr(t, 'orders.refresh', 'Refresh')}
          </button>
        </div>
        {error ? (
          <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        ) : null}
      </section>

      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="min-h-0 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          {loading && lines.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">{tOr(t, 'warehouse.loading', 'Loading catalog...')}</div>
          ) : lines.length === 0 ? (
            <div className="flex h-full items-center justify-center text-center">
              <div className="px-6">
                <PackageSearch size={42} className="mx-auto mb-3 text-slate-300" />
                <div className="text-sm font-medium text-slate-600">{tOr(t, 'warehouse.empty', 'No lines yet')}</div>
              </div>
            </div>
          ) : (
            <div className="h-full overflow-auto">
              <table className="min-w-full table-fixed border-separate border-spacing-0">
                <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
                  <tr>
                    <th className="w-[34%] border-b border-slate-200 px-4 py-3">{tOr(t, 'warehouse.product', 'Product')}</th>
                    <th className="w-[13%] border-b border-slate-200 px-3 py-3">{tOr(t, 'warehouse.bookStock', 'Book stock')}</th>
                    <th className="w-[13%] border-b border-slate-200 px-3 py-3">{docType === 'INW' ? tOr(t, 'warehouse.counted', 'Counted') : tOr(t, 'warehouse.qty', 'Qty')}</th>
                    <th className="w-[12%] border-b border-slate-200 px-3 py-3">{tOr(t, 'warehouse.delta', 'Delta')}</th>
                    <th className="w-[16%] border-b border-slate-200 px-3 py-3">{tOr(t, 'warehouse.code', 'Code')}</th>
                    <th className="w-[10%] border-b border-slate-200 px-3 py-3">{tOr(t, 'warehouse.unitCost', 'Unit cost')}</th>
                    <th className="w-[52px] border-b border-slate-200 px-2 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <WarehouseLineRow
                      key={line.id}
                      line={line}
                      docType={docType}
                      language={language}
                      currency={currency}
                      removeLabel={removeLineLabel}
                      onUpdate={updateLine}
                      onRemove={removeLine}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="flex min-h-0 flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">{tOr(t, 'warehouse.summary', 'Summary')}</div>
            <div className="mt-1 text-lg font-semibold text-slate-950">{docType} - {warehouseLabel(warehouseCode)}</div>
            {docType === 'MM' ? <div className="text-sm text-slate-500">-&gt; {warehouseLabel(targetWarehouseCode)}</div> : null}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs font-semibold uppercase text-slate-500">{tOr(t, 'warehouse.qty', 'Qty')}</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-slate-950">{formatQty(totals.quantity)}</div>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs font-semibold uppercase text-slate-500">{tOr(t, 'warehouse.value', 'Value')}</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-slate-950">{formatMoney(totals.value, currency)}</div>
            </div>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase text-slate-500">{tOr(t, 'warehouse.notes', 'Notes')}</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              className="min-h-[96px] w-full resize-none rounded-md border border-slate-300 p-3 text-sm text-slate-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </label>

          <div className="mt-auto space-y-2">
            {draftId ? (
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                {tOr(t, 'warehouse.backendDraft', 'Backend draft')}: {draftNumber || draftId.slice(0, 8)}
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => void saveDraft()}
              disabled={backendActionDisabled}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md border border-brand-200 bg-white px-4 text-sm font-semibold text-brand-700 transition hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50"
              title={backendActionTitle}
            >
              <Save size={18} />
              {saving ? tOr(t, 'warehouse.saving', 'Saving...') : tOr(t, 'warehouse.saveDraft', 'Save draft')}
            </button>
            <button
              type="button"
              onClick={() => void postDocument()}
              disabled={backendActionDisabled}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              title={backendActionTitle}
            >
              <FileText size={18} />
              {posting ? tOr(t, 'warehouse.posting', 'Posting...') : tOr(t, 'warehouse.postDocument', 'Post document')}
            </button>
            <button
              type="button"
              onClick={clearDocument}
              className="inline-flex h-11 w-full items-center justify-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              {tOr(t, 'warehouse.clearDraft', 'Clear draft')}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
