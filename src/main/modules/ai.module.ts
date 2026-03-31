/**
 * AiModule
 *
 * Owns ZiraAI instance, AI IPC handlers, tool detection, and proxy mode.
 * KEY CHANGE: Uses ToolRegistry instead of ZIRA_TOOLS array and executeTool() switch.
 */

import { ipcMain, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import type { EventBus } from '../core/event-bus';
import type { ToolDefinition, ToolRegistry } from '../core/tool-registry';
import { SERVICE_TOKENS } from '../core/tokens';
import {
  ZiraAI,
  setBooksySyncProvider,
  ZIRA_TOOLS,
  executeTool,
  filterIdentity,
  handleProfileSelection,
} from '../ai/zira-ai';
import {
  IPC_CHANNELS,
  ZiraAIStatus,
} from '../../shared/types';
import { ApiClient } from '../network/api-client';
import {
  getConfig,
  getConfigValue,
  setConfigValue,
  getSecureAuthToken,
  getSecureAiApiKey,
} from '../config/store';
import logger from '../logger';

export class AiModule extends BaseModule {
  readonly name = 'ai';

  private ziraAI: ZiraAI | null = null;
  private proxyHistory = new Map<string, { role: string; content: string }[]>();
  private pendingAttachments: any[] = [];
  private serverProvidedAiKey: string | null = null;

  constructor(private container: ServiceContainer) {
    super();
  }

  async init(): Promise<void> {
    logger.info('[AiModule] Initializing...');

    // Wire booksy provider
    const booksySync = this.container.getOptional<any>(SERVICE_TOKENS.BOOKSY_SYNC);
    if (booksySync) setBooksySyncProvider(() => booksySync);

    await this.initializeZiraAI();

    this.container.set(SERVICE_TOKENS.ZIRA_AI, this.ziraAI);
    this.setState(ModuleState.READY);
    logger.info('[AiModule] Initialized');
  }

  private async initializeZiraAI(): Promise<void> {
    const enabled = getConfigValue('aiEnabled');
    if (!enabled) { this.ziraAI = null; return; }

    let apiKey: string | null = null;

    // Env key (dev)
    const envKey = process.env.OPENROUTER_API_KEY || process.env.AI_API_KEY;
    if (envKey) apiKey = envKey;

    // Server-provided key
    if (!apiKey && this.serverProvidedAiKey) apiKey = this.serverProvidedAiKey;

    // Local encrypted key
    if (!apiKey) {
      const localKey = getSecureAiApiKey();
      const useLocal = getConfigValue('aiLocalMode') as boolean;
      if (localKey && useLocal) apiKey = localKey;
    }

    if (apiKey) {
      try {
        this.ziraAI = new ZiraAI({
          apiKey,
          model: (getConfigValue('aiModel') as string) || 'x-ai/grok-4.1-fast',
          provider: 'openrouter',
        });
        setConfigValue('aiProxyMode', false);
      } catch (e: any) {
        logger.error('[AiModule] Failed to init local AI:', e);
        setConfigValue('aiProxyMode', true);
        this.ziraAI = null;
      }
    } else {
      setConfigValue('aiProxyMode', true);
      this.ziraAI = null;
    }
  }

  setServerAiKey(apiKey: string | null): void {
    this.serverProvidedAiKey = apiKey;
    if (apiKey) this.initializeZiraAI();
  }

  registerIpcHandlers(): void {
    ipcMain.handle(IPC_CHANNELS.AI_GET_STATUS, () => this.getStatus());

    ipcMain.handle(IPC_CHANNELS.AI_CHAT, async (_, message: string, userId?: string, attachments?: any[]) => {
      if (!message || typeof message !== 'string' || message.length > 10000) {
        return { success: false, error: 'Invalid message' };
      }
      const sanitized = message.replace(/[<>]/g, '').trim().slice(0, 10000);

      // Save attachments to temp
      if (attachments?.length) {
        const tempDir = path.join(app.getPath('temp'), 'zira-attachments');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const saved: any[] = [];
        for (const att of attachments) {
          try {
            const base64Data = att.data.replace(/^data:[^;]+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');
            const ext = att.type === 'image' ? '.png' : '.mp4';
            const filePath = path.join(tempDir, `${Date.now()}_${att.name.replace(/[^a-zA-Z0-9.]/g, '_')}${ext}`);
            fs.writeFileSync(filePath, buffer);
            saved.push({ type: att.type, name: att.name, path: filePath });
          } catch {}
        }
        this.pendingAttachments = saved;
      }

      try {
        // LOCAL MODE: Use ZiraAI with tools
        if (this.ziraAI) {
          const result = await this.ziraAI.chat(sanitized, userId);
          return { success: true, data: { content: result.content, model: result.model, provider: result.provider } };
        }

        // HYBRID MODE: local tool detection + server AI
        // Profile selection
        const profileResult = await handleProfileSelection(sanitized);
        if (profileResult) {
          return { success: true, data: { content: profileResult, model: 'local-profile-selector', toolExecuted: 'select_chrome_profile' } };
        }

        // Tool detection from message patterns
        const toolMatch = this.detectToolFromMessage(sanitized);
        if (toolMatch) {
          // Try ToolRegistry first, fall back to legacy executeTool
          const registry = this.container.getOptional<ToolRegistry>(SERVICE_TOKENS.TOOL_REGISTRY);
          let toolResult: string;
          if (registry?.has(toolMatch.name)) {
            toolResult = await registry.execute(toolMatch.name, toolMatch.args);
          } else {
            toolResult = await executeTool(toolMatch.name, toolMatch.args);
          }
          return { success: true, data: { content: toolResult, model: 'local-tools', toolExecuted: toolMatch.name } };
        }

        // Server AI
        const authToken = getSecureAuthToken();
        if (!authToken) return { success: false, error: 'Please login to use AI chat' };

        const serverUrl = getConfigValue('serverUrl') || 'https://api.enail.pro';
        const client = new ApiClient(serverUrl as string);
        const convId = userId || 'default';
        const history = this.proxyHistory.get(convId) || [];

        // Get tools from registry (or fallback to ZIRA_TOOLS)
        const registry = this.container.getOptional<ToolRegistry>(SERVICE_TOKENS.TOOL_REGISTRY);
        const tools = registry && registry.size > 0 ? registry.getOpenAITools() : ZIRA_TOOLS;

        const result = await client.aiChat(authToken, sanitized, history, undefined, tools);

        if (result.success && result.data) {
          let finalContent = result.data.content || '';

          // Execute server-requested tools locally
          if (result.data.tool_calls?.length) {
            const toolResults: string[] = [];
            for (const tc of result.data.tool_calls) {
              const name = tc.function.name;
              let args: Record<string, unknown> = {};
              try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}

              let tr: string;
              if (registry?.has(name)) {
                tr = await registry.execute(name, args);
              } else {
                tr = await executeTool(name, args);
              }
              toolResults.push(tr);
            }
            const combined = toolResults.join('\n\n');
            finalContent = finalContent ? `${finalContent}\n\n${combined}` : combined;
          }

          finalContent = filterIdentity(finalContent);

          // Store history
          const h = this.proxyHistory.get(convId) || [];
          h.push({ role: 'user', content: sanitized });
          h.push({ role: 'assistant', content: finalContent });
          if (h.length > 20) h.splice(0, h.length - 20);
          this.proxyHistory.set(convId, h);

          return { success: true, data: { ...result.data, content: finalContent } };
        }

        return { success: false, error: result.error || 'AI service unavailable' };
      } catch (e: any) {
        logger.error('[AiModule] AI_CHAT failed:', e);
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle(IPC_CHANNELS.AI_CLEAR_HISTORY, (_, userId?: string) => {
      this.ziraAI?.clearHistory(userId);
      this.proxyHistory.delete(userId || 'default');
      return { success: true };
    });

    logger.info('[AiModule] IPC handlers registered');
  }

  private getStatus(): ZiraAIStatus {
    const authToken = getSecureAuthToken();
    const isAuthenticated = !!authToken;
    const isLocalMode = !!this.ziraAI;
    const hasServerKey = !!this.serverProvidedAiKey;
    const hasLocalKey = !!getSecureAiApiKey();
    const hybridToolsEnabled = isAuthenticated;

    return {
      enabled: getConfigValue('aiEnabled') || false,
      ready: isLocalMode || isAuthenticated,
      model: isLocalMode ? (getConfigValue('aiModel') as string) || 'x-ai/grok-4.1-fast' : 'hybrid-mode',
      hasApiKey: hasServerKey || hasLocalKey || isAuthenticated,
      localMode: isLocalMode,
      toolsEnabled: isLocalMode || hybridToolsEnabled,
      keySource: hasServerKey ? 'server' : (hasLocalKey ? 'local' : 'hybrid'),
    };
  }

  /**
   * Detect tool from user message patterns (Vietnamese + English).
   * Copied from PrintAgentApp.detectToolFromMessage() - can be simplified later.
   */
  private detectToolFromMessage(message: string): { name: string; args: any } | null {
    const msg = message.toLowerCase().trim();

    // Browser/URL patterns
    if (/(mở|open|xem|check|lướt|browse|vào)\s*(facebook|fb)\b/i.test(msg)) return { name: 'browser_setup', args: { url: 'facebook.com' } };
    if (/(mở|open|xem|check|vào)\s*(gmail|email|mail)\b/i.test(msg)) return { name: 'browser_setup', args: { url: 'gmail.com' } };
    if (/(mở|open|xem|check|vào)\s*(youtube|yt)\b/i.test(msg)) return { name: 'browser_setup', args: { url: 'youtube.com' } };
    if (/(mở|open|vào)\s*(chrome|trình duyệt|browser)\b/i.test(msg)) return { name: 'open_chrome', args: {} };

    const urlMatch = msg.match(/(mở|open|xem|go to|truy cập|vào)\s+(https?:\/\/\S+|www\.\S+|\S+\.(com|net|org|io|vn|pro))/i);
    if (urlMatch) return { name: 'browser_setup', args: { url: urlMatch[2] } };

    // Booksy patterns
    if (/(mai|tomorrow).*(bao nhiêu|mấy|có ai|khách|lịch|booking)/i.test(msg) || /(bao nhiêu|mấy|có ai|khách|lịch).*(mai|tomorrow)/i.test(msg)) return { name: 'booksy_get_bookings', args: { date: 'tomorrow' } };
    if (/(hôm nay|today).*(bao nhiêu|mấy|có ai|khách|lịch|booking)/i.test(msg) || /(bao nhiêu|mấy|có ai|khách|lịch).*(hôm nay|today)/i.test(msg)) return { name: 'booksy_get_bookings', args: { date: 'today' } };

    // Screenshot
    if (/(chụp|screenshot|capture|chụp màn hình|screen)/i.test(msg)) return { name: 'take_screenshot', args: {} };

    // App open patterns
    if (/(mở|open)\s*(notepad)/i.test(msg)) return { name: 'open_application', args: { app_name: 'notepad' } };
    if (/(mở|open)\s*(calculator|máy tính)/i.test(msg)) return { name: 'open_application', args: { app_name: 'calculator' } };

    // Login confirmation
    if (/^(xong rồi|done|đã đăng nhập|logged in|xong|ok rồi)/i.test(msg)) return { name: 'browser_check_login', args: {} };

    // Close browser
    if (/(đóng|close|tắt).*(browser|trình duyệt|tab|chrome)/i.test(msg) || /^(đóng|close|tắt)$/i.test(msg)) return { name: 'browser_close', args: {} };

    return null;
  }

  getToolDefinitions(): ToolDefinition[] {
    // AI module's own tools (media analysis, content generation)
    return [
      {
        definition: {
          type: 'function',
          function: {
            name: 'analyze_image',
            description: 'Analyze an image and describe its content',
            parameters: {
              type: 'object',
              properties: { image_path: { type: 'string', description: 'Path to the image file' } },
              required: ['image_path'],
            },
          },
        },
        module: this.name,
        category: 'media',
        execute: async (args) => executeTool('analyze_image', args),
      },
      {
        definition: {
          type: 'function',
          function: {
            name: 'analyze_video',
            description: 'Extract frames and analyze video content',
            parameters: {
              type: 'object',
              properties: { video_path: { type: 'string', description: 'Path to the video file' } },
              required: ['video_path'],
            },
          },
        },
        module: this.name,
        category: 'media',
        execute: async (args) => executeTool('analyze_video', args),
      },
      {
        definition: {
          type: 'function',
          function: {
            name: 'generate_post_content',
            description: 'Generate social media post content from image or video',
            parameters: {
              type: 'object',
              properties: { topic: { type: 'string', description: 'Post topic or context' } },
              required: [],
            },
          },
        },
        module: this.name,
        category: 'media',
        execute: async (args) => executeTool('generate_post_content', args),
      },
    ];
  }

  registerEventHandlers(bus: EventBus): void {
    // Clear AI history on logout
    bus.on('user:logged-out', () => {
      logger.info('[AiModule] User logged out, clearing AI state');
      this.ziraAI?.clearHistory();
      this.proxyHistory.clear();
    });

    // Re-initialize AI when config changes (key, model, enabled/disabled)
    bus.on('config:changed', async (payload) => {
      const aiKeys = ['aiEnabled', 'aiModel', 'aiLocalMode', 'aiApiKey'];
      if (payload.changedKeys.some(k => aiKeys.includes(k))) {
        logger.info('[AiModule] AI config changed, reinitializing...');
        await this.initializeZiraAI();
        this.container.set(SERVICE_TOKENS.ZIRA_AI, this.ziraAI);
      }
    });
  }

  async start(): Promise<void> { this.setState(ModuleState.RUNNING); }

  async stop(): Promise<void> {
    this.ziraAI?.destroy();
    this.ziraAI = null;
    this.proxyHistory.clear();
    this.setState(ModuleState.STOPPED);
  }

  async destroy(): Promise<void> { this.setState(ModuleState.STOPPED); }
}
