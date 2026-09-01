import { describe, expect, it, vi } from 'vitest';
import { FABRIC_TAG_TEMPLATE_CHANNELS } from '../src/shared/fabric-tag-template-ipc';
import {
  parseFabricTagTemplateInput,
  registerFabricTagTemplateIpcHandlers,
} from '../src/main/pos/fabric-tag-template-ipc';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

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
});
