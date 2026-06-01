import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const retailTemplate = fs.readFileSync(
  path.join(ROOT, 'src/renderer/components/pos/templates/retail/RetailTemplate.tsx'),
  'utf8',
);
const voiceHook = fs.readFileSync(
  path.join(ROOT, 'src/renderer/components/pos/usePosVoiceSearch.ts'),
  'utf8',
);
const posModule = fs.readFileSync(path.join(ROOT, 'src/main/modules/pos.module.ts'), 'utf8');
const preloadPos = fs.readFileSync(path.join(ROOT, 'src/preload/preload-pos.ts'), 'utf8');
const preloadMain = fs.readFileSync(path.join(ROOT, 'src/preload/preload.ts'), 'utf8');
const electronDts = fs.readFileSync(path.join(ROOT, 'src/shared/electron.d.ts'), 'utf8');

describe('retail POS voice search', () => {
  it('reserves scanner code 55555555 for voice search before product lookup', () => {
    expect(retailTemplate).toContain("const VOICE_SEARCH_SCAN_COMMAND = '55555555';");
    expect(retailTemplate).toContain('VOICE_SEARCH_SCAN_COMMAND');
    expect(retailTemplate.indexOf('if (code === VOICE_SEARCH_SCAN_COMMAND)')).toBeLessThan(
      retailTemplate.indexOf('window.electronAPI.pos.products.getByBarcode(code)'),
    );
    expect(retailTemplate).toContain('commandBarcodes={RETAIL_SCAN_COMMANDS}');
  });

  it('uses Down arrow as the second-step voice command without stealing modal input', () => {
    expect(retailTemplate).toContain("event.key !== 'ArrowDown'");
    expect(retailTemplate).toContain("target instanceof HTMLInputElement && target.id !== 'pos-product-search'");
    expect(retailTemplate).toContain('document.body.dataset.posAddProductOpen');
    expect(retailTemplate).toContain('document.body.dataset.posPaymentOpen');
    expect(retailTemplate).toContain('voiceChoicePendingRef.current');
  });

  it('transcribes through PhoWhisper and sends tiny wake checks plus small command audio', () => {
    expect(voiceHook).toContain('window.electronAPI.pos.voice.transcribe');
    expect(voiceHook).toContain("model: mode === 'command' ? 'small' : 'tiny'");
    expect(voiceHook).toContain('extractWakeQuery');
    expect(voiceHook).toContain('commandCaptureInFlightRef');
    expect(voiceHook).toContain('wakeCaptureInFlightRef');
    expect(voiceHook).toContain('WAKE_FAILURE_BACKOFF_MS');
    expect(posModule).toContain("const PHOWHISPER_DEFAULT_BASE_URL = 'http://100.111.221.25:8088';");
    expect(posModule).toContain("'pos:voice:transcribe'");
    expect(posModule).toContain('FormData');
  });

  it('bounds PhoWhisper IPC payloads before decoding audio in main', () => {
    expect(posModule).toContain('PHOWHISPER_MAX_AUDIO_BYTES');
    expect(posModule).toContain('PHOWHISPER_MAX_BASE64_CHARS');
    expect(posModule).toContain('audio-too-large');
    expect(posModule).toContain('invalid-audio-base64');
    expect(posModule).toContain('unsupported-audio-type');
    expect(posModule.indexOf('audioBase64.length > PHOWHISPER_MAX_BASE64_CHARS')).toBeLessThan(
      posModule.indexOf('Buffer.from(audioBase64'),
    );
  });

  it('exposes the voice transcription IPC in both POS preloads and typings', () => {
    for (const source of [preloadPos, preloadMain]) {
      expect(source).toContain('voice');
      expect(source).toContain('transcribe');
      expect(source).toContain('pos:voice:transcribe');
    }
    expect(electronDts).toContain('voice');
    expect(electronDts).toContain('transcribe');
    expect(electronDts).toContain('audioBase64');
  });
});
