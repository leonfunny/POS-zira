import { describe, expect, it, vi } from 'vitest';
import { FABRIC_TAG_TEMPLATE_CHANNELS } from '../src/shared/fabric-tag-template-ipc';
import {
  FABRIC_TAG_TEMPLATE_LIMITS,
  parseFabricTagTemplateInput,
  registerFabricTagTemplateIpcHandlers,
} from '../src/main/pos/fabric-tag-template-ipc';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function paddedPngDataUrl(byteLength: number): string {
  const bytes = Buffer.alloc(byteLength);
  ONE_PIXEL_PNG.copy(bytes);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

function setupHandlers() {
  const handlers = new Map<string, Handler>();
  const ipc = {
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    }),
  };
  const repository = {
    list: vi.fn(() => []),
    listTemplateIds: vi.fn(() => []),
    get: vi.fn((templateId: string) => ({ templateId })),
    save: vi.fn(),
    remove: vi.fn(),
  };

  registerFabricTagTemplateIpcHandlers(ipc as never, repository);
  return { handlers, repository };
}

describe('fabric tag template IPC boundary', () => {
  it('registers the complete shared channel contract', () => {
    const { handlers } = setupHandlers();
    expect([...handlers.keys()]).toEqual(Object.values(FABRIC_TAG_TEMPLATE_CHANNELS));
  });

  it('maps list and listIds to their exact repository methods', () => {
    const { handlers, repository } = setupHandlers();
    repository.list.mockReturnValue([{ templateId: 'full-row' }]);
    repository.listTemplateIds.mockReturnValue(['id-only']);

    expect(handlers.get(FABRIC_TAG_TEMPLATE_CHANNELS.list)!({}))
      .toEqual([{ templateId: 'full-row' }]);
    expect(handlers.get(FABRIC_TAG_TEMPLATE_CHANNELS.listIds)!({}))
      .toEqual(['id-only']);
    expect(repository.list).toHaveBeenCalledTimes(1);
    expect(repository.listTemplateIds).toHaveBeenCalledTimes(1);
  });

  it('normalizes a backward-compatible minimal save payload before persistence', () => {
    const { handlers, repository } = setupHandlers();
    const result = handlers.get(FABRIC_TAG_TEMPLATE_CHANNELS.save)!({}, {
      templateId: '  style-1  ',
      careSymbols: ['WASH_30', 'IRON_LOW'],
    });

    expect(repository.save).toHaveBeenCalledWith({
      templateId: 'style-1',
      brandName: null,
      logoDataUrl: null,
      composition: null,
      careSymbols: ['WASH_30', 'IRON_LOW'],
      careText: null,
      fabric: null,
      layout: 'default',
    });
    expect(repository.get).toHaveBeenCalledWith('style-1');
    expect(result).toEqual({ templateId: 'style-1' });
  });

  it.each([
    ['a non-object payload', null, /payload/],
    ['a missing template id', {}, /templateId/],
    ['a blank template id', { templateId: '   ' }, /templateId/],
    ['non-array care symbols', { templateId: 'style-1', careSymbols: 'WASH_30' }, /careSymbols/],
    ['an unknown care symbol', { templateId: 'style-1', careSymbols: ['WASH_9000'] }, /careSymbols/],
    ['a sparse care symbol array', { templateId: 'style-1', careSymbols: new Array(1) }, /careSymbols/],
    ['contradictory care symbols', { templateId: 'style-1', careSymbols: ['WASH_30', 'WASH_NO'] }, /careSymbols/],
    ['an unknown layout', { templateId: 'style-1', layout: 'sideways' }, /layout/],
    ['a non-string text field', { templateId: 'style-1', composition: 100 }, /composition/],
  ])('rejects %s without writing', (_label, input, message) => {
    const { handlers, repository } = setupHandlers();
    expect(() => handlers.get(FABRIC_TAG_TEMPLATE_CHANNELS.save)!({}, input)).toThrow(message);
    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.get).not.toHaveBeenCalled();
  });

  it.each([
    [FABRIC_TAG_TEMPLATE_CHANNELS.get, null],
    [FABRIC_TAG_TEMPLATE_CHANNELS.get, '   '],
    [FABRIC_TAG_TEMPLATE_CHANNELS.remove, 42],
    [FABRIC_TAG_TEMPLATE_CHANNELS.remove, ''],
  ])('rejects an invalid id on %s before touching the repository', (channel, templateId) => {
    const { handlers, repository } = setupHandlers();
    expect(() => handlers.get(channel)!({}, templateId)).toThrow(/templateId/);
    expect(repository.get).not.toHaveBeenCalled();
    expect(repository.remove).not.toHaveBeenCalled();
  });

  it('normalizes valid get and remove ids before repository access', () => {
    const { handlers, repository } = setupHandlers();
    handlers.get(FABRIC_TAG_TEMPLATE_CHANNELS.get)!({}, '  style-1 ');
    handlers.get(FABRIC_TAG_TEMPLATE_CHANNELS.remove)!({}, ' style-2  ');
    expect(repository.get).toHaveBeenCalledWith('style-1');
    expect(repository.remove).toHaveBeenCalledWith('style-2');
  });

  it('copies careSymbols so later caller mutation cannot alter the validated value', () => {
    const careSymbols = ['WASH_30'];
    const parsed = parseFabricTagTemplateInput({ templateId: 'style-1', careSymbols });
    careSymbols.push('not-a-symbol');
    expect(parsed.careSymbols).toEqual(['WASH_30']);
  });

  it('deduplicates valid care symbols before persistence', () => {
    const parsed = parseFabricTagTemplateInput({
      templateId: 'style-1',
      careSymbols: ['WASH_30', 'IRON_LOW', 'WASH_30'],
    });
    expect(parsed.careSymbols).toEqual(['WASH_30', 'IRON_LOW']);
  });

  it.each([
    ['templateId', { templateId: 'x'.repeat(FABRIC_TAG_TEMPLATE_LIMITS.templateId + 1) }],
    ['brandName', { templateId: 'style-1', brandName: 'x'.repeat(FABRIC_TAG_TEMPLATE_LIMITS.brandName + 1) }],
    ['composition', { templateId: 'style-1', composition: 'x'.repeat(FABRIC_TAG_TEMPLATE_LIMITS.composition + 1) }],
    ['careText', { templateId: 'style-1', careText: 'x'.repeat(FABRIC_TAG_TEMPLATE_LIMITS.careText + 1) }],
    ['fabric', { templateId: 'style-1', fabric: 'x'.repeat(FABRIC_TAG_TEMPLATE_LIMITS.fabric + 1) }],
    ['careSymbols', {
      templateId: 'style-1',
      careSymbols: Array(FABRIC_TAG_TEMPLATE_LIMITS.careSymbols + 1).fill('WASH_30'),
    }],
  ])('rejects %s above its persistence boundary', (field, input) => {
    expect(() => parseFabricTagTemplateInput(input)).toThrow(new RegExp(field));
  });

  it('accepts a raster logo at the byte limit and rejects larger or active image formats', () => {
    const atLimit = paddedPngDataUrl(FABRIC_TAG_TEMPLATE_LIMITS.logoBytes);
    const overLimit = paddedPngDataUrl(FABRIC_TAG_TEMPLATE_LIMITS.logoBytes + 1);

    expect(parseFabricTagTemplateInput({
      templateId: 'style-1',
      logoDataUrl: atLimit,
    }).logoDataUrl).toBe(atLimit);
    expect(() => parseFabricTagTemplateInput({
      templateId: 'style-1',
      logoDataUrl: overLimit,
    })).toThrow(/logoDataUrl/);
    expect(() => parseFabricTagTemplateInput({
      templateId: 'style-1',
      logoDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    })).toThrow(/logoDataUrl/);
  });
});
