/**
 * BrowserModule
 *
 * Owns BrowserController + Chrome Extension WebSocket server (port 19999).
 * Registers browser automation and Facebook tools in the ToolRegistry.
 */

import { ipcMain } from 'electron';
import { WebSocketServer, WebSocket } from 'ws';
import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import type { EventBus } from '../core/event-bus';
import type { ToolDefinition } from '../core/tool-registry';
import { SERVICE_TOKENS } from '../core/tokens';
import { BrowserController } from '../browser/browser-controller';
import {
  setGlobalExtensionSocket,
  handleGlobalExtensionResponse,
  executeTool,
} from '../ai/zira-ai';
import logger from '../logger';

export class BrowserModule extends BaseModule {
  readonly name = 'browser';

  private browserController: BrowserController | null = null;
  private wss: WebSocketServer | null = null;
  private extensionSocket: WebSocket | null = null;

  constructor(private container: ServiceContainer) {
    super();
  }

  async init(): Promise<void> {
    logger.info('[BrowserModule] Initializing...');
    this.browserController = new BrowserController();
    this.container.set(SERVICE_TOKENS.BROWSER_CONTROLLER, this.browserController);
    this.initExtensionServer();
    this.setState(ModuleState.READY);
  }

  private initExtensionServer(): void {
    try {
      this.wss = new WebSocketServer({ port: 19999 });

      this.wss.on('connection', (ws) => {
        logger.info('[BrowserModule] Extension connected');
        this.extensionSocket = ws;
        setGlobalExtensionSocket(ws);

        // Pass to ZiraAI if it exists
        const ziraAI = this.container.getOptional<any>(SERVICE_TOKENS.ZIRA_AI);
        if (ziraAI) ziraAI.setExtensionSocket?.(ws);

        ws.on('message', (message) => {
          try {
            const msg = JSON.parse(message.toString());
            if (msg.type === 'RESULT') handleGlobalExtensionResponse(msg.id, msg.data);
          } catch {}
        });

        ws.on('close', () => {
          this.extensionSocket = null;
          setGlobalExtensionSocket(null);
          const ai = this.container.getOptional<any>(SERVICE_TOKENS.ZIRA_AI);
          if (ai) ai.setExtensionSocket?.(null);
        });
      });

      this.wss.on('error', (err) => logger.error('[BrowserModule] WS error:', err));
      this.container.set(SERVICE_TOKENS.EXTENSION_WSS, this.wss);
    } catch (e: any) {
      logger.error('[BrowserModule] WS server failed:', e);
    }
  }

  registerIpcHandlers(): void {
    // Chrome detection handlers
    ipcMain.handle('shell:launchChromeDebug', async (_, port: number = 9222) => {
      try {
        // Validate port to prevent command injection
        const safePort = Number(port);
        if (!Number.isInteger(safePort) || safePort < 1024 || safePort > 65535) {
          throw new Error(`Invalid port: ${port}. Must be an integer between 1024-65535.`);
        }
        const { execFile } = require('child_process');
        const fs = require('fs');
        const { join } = require('path');
        const { app } = require('electron');
        const chromePaths = [
          process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
          process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
          process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
        ];
        let chromePath = '';
        for (const p of chromePaths) {
          try { if (fs.existsSync(p)) { chromePath = p; break; } } catch {}
        }
        if (!chromePath) throw new Error('Chrome not found. Please install Google Chrome.');
        const userDataDir = join(app.getPath('userData'), 'booksy-chrome-profile');
        execFile(chromePath, [
          `--remote-debugging-port=${safePort}`,
          `--user-data-dir=${userDataDir}`,
          'https://pro.booksy.com',
        ], (error: any) => { if (error) logger.error('[BrowserModule] Chrome launch error:', error); });
        return { success: true, chromePath };
      } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('chrome:isRunning', async () => {
      try {
        const { isChromeRunning } = await import('../browser/chrome-checker');
        return isChromeRunning();
      } catch { return { isRunning: false }; }
    });

    ipcMain.handle('chrome:checkAndPrompt', async () => {
      try {
        const { checkChromeAndPrompt } = await import('../browser/chrome-checker');
        const mainWindow = this.container.getOptional<Electron.BrowserWindow>(SERVICE_TOKENS.MAIN_WINDOW);
        return checkChromeAndPrompt(mainWindow || undefined);
      } catch (e: any) { return { ready: false, error: e.message }; }
    });

    ipcMain.handle('chrome:forceClose', async () => {
      try {
        const { killChromeProcesses, isChromeRunning } = await import('../browser/chrome-checker');
        const killed = await killChromeProcesses();
        await new Promise((r) => setTimeout(r, 1000));
        const check = await isChromeRunning();
        return { success: killed && !check.isRunning };
      } catch (e: any) { return { success: false, error: e.message }; }
    });

    logger.info('[BrowserModule] IPC handlers registered');
  }

  getToolDefinitions(): ToolDefinition[] {
    const browserTools = [
      'browser_setup', 'select_chrome_profile', 'kill_chrome', 'browser_check_login',
      'browser_open_and_read', 'browser_screenshot', 'browser_scroll_and_read',
      'browser_click', 'browser_close', 'browser_type', 'browser_get_posts',
      'browser_find_posts_by_topic', 'browser_comment_on_post', 'browser_summarize',
    ];
    const facebookTools = [
      'facebook_create_post', 'facebook_like_post', 'facebook_share_post',
      'facebook_get_notifications', 'facebook_get_messages', 'facebook_reply_message',
      'facebook_search', 'facebook_get_posts', 'facebook_find_posts', 'facebook_comment',
    ];

    // Import tool definitions from ZIRA_TOOLS array for now
    // These will be the source of truth until tools are fully decoupled
    const { ZIRA_TOOLS } = require('../ai/zira-ai');
    const defs: ToolDefinition[] = [];

    for (const toolName of [...browserTools, ...facebookTools]) {
      const ziraDef = ZIRA_TOOLS.find((t: any) => t.function.name === toolName);
      if (ziraDef) {
        defs.push({
          definition: ziraDef,
          module: this.name,
          category: facebookTools.includes(toolName) ? 'facebook' : 'browser',
          execute: async (args) => executeTool(toolName, args),
        });
      }
    }

    return defs;
  }

  registerEventHandlers(_bus: EventBus): void {}

  async start(): Promise<void> { this.setState(ModuleState.RUNNING); }

  async stop(): Promise<void> {
    this.extensionSocket?.close();
    this.wss?.close();
    this.browserController?.destroy();
    this.setState(ModuleState.STOPPED);
  }

  async destroy(): Promise<void> { this.setState(ModuleState.STOPPED); }
}
