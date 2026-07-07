import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('AgentOrchestrator startup order', () => {
  it('shows the main window after IPC and EventBus handlers, before slower socket/tools/tray/start work', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/main/core/orchestrator.ts'),
      'utf8',
    );
    const initializeBody = source.slice(
      source.indexOf('async initialize(): Promise<void>'),
      source.indexOf('  showWindow(): void'),
    );

    const ipcHandlers = initializeBody.indexOf("this.logStep('Registering IPC handlers...')");
    const eventHandlers = initializeBody.indexOf("this.logStep('Registering event handlers...')");
    const showWindow = initializeBody.indexOf("this.logStep('Showing main window...')");
    const socketHandlers = initializeBody.indexOf("this.logStep('Wiring socket handlers...')");
    const toolCollection = initializeBody.indexOf("this.logStep('Collecting tool definitions...')");
    const trayCreation = initializeBody.indexOf("this.logStep('Creating system tray...')");
    const moduleStart = initializeBody.indexOf("this.logStep('Starting modules...')");

    expect(ipcHandlers).toBeGreaterThanOrEqual(0);
    expect(eventHandlers).toBeGreaterThan(ipcHandlers);
    expect(showWindow).toBeGreaterThan(eventHandlers);
    expect(socketHandlers).toBeGreaterThan(showWindow);
    expect(toolCollection).toBeGreaterThan(showWindow);
    expect(trayCreation).toBeGreaterThan(showWindow);
    expect(moduleStart).toBeGreaterThan(showWindow);
  });
});
