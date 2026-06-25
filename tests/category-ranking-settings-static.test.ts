import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

const source = readSource('../src/renderer/components/pos/CategoryRankingSettings.tsx');

describe('CategoryRankingSettings interactions', () => {
  it('autosaves ranking changes after a debounce', () => {
    expect(source).toContain('autoSaveTimerRef');
    expect(source).toContain('AUTO_SAVE_DEBOUNCE_MS = 1600');
    expect(source).toContain('setTimeout(() =>');
    expect(source).toContain("void persistOrder(orderedRef.current, 'auto')");
    expect(source).toContain('Sẽ tự lưu');
  });

  it('keeps background autosave from blocking drag and drop reordering', () => {
    expect(source).toContain('const [manualSaving, setManualSaving] = useState(false)');
    expect(source).toContain('const [autoSaving, setAutoSaving] = useState(false)');
    expect(source).toContain('const saving = manualSaving');
    expect(source).toContain('draggable={!saving}');
    expect(source).toContain('onDragStart={(event) => handleDragStart(event, cat.id)}');
    expect(source).toContain('onDrop={(event) => handleDrop(event, cat.id)}');
    expect(source).toContain('aria-grabbed={draggingId === cat.id}');
    expect(source).toContain('Giữ và kéo để đổi thứ tự');
  });

  it('persists ranking through one batch IPC call without stale category names', () => {
    expect(source).toContain('updateCategoryOrder');
    expect(source).not.toContain('productAdmin.updateCategory(cat.id');
    expect(source).not.toContain('name: cat.name');
  });
});
