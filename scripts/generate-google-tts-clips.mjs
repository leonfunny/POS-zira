#!/usr/bin/env node
// Render selected Polish self-checkout TTS MP3 clips with Google Cloud Text-to-Speech.
//
// Required:
//   $env:GOOGLE_TTS_API_KEY = "..."
//
// Optional:
//   $env:ONLY = "prefix_card.mp3,prefix_blik.mp3"
//   $env:FORCE = "1"
//   $env:GOOGLE_TTS_VOICE = "pl-PL-Wavenet-A"
//   $env:GOOGLE_TTS_SPEAKING_RATE = "1.08"

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_KEY = process.env.GOOGLE_TTS_API_KEY;
const OUT_DIR = path.resolve(__dirname, '../src/renderer/public/tts-pl');
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';
const ONLY = new Set(
  (process.env.ONLY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const VOICE_NAME = process.env.GOOGLE_TTS_VOICE || 'pl-PL-Wavenet-A';
const SPEAKING_RATE = Number(process.env.GOOGLE_TTS_SPEAKING_RATE || '1.08');
const PITCH = Number(process.env.GOOGLE_TTS_PITCH || '0');

if (!API_KEY) {
  console.error('ERROR: GOOGLE_TTS_API_KEY is not set.');
  process.exit(1);
}

const clips = [
  { filename: 'prefix_card.mp3', text: 'Płatność kartą.' },
  { filename: 'prefix_cash.mp3', text: 'Płatność gotówką.' },
  { filename: 'prefix_blik.mp3', text: 'Płatność BLIK-iem.' },
  { filename: 'do_zaplaty.mp3', text: 'Do zapłaty' },
].filter((clip) => ONLY.size === 0 || ONLY.has(clip.filename));

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.size > 0;
  } catch {
    return false;
  }
}

async function renderClip(clip) {
  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(API_KEY)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text: clip.text },
      voice: {
        languageCode: 'pl-PL',
        name: VOICE_NAME,
        ssmlGender: 'FEMALE',
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: SPEAKING_RATE,
        pitch: PITCH,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '<no body>');
    throw new Error(`Google TTS ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = await response.json();
  if (!data.audioContent) throw new Error('Google TTS returned no audioContent');
  const buffer = Buffer.from(data.audioContent, 'base64');
  if (buffer.length < 200) {
    throw new Error(`Google TTS returned suspiciously small payload (${buffer.length} bytes)`);
  }

  await fs.writeFile(path.join(OUT_DIR, clip.filename), buffer);
}

await fs.mkdir(OUT_DIR, { recursive: true });
console.log(`Output: ${OUT_DIR}`);
console.log(`Voice : ${VOICE_NAME}, speakingRate=${SPEAKING_RATE}`);
if (ONLY.size > 0) console.log(`Only  : ${Array.from(ONLY).join(', ')}`);

let rendered = 0;
let skipped = 0;
let failed = 0;

for (const clip of clips) {
  const outPath = path.join(OUT_DIR, clip.filename);
  if (!FORCE && await fileExists(outPath)) {
    skipped++;
    continue;
  }
  try {
    await renderClip(clip);
    rendered++;
    console.log(`OK ${clip.filename} "${clip.text}"`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${clip.filename}: ${error.message}`);
  }
}

console.log(`Rendered: ${rendered}   Skipped: ${skipped}   Failed: ${failed}`);
if (failed > 0) process.exit(1);
