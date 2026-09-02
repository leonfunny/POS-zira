import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  SAVED_ORDER_LIMIT,
  clearDraft,
  deleteSavedOrder,
  describeOrder,
  listSavedOrders,
  loadDraft,
  saveDraft,
  saveOrder,
  loadDraftId,
  saveDraftId,
  LEARNED_LIMIT,
  forgetSize,
  forgetStyle,
  loadLearnedSizes,
  loadLearnedStyles,
  rememberSize,
  rememberStyle,
} from '../src/renderer/components/label/print-order-storage';
import {
  MAX_SIZE_LABEL_CHARS,
  SIZE_SUGGESTIONS,
  STYLE_SUGGESTIONS,
  createEmptyOrder,
} from '../src/shared/label-print-order';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function sample() {
  return {
    ...createEmptyOrder(),
    customerName: 'MoonCollection',
    styleName: 'KURTKA',
    styleCode: '114',
    sizes: [{ id: 's', label: 'S' }],
    rows: [{ id: 'r1', colorName: 'CZEKOLADA', code: 'SP006290', quantities: { s: 40 } }],
  };
}

describe('the draft survives an app restart', () => {
  it('returns an empty order when nothing was saved', () => {
    expect(loadDraft()).toEqual(createEmptyOrder());
  });

  it('round-trips a draft', () => {
    saveDraft(sample());
    expect(loadDraft().rows[0].quantities.s).toBe(40);
  });

  it('is cleared on request', () => {
    saveDraft(sample());
    clearDraft();
    expect(loadDraft()).toEqual(createEmptyOrder());
  });

  it('falls back to an empty order when the stored value is corrupt', () => {
    localStorage.setItem('zira.labelPrintOrder.draft', '{not json');
    expect(loadDraft()).toEqual(createEmptyOrder());
  });

  it('fills in fields a draft from an older shape is missing', () => {
    localStorage.setItem(
      'zira.labelPrintOrder.draft',
      JSON.stringify({ customerName: 'MoonCollection' }),
    );
    const draft = loadDraft();
    expect(draft.customerName).toBe('MoonCollection');
    expect(draft.rows).toEqual([]);
    expect(draft.sizes).toEqual([]);
    expect(draft.printStickers).toBe(true);
  });

  it('repairs a draft whose list fields are the wrong type', () => {
    localStorage.setItem(
      'zira.labelPrintOrder.draft',
      JSON.stringify({ rows: 'nonsense', sizes: null, materials: 3 }),
    );
    const draft = loadDraft();
    expect(draft.rows).toEqual([]);
    expect(draft.sizes).toEqual([]);
    expect(draft.materials).toEqual([]);
  });

  it('keeps working when storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => saveDraft(sample())).not.toThrow();
    expect(loadDraft()).toEqual(createEmptyOrder());
  });

  it('keeps working when storage throws on write', () => {
    const throwing = memoryStorage();
    throwing.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    vi.stubGlobal('localStorage', throwing);
    expect(() => saveDraft(sample())).not.toThrow();
  });
});

describe('saved orders let staff reprint without retyping', () => {
  it('stores and lists an order', () => {
    saveOrder('order-1', sample());
    const saved = listSavedOrders();
    expect(saved).toHaveLength(1);
    expect(saved[0].order.customerName).toBe('MoonCollection');
    expect(saved[0].savedAt).toBeTruthy();
  });

  it('replaces an order saved under the same id rather than duplicating it', () => {
    saveOrder('order-1', sample());
    saveOrder('order-1', { ...sample(), customerName: 'H&M' });
    const saved = listSavedOrders();
    expect(saved).toHaveLength(1);
    expect(saved[0].order.customerName).toBe('H&M');
  });

  it('keeps the newest first', () => {
    saveOrder('a', sample());
    saveOrder('b', { ...sample(), customerName: 'Second' });
    expect(listSavedOrders().map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('caps the list so storage cannot grow without bound', () => {
    for (let i = 0; i < SAVED_ORDER_LIMIT + 5; i++) saveOrder(`order-${i}`, sample());
    expect(listSavedOrders()).toHaveLength(SAVED_ORDER_LIMIT);
  });

  it('deletes one order', () => {
    saveOrder('a', sample());
    saveOrder('b', sample());
    expect(deleteSavedOrder('a').map((s) => s.id)).toEqual(['b']);
  });

  it('drops malformed entries instead of rendering them', () => {
    localStorage.setItem(
      'zira.labelPrintOrder.saved',
      JSON.stringify([{ id: 'ok', order: {} }, null, { id: 42 }, { order: {} }]),
    );
    expect(listSavedOrders().map((s) => s.id)).toEqual(['ok']);
  });

  it('survives a corrupt saved list', () => {
    localStorage.setItem('zira.labelPrintOrder.saved', '[[[');
    expect(listSavedOrders()).toEqual([]);
  });
});

describe('describeOrder', () => {
  it('names an order by customer and style', () => {
    expect(describeOrder(sample())).toBe('MoonCollection · KURTKA 114');
  });

  it('copes with a half-filled header', () => {
    expect(describeOrder({ ...createEmptyOrder(), customerName: 'MoonCollection' })).toBe(
      'MoonCollection',
    );
  });

  it('never returns an empty name', () => {
    expect(describeOrder(createEmptyOrder())).toBeTruthy();
  });
});

describe('the draft remembers which saved order it is', () => {
  it('starts with no order attached', () => {
    expect(loadDraftId()).toBeNull();
  });

  it('round-trips the id, so Save after a restart overwrites the same order', () => {
    saveDraftId('order-7');
    expect(loadDraftId()).toBe('order-7');
  });

  it('lets go of the order when the sheet is cleared for a new one', () => {
    saveDraftId('order-7');
    clearDraft();
    expect(loadDraftId()).toBeNull();
  });

  it('treats a corrupt or empty stored id as no order', () => {
    localStorage.setItem('zira.labelPrintOrder.draftId', '""');
    expect(loadDraftId()).toBeNull();
    localStorage.setItem('zira.labelPrintOrder.draftId', '{not json');
    expect(loadDraftId()).toBeNull();
    localStorage.setItem('zira.labelPrintOrder.draftId', '42');
    expect(loadDraftId()).toBeNull();
  });

  it('keeps working when storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => saveDraftId('order-7')).not.toThrow();
    expect(loadDraftId()).toBeNull();
  });
});

describe('the machine remembers a size somebody typed', () => {
  it('knows nothing beyond the built-in buttons to begin with', () => {
    expect(loadLearnedSizes()).toEqual([]);
  });

  it('remembers a size that is not already a button', () => {
    expect(rememberSize('3XL')).toEqual(['3XL']);
    expect(loadLearnedSizes()).toEqual(['3XL']);
  });

  it('keeps them in the order they were taught, so the row does not shuffle', () => {
    rememberSize('3XL');
    rememberSize('48/50');
    expect(loadLearnedSizes()).toEqual(['3XL', '48/50']);
  });

  it('stores it the way it will print — trimmed and in capitals', () => {
    expect(rememberSize('  3xl ')).toEqual(['3XL']);
    expect(rememberSize('3XL')).toEqual(['3XL']);
  });

  it('does not duplicate a button that already exists', () => {
    for (const built of SIZE_SUGGESTIONS) rememberSize(built);
    expect(loadLearnedSizes()).toEqual([]);
    expect(rememberSize('s/m')).toEqual([]);
  });

  it('ignores an empty size, and cuts one longer than the tag allows', () => {
    expect(rememberSize('   ')).toEqual([]);
    const long = 'X'.repeat(MAX_SIZE_LABEL_CHARS + 5);
    expect(rememberSize(long)).toEqual([long.slice(0, MAX_SIZE_LABEL_CHARS)]);
  });

  it('drops the oldest once the row is full, rather than growing forever', () => {
    for (let i = 0; i < LEARNED_LIMIT + 3; i += 1) rememberSize(`Z${i}`);
    const sizes = loadLearnedSizes();
    expect(sizes).toHaveLength(LEARNED_LIMIT);
    expect(sizes).not.toContain('Z0');
    expect(sizes[sizes.length - 1]).toBe(`Z${LEARNED_LIMIT + 2}`);
  });

  it('forgets one on request — how a typo gets off the row', () => {
    rememberSize('3XL');
    rememberSize('3XXL');
    expect(forgetSize('3XXL')).toEqual(['3XL']);
    expect(loadLearnedSizes()).toEqual(['3XL']);
  });

  it('survives a new order: it belongs to the machine, not the sheet', () => {
    rememberSize('3XL');
    clearDraft();
    expect(loadLearnedSizes()).toEqual(['3XL']);
  });

  it('reads a hand-edited or corrupt store without taking the panel down', () => {
    localStorage.setItem('zira.labelPrintOrder.learnedSizes', '{not json');
    expect(loadLearnedSizes()).toEqual([]);
    localStorage.setItem('zira.labelPrintOrder.learnedSizes', '"3XL"');
    expect(loadLearnedSizes()).toEqual([]);
    localStorage.setItem('zira.labelPrintOrder.learnedSizes', '["3XL", 42, "", "3XL", "S"]');
    expect(loadLearnedSizes()).toEqual(['3XL']);
  });

  it('keeps working when storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => rememberSize('3XL')).not.toThrow();
    expect(loadLearnedSizes()).toEqual([]);
  });
});

describe('the machine remembers a style name too', () => {
  it('starts with only the names it shipped with', () => {
    expect(loadLearnedStyles()).toEqual([]);
  });

  it('remembers one that is not already in the dropdown', () => {
    expect(rememberStyle('bluza z kapturem')).toEqual(['BLUZA Z KAPTUREM']);
    expect(loadLearnedStyles()).toEqual(['BLUZA Z KAPTUREM']);
  });

  it('does not learn a name the dropdown already offers', () => {
    for (const built of STYLE_SUGGESTIONS) rememberStyle(built);
    expect(loadLearnedStyles()).toEqual([]);
    expect(rememberStyle('kurtka')).toEqual([]);
  });

  it('forgets one, which is how a typo gets out of the dropdown', () => {
    rememberStyle('KURTAK');
    expect(forgetStyle('KURTAK')).toEqual([]);
  });

  it('keeps its own list, separate from the sizes', () => {
    rememberSize('3XL');
    rememberStyle('BLUZA');
    expect(loadLearnedSizes()).toEqual(['3XL']);
    expect(loadLearnedStyles()).toEqual(['BLUZA']);
  });

  it('survives a new order, like the sizes do', () => {
    rememberStyle('BLUZA');
    clearDraft();
    expect(loadLearnedStyles()).toEqual(['BLUZA']);
  });
});
