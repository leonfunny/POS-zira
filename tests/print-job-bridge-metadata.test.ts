import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const ORCHESTRATOR = fs.readFileSync(path.join(ROOT, 'src/main/core/orchestrator.ts'), 'utf8');
const EVENT_BUS = fs.readFileSync(path.join(ROOT, 'src/main/core/event-bus.ts'), 'utf8');

describe('socket print job bridge metadata', () => {
  it('preserves fiscal/order metadata when forwarding socket jobs to the EventBus', () => {
    expect(ORCHESTRATOR).toContain('referenceType: job.referenceType ?? null');
    expect(ORCHESTRATOR).toContain('referenceId: job.referenceId ?? null');
    expect(ORCHESTRATOR).toContain('openDrawer: job.openDrawer');
    expect(ORCHESTRATOR).toContain('createdAt: job.createdAt');
  });

  it('types print:job-received with the metadata consumed by HardwareModule', () => {
    const eventShape = EVENT_BUS.slice(
      EVENT_BUS.indexOf("'print:job-received'"),
      EVENT_BUS.indexOf("'print:job-completed'"),
    );
    expect(eventShape).toContain('referenceType?: string | null');
    expect(eventShape).toContain('referenceId?: string | null');
    expect(eventShape).toContain('openDrawer?: boolean');
    expect(eventShape).toContain('createdAt?: string');
  });
});
