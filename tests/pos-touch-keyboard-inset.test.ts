import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'src/renderer/App.tsx'), 'utf8');
const TOUCH_KEYBOARD = fs.readFileSync(path.join(ROOT, 'src/renderer/components/shared/TouchKeyboard.tsx'), 'utf8');
const POS_LAYOUT = fs.readFileSync(path.join(ROOT, 'src/renderer/components/pos/POSLayout.tsx'), 'utf8');

describe('POS touch keyboard inset', () => {
  it('measures the shared touch keyboard height and reports it to App', () => {
    expect(TOUCH_KEYBOARD).toContain('onHeightChange?: (heightPx: number) => void');
    expect(TOUCH_KEYBOARD).toContain('const keyboardRef = useRef<HTMLDivElement | null>(null)');
    expect(TOUCH_KEYBOARD).toContain('const lastReportedHeightRef = useRef<number | null>(null)');
    expect(TOUCH_KEYBOARD).toContain('Math.ceil(element.scrollHeight)');
    expect(TOUCH_KEYBOARD).toContain('ResizeObserver');
    expect(TOUCH_KEYBOARD).toContain('ref={keyboardRef}');
    expect(TOUCH_KEYBOARD).toContain('lastReportedHeightRef.current === nextHeight');
    expect(TOUCH_KEYBOARD).toContain('onHeightChange?.(nextHeight)');
    expect(TOUCH_KEYBOARD).not.toContain('getBoundingClientRect().height');
  });

  it('uses the measured keyboard inset instead of hardcoded 300px App padding', () => {
    expect(APP).toContain('const [touchKeyboardHeight, setTouchKeyboardHeight] = useState(0)');
    expect(APP).toContain('--touch-keyboard-inset');
    expect(APP).toContain('const globalKeyboardInset = showGlobalKeyboard ? touchKeyboardHeight : 0');
    expect(APP).toContain('const posFullscreenKeyboardInset = keyboardVisible ? touchKeyboardHeight : 0');
    expect(APP).toContain('onHeightChange={setTouchKeyboardHeight}');
    expect(APP).not.toContain("keyboardVisible ? '300px'");
    expect(APP).not.toContain("showGlobalKeyboard ? '300px'");
  });

  it('lays out the manual weight modal above the measured keyboard inset', () => {
    expect(POS_LAYOUT).toContain("paddingBottom: 'calc(var(--touch-keyboard-inset, 0px) + 1rem)'");
    expect(POS_LAYOUT).toContain("maxHeight: 'calc(100dvh - var(--touch-keyboard-inset, 0px) - 2rem)'");
    expect(POS_LAYOUT).toContain('overflow-y-auto');
  });
});
