import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { stripIpcErrorPrefix } from '../src/shared/billiard-contract';
import { humanizeBilliardError } from '../src/renderer/components/billiard/utils';

const readSource = (relativePath: string): string =>
  readFileSync(join(__dirname, relativePath), 'utf8');

// The exact message from the reported screenshot.
const RAW = "Error invoking remote method 'billiard:mutate': Error: Check-in window is from 2026-07-21T12:45:00.000Z to 2026-07-21T13:30:00.000Z";

describe('billiard errors reach the cashier in a readable form', () => {
  it('strips the Electron IPC wrapper and is idempotent', () => {
    expect(stripIpcErrorPrefix(RAW)).toBe(
      'Check-in window is from 2026-07-21T12:45:00.000Z to 2026-07-21T13:30:00.000Z',
    );
    expect(stripIpcErrorPrefix(stripIpcErrorPrefix(RAW))).toBe(stripIpcErrorPrefix(RAW));
    expect(stripIpcErrorPrefix('Network connection was lost.')).toBe('Network connection was lost.');
  });

  it('turns the check-in window guard into local times', () => {
    const t = (key: string) => (key === 'billiard.checkinWindow' ? 'Nhận bàn được từ {from} đến {to}' : undefined);
    const text = humanizeBilliardError(RAW, t as any, 'Europe/Warsaw');
    expect(text).toContain('14:45');
    expect(text).toContain('15:30');
    expect(text).not.toContain('Z');
  });

  it('passes other messages through untouched apart from the wrapper', () => {
    const t = () => undefined;
    expect(humanizeBilliardError("Error invoking remote method 'billiard:mutate': Error: Table is occupied", t as any))
      .toBe('Table is occupied');
  });

  it('every billiard call path strips the wrapper; the panel humanizes', () => {
    const hooksData = readSource('../src/renderer/hooks/useBilliardData.ts');
    const hooksApi = readSource('../src/renderer/hooks/useBilliardApi.ts');
    const panel = readSource('../src/renderer/components/billiard/ReservationPanel.tsx');
    expect(hooksData).toContain('stripIpcErrorPrefix');
    expect(hooksApi).toContain('stripIpcErrorPrefix');
    expect(panel).toContain('humanizeBilliardError');
  });
});
