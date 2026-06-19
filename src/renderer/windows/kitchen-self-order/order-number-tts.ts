// Polish voice announcement of the kitchen self-order pickup number, played once
// on the done screen. Reuses the shared pl-tts-engine number clips and Web Speech
// fallback. Polish only, by product decision.
import {
  ClipPlayer,
  buildNumberSequence,
  cancelPolishSpeech,
  speakPolishText,
  warmUpClips,
} from '../../lib/pl-tts-engine';

const FRAMING = {
  thanks: 'kso_dziekujemy.mp3',
  label: 'kso_numer_zamowienia.mp3',
  keep: 'kso_zachowaj_numer.mp3',
};

export function parseKitchenOrderSequence(orderNumber: string | null | undefined): number | null {
  if (!orderNumber) return null;
  const match = /^K-(\d+)$/.exec(orderNumber.trim());
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n < 1 || n > 999) return null;
  return n;
}

export function buildOrderNumberSequence(n: number): string[] {
  return [FRAMING.thanks, FRAMING.label, ...buildNumberSequence(n), FRAMING.keep];
}

export function shouldAnnounceOrderNumber(
  step: string,
  voiceEnabled: boolean,
  orderNumber: string | null | undefined,
): number | null {
  if (step !== 'done' || !voiceEnabled) return null;
  return parseKitchenOrderSequence(orderNumber);
}

function spokenText(n: number): string {
  return `Dziękujemy. Numer zamówienia ${n}. Prosimy zachować numer.`;
}

const player = new ClipPlayer();

export async function playOrderNumberAnnouncement(n: number): Promise<void> {
  if (typeof window === 'undefined') return;
  const result = await player.play(buildOrderNumberSequence(n));
  if (result === 'failed') speakPolishText(spokenText(n));
}

export function cancelOrderNumberAnnouncement(): void {
  player.cancel();
  cancelPolishSpeech();
}

export function warmUpOrderNumberClips(): void {
  warmUpClips([FRAMING.thanks, FRAMING.label, FRAMING.keep]);
}

// Best-effort audio unlock. Call synchronously inside the submit tap so the later
// (post-await) announcement rides the page's user activation. Failures are ignored.
let audioPrimed = false;
export function primeOrderNumberAudio(): void {
  if (audioPrimed || typeof window === 'undefined') return;
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctx) { const ctx = new Ctx(); void ctx.resume().catch(() => undefined); }
    audioPrimed = true;
  } catch {
    /* best-effort */
  }
}
