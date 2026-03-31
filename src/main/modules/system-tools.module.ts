/**
 * SystemToolsModule
 *
 * Registers system-level AI tools: open_chrome, open_url, open_application,
 * get_system_info, run_command, open_folder, take_screenshot.
 *
 * Also registers mouse/keyboard input tools.
 */

import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import type { EventBus } from '../core/event-bus';
import type { ToolDefinition } from '../core/tool-registry';
import { executeTool, ZIRA_TOOLS } from '../ai/zira-ai';
import logger from '../logger';

export class SystemToolsModule extends BaseModule {
  readonly name = 'system-tools';

  constructor(private container: ServiceContainer) {
    super();
  }

  async init(): Promise<void> {
    this.setState(ModuleState.READY);
  }

  registerIpcHandlers(): void {
    // No IPC handlers - these are AI-only tools
  }

  getToolDefinitions(): ToolDefinition[] {
    const systemToolNames = [
      'open_chrome', 'open_url', 'open_application', 'get_system_info',
      'run_command', 'open_folder', 'take_screenshot',
    ];
    const inputToolNames = [
      'mouse_click', 'mouse_double_click', 'mouse_right_click',
      'mouse_move', 'mouse_scroll', 'mouse_drag',
      'keyboard_type', 'keyboard_press', 'keyboard_hotkey',
    ];

    const allNames = [...systemToolNames, ...inputToolNames];
    const defs: ToolDefinition[] = [];

    for (const name of allNames) {
      const ziraDef = ZIRA_TOOLS.find((t: any) => t.function.name === name);
      if (ziraDef) {
        defs.push({
          definition: ziraDef,
          module: this.name,
          category: inputToolNames.includes(name) ? 'input' : 'system',
          execute: async (args) => executeTool(name, args),
        });
      }
    }

    return defs;
  }

  registerEventHandlers(_bus: EventBus): void {}

  async start(): Promise<void> { this.setState(ModuleState.RUNNING); }
  async stop(): Promise<void> { this.setState(ModuleState.STOPPED); }
  async destroy(): Promise<void> { this.setState(ModuleState.STOPPED); }
}
