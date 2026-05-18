#!/usr/bin/env node
// Renders 1013 Polish TTS clips for the self-checkout kiosk amount announcer.
// Output: src/renderer/public/tts-pl/*.mp3 (copied to dist/renderer/tts-pl/ on build).
//
// Run:
//   $env:AZURE_SPEECH_KEY  = "xxx"     # Azure portal → Speech resource → Keys
//   $env:AZURE_SPEECH_REGION = "westeurope"
//   node scripts/generate-tts-clips.mjs
//
// Idempotent by default: skips files that already exist. Set FORCE=1 to
// re-render every clip after changing voice/rate/text.
// Set ONLY=prefix_card.mp3,prefix_blik.mp3 to re-render selected clips.
//
// Voice: pl-PL-ZofiaNeural (female, native Polish, neutral newscaster tone —
// best fit for a kiosk announcement). Swap via VOICE env var. Alternatives:
// pl-PL-MarekNeural (male), pl-PL-AgnieszkaNeural (female alt).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AZURE_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = process.env.AZURE_SPEECH_REGION || 'westeurope';
const VOICE = process.env.VOICE || 'pl-PL-ZofiaNeural';
const OUT_DIR = path.resolve(__dirname, '../src/renderer/public/tts-pl');
const RATE = process.env.RATE || '-2%'; // slightly slow for clarity at the kiosk
const PITCH = process.env.PITCH || '+0%';
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';
const ONLY = new Set(
  (process.env.ONLY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

// Azure Speech API rate limits: free tier ~20 RPS, standard ~200 RPS.
// We sleep 80ms between requests = ~12 RPS, well below the free-tier ceiling.
const REQUEST_SPACING_MS = Number(process.env.REQUEST_SPACING_MS || 80);

if (!AZURE_KEY) {
  console.error('ERROR: AZURE_SPEECH_KEY is not set.');
  console.error('Get a key at https://portal.azure.com → Speech resource → Keys and Endpoint.');
  console.error('The Free F0 tier covers 500k chars/month — this script uses ~15k.');
  process.exit(1);
}

const UNITS_0_19 = [
  'zero', 'jeden', 'dwa', 'trzy', 'cztery', 'pięć', 'sześć', 'siedem', 'osiem', 'dziewięć',
  'dziesięć', 'jedenaście', 'dwanaście', 'trzynaście', 'czternaście',
  'piętnaście', 'szesnaście', 'siedemnaście', 'osiemnaście', 'dziewiętnaście',
];
const TENS = [
  '', '', 'dwadzieścia', 'trzydzieści', 'czterdzieści', 'pięćdziesiąt',
  'sześćdziesiąt', 'siedemdziesiąt', 'osiemdziesiąt', 'dziewięćdziesiąt',
];
const HUNDREDS = [
  '', 'sto', 'dwieście', 'trzysta', 'czterysta', 'pięćset',
  'sześćset', 'siedemset', 'osiemset', 'dziewięćset',
];

function numberToPolish(n) {
  if (n === 0) return 'zero';
  if (n < 20) return UNITS_0_19[n];
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return ones === 0 ? TENS[tens] : `${TENS[tens]} ${UNITS_0_19[ones]}`;
  }
  // 100-999
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (rest === 0) return HUNDREDS[hundreds];
  return `${HUNDREDS[hundreds]} ${numberToPolish(rest)}`;
}

function buildManifest() {
  const clips = [];
  for (let n = 0; n <= 999; n++) {
    clips.push({ filename: `${n}.mp3`, text: numberToPolish(n) });
  }
  clips.push({ filename: 'thousand_1.mp3', text: 'tysiąc' });
  clips.push({ filename: 'thousand_few.mp3', text: 'tysiące' });
  clips.push({ filename: 'thousand_many.mp3', text: 'tysięcy' });
  clips.push({ filename: 'zloty_1.mp3', text: 'złoty' });
  clips.push({ filename: 'zloty_few.mp3', text: 'złote' });
  clips.push({ filename: 'zloty_many.mp3', text: 'złotych' });
  clips.push({ filename: 'grosz_1.mp3', text: 'grosz' });
  clips.push({ filename: 'grosz_few.mp3', text: 'grosze' });
  clips.push({ filename: 'grosz_many.mp3', text: 'groszy' });
  clips.push({ filename: 'prefix_card.mp3', text: 'Płatność kartą.' });
  clips.push({ filename: 'prefix_cash.mp3', text: 'Płatność gotówką.' });
  clips.push({ filename: 'prefix_blik.mp3', text: 'Płatność BLIK-iem.' });
  clips.push({ filename: 'do_zaplaty.mp3', text: 'Do zapłaty' });
  return clips;
}

function escapeXml(s) {
  return s.replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  })[c]);
}

async function renderClip(text, outPath, attempt = 1) {
  const ssml =
    `<speak version='1.0' xml:lang='pl-PL'>` +
    `<voice name='${VOICE}'>` +
    `<prosody rate='${RATE}' pitch='${PITCH}'>${escapeXml(text)}</prosody>` +
    `</voice></speak>`;
  const url = `https://${AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': AZURE_KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'zira-tts-gen',
    },
    body: ssml,
  });

  if (response.status === 429 || response.status >= 500) {
    if (attempt < 4) {
      const backoff = 500 * 2 ** (attempt - 1);
      console.warn(`  ${response.status} retrying in ${backoff}ms (attempt ${attempt + 1})`);
      await new Promise((r) => setTimeout(r, backoff));
      return renderClip(text, outPath, attempt + 1);
    }
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '<no body>');
    throw new Error(`Azure TTS ${response.status}: ${body.slice(0, 200)}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length < 200) {
    throw new Error(`Azure TTS returned suspiciously small payload (${buf.length} bytes)`);
  }
  await fs.writeFile(outPath, buf);
}

async function fileExists(p) {
  try {
    const stat = await fs.stat(p);
    return stat.size > 0;
  } catch {
    return false;
  }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const manifest = buildManifest().filter((clip) => ONLY.size === 0 || ONLY.has(clip.filename));
  const totalChars = manifest.reduce((s, c) => s + c.text.length, 0);

  console.log(`Output: ${OUT_DIR}`);
  console.log(`Voice : ${VOICE} @ ${AZURE_REGION}`);
  if (ONLY.size > 0) console.log(`Only  : ${Array.from(ONLY).join(', ')}`);
  console.log(`Clips : ${manifest.length} (~${totalChars} chars, fits free F0 tier)`);
  console.log('');

  let rendered = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < manifest.length; i++) {
    const clip = manifest[i];
    const outPath = path.join(OUT_DIR, clip.filename);
    const idx = `[${String(i + 1).padStart(4)}/${manifest.length}]`;
    if (!FORCE && await fileExists(outPath)) {
      skipped++;
      continue;
    }
    try {
      await renderClip(clip.text, outPath);
      rendered++;
      console.log(`${idx} ${clip.filename.padEnd(28)} "${clip.text}"`);
      await new Promise((r) => setTimeout(r, REQUEST_SPACING_MS));
    } catch (err) {
      failed++;
      console.error(`${idx} ${clip.filename}: ${err.message}`);
    }
  }

  console.log('');
  console.log(`Rendered: ${rendered}   Skipped: ${skipped}   Failed: ${failed}`);
  if (failed > 0) {
    console.error('Some clips failed. Re-run the script to retry only the missing ones.');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
