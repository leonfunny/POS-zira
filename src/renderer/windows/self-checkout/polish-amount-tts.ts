// Polish currency-amount text-to-speech for the self-checkout kiosk.
// Builds the amount sentence and plays it through the shared pl-tts-engine,
// falling back to Web Speech only when clip playback actually fails.
import {
  ClipPlayer,
  buildNumberSequence,
  cancelPolishSpeech,
  ensurePolishVoice,
  polishUnit,
  speakPolishText,
  warmUpClips,
} from '../../lib/pl-tts-engine';

export type Method = 'CARD' | 'CASH' | 'BLIK';

const WEB_SPEECH_RATE = 1.08;

function zlotyUnitClip(count: number): string {
  return polishUnit(count, 'zloty_1.mp3', 'zloty_few.mp3', 'zloty_many.mp3');
}
function groszUnitClip(count: number): string {
  return polishUnit(count, 'grosz_1.mp3', 'grosz_few.mp3', 'grosz_many.mp3');
}

export interface AnnouncementOptions { method: Method; totalGrosze: number; }

export function buildAnnouncementSequence({ method, totalGrosze }: AnnouncementOptions): string[] {
  const zl = Math.floor(Math.max(0, totalGrosze) / 100);
  const gr = Math.floor(Math.max(0, totalGrosze)) % 100;
  const clips: string[] = [];
  const prefix = method === 'CARD' ? 'prefix_card.mp3'
    : method === 'BLIK' ? 'prefix_blik.mp3'
    : 'prefix_cash.mp3';
  clips.push(prefix);
  clips.push('do_zaplaty.mp3');
  if (zl > 0) { clips.push(...buildNumberSequence(zl)); clips.push(zlotyUnitClip(zl)); }
  if (gr > 0) { clips.push(...buildNumberSequence(gr)); clips.push(groszUnitClip(gr)); }
  if (zl === 0 && gr === 0) { clips.push('0.mp3'); clips.push('zloty_many.mp3'); }
  return clips;
}

const player = new ClipPlayer();

function amountText(method: Method, totalGrosze: number): string {
  const zl = Math.floor(totalGrosze / 100);
  const gr = totalGrosze % 100;
  const methodWord = method === 'CARD' ? 'kartą' : method === 'BLIK' ? 'BLIK-iem' : 'gotówką';
  const zlUnit = polishUnit(zl, 'złoty', 'złote', 'złotych');
  const grUnit = polishUnit(gr, 'grosz', 'grosze', 'groszy');
  const amount = zl === 0 && gr > 0 ? `${gr} ${grUnit}`
    : gr === 0 ? `${zl} ${zlUnit}`
    : `${zl} ${zlUnit} ${gr} ${grUnit}`;
  return `Płatność ${methodWord}. Do zapłaty ${amount}.`;
}

export async function playAnnouncement(method: Method, totalGrosze: number): Promise<void> {
  if (typeof window === 'undefined') return;
  const result = await player.play(buildAnnouncementSequence({ method, totalGrosze }));
  if (result === 'failed') {
    speakPolishText(amountText(method, totalGrosze), WEB_SPEECH_RATE);
    // Ensure the voice resolves before returning so tests can await it.
    await ensurePolishVoice();
  }
}

export function cancelAnnouncement(): void {
  player.cancel();
  cancelPolishSpeech();
}

export function warmUpClipCache(): void {
  warmUpClips([
    'prefix_card.mp3', 'prefix_blik.mp3', 'prefix_cash.mp3', 'do_zaplaty.mp3',
    'zloty_1.mp3', 'zloty_few.mp3', 'zloty_many.mp3',
    'grosz_1.mp3', 'grosz_few.mp3', 'grosz_many.mp3',
    'thousand_1.mp3', 'thousand_few.mp3', 'thousand_many.mp3',
  ]);
}
