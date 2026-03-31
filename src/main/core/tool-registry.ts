/**
 * Tool Registry for AI agent
 *
 * Modules register their tool definitions here.
 * The AI module queries the registry to build the OpenAI tools array
 * and dispatches execution to the owning module.
 */

import type OpenAI from 'openai';
import logger from '../logger';

export interface ToolDefinition {
  /** OpenAI function-calling schema */
  definition: OpenAI.ChatCompletionTool;
  /** Module that owns this tool */
  module: string;
  /** Grouping category (e.g. 'browser', 'hardware', 'booksy') */
  category: string;
  /** Execute the tool and return a human-readable result string */
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  /**
   * Register a tool. Warns on duplicate names.
   */
  register(tool: ToolDefinition): void {
    const name = tool.definition.function.name;
    if (this.tools.has(name)) {
      logger.warn(`[ToolRegistry] Overwriting tool "${name}" (was ${this.tools.get(name)!.module}, now ${tool.module})`);
    }
    this.tools.set(name, tool);
    logger.debug(`[ToolRegistry] Registered tool "${name}" from module "${tool.module}"`);
  }

  /**
   * Register multiple tools at once.
   */
  registerMany(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * Unregister all tools owned by a specific module.
   */
  unregisterModule(moduleName: string): void {
    const toRemove: string[] = [];
    for (const [name, tool] of this.tools) {
      if (tool.module === moduleName) {
        toRemove.push(name);
      }
    }
    for (const name of toRemove) {
      this.tools.delete(name);
    }
    if (toRemove.length > 0) {
      logger.debug(`[ToolRegistry] Unregistered ${toRemove.length} tools from module "${moduleName}"`);
    }
  }

  /**
   * Get OpenAI tool definitions for function calling.
   * Replaces the static ZIRA_TOOLS array.
   */
  getOpenAITools(): OpenAI.ChatCompletionTool[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /**
   * Get tools filtered by category.
   */
  getToolsByCategory(category: string): ToolDefinition[] {
    return Array.from(this.tools.values()).filter((t) => t.category === category);
  }

  /**
   * Get tools filtered by module.
   */
  getToolsByModule(moduleName: string): ToolDefinition[] {
    return Array.from(this.tools.values()).filter((t) => t.module === moduleName);
  }

  /**
   * Execute a tool by name. Returns result string.
   * Replaces the executeTool() giant switch statement.
   */
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      logger.warn(`[ToolRegistry] Unknown tool "${name}"`);
      return `❌ Tool "${name}" not found in registry`;
    }

    const start = Date.now();
    try {
      const result = await tool.execute(args);
      const elapsed = Date.now() - start;
      logger.info(`[ToolRegistry] Executed "${name}" (${tool.module}) in ${elapsed}ms`);
      return result;
    } catch (error: any) {
      const elapsed = Date.now() - start;
      logger.error(`[ToolRegistry] Tool "${name}" failed after ${elapsed}ms:`, error);
      return `❌ Tool "${name}" error: ${error.message || String(error)}`;
    }
  }

  /**
   * Check if a tool is registered.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get the number of registered tools.
   */
  get size(): number {
    return this.tools.size;
  }

  /**
   * List all registered tool names (for debugging).
   */
  listTools(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get a summary of tools grouped by module.
   */
  getSummary(): Record<string, string[]> {
    const summary: Record<string, string[]> = {};
    for (const [name, tool] of this.tools) {
      if (!summary[tool.module]) {
        summary[tool.module] = [];
      }
      summary[tool.module].push(name);
    }
    return summary;
  }

  /**
   * Clear all tools (for shutdown).
   */
  clear(): void {
    this.tools.clear();
  }
}
