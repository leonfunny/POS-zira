#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const generatedFiles = [
  'android-pos/app/src/main/res/xml/config.xml',
];

for (const relativePath of generatedFiles) {
  const path = resolve(root, relativePath);
  const source = await readFile(path, 'utf8');
  const normalized = `${source.replace(/\r\n/g, '\n').replace(/[\t ]+$/gm, '').trimEnd()}\n`;
  if (normalized !== source) await writeFile(path, normalized, 'utf8');
}
