import { readFile } from 'node:fs/promises';

export const loadReceipt = (path: string): Promise<string> => readFile(path, 'utf8');
