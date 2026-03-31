/**
 * Short-Term Memory - Working memory for active conversations
 * Holds recent context, current task state, and temporary data
 */

import logger from '../../logger';

// Single memory item
export interface MemoryItem {
  id: string;
  type: 'message' | 'action' | 'thought' | 'observation' | 'context';
  content: string;
  metadata?: Record<string, any>;
  importance: number;       // 0-100, affects retention priority
  timestamp: Date;
  expiresAt?: Date;
}

// Conversation context
export interface ConversationContext {
  userId: string;
  sessionId: string;
  startedAt: Date;
  lastActivity: Date;
  topic?: string;           // Current conversation topic
  intent?: string;          // Detected user intent
  pendingTasks: string[];   // Tasks mentioned but not completed
  referencedEntities: string[]; // Names, places, things mentioned
}

// Short-term memory configuration
export interface ShortTermConfig {
  maxItems: number;         // Maximum items to keep
  maxAge: number;           // Max age in minutes
  importanceThreshold: number; // Min importance to keep
}

const DEFAULT_CONFIG: ShortTermConfig = {
  maxItems: 50,
  maxAge: 60,              // 1 hour
  importanceThreshold: 20,
};

/**
 * Short-Term Memory Manager
 * Manages working memory for active conversations
 */
export class ShortTermMemory {
  private items: Map<string, MemoryItem[]> = new Map(); // userId -> items
  private contexts: Map<string, ConversationContext> = new Map();
  private config: ShortTermConfig;

  constructor(config: Partial<ShortTermConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.info('[ShortTermMemory] Initialized');

    // Start cleanup timer
    setInterval(() => this.cleanup(), 5 * 60 * 1000); // Every 5 minutes
  }

  /**
   * Add a memory item
   */
  add(userId: string, item: Omit<MemoryItem, 'id' | 'timestamp'>): string {
    const id = `stm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const memoryItem: MemoryItem = {
      ...item,
      id,
      timestamp: new Date(),
    };

    if (!this.items.has(userId)) {
      this.items.set(userId, []);
    }

    const userItems = this.items.get(userId)!;
    userItems.push(memoryItem);

    // Enforce max items limit
    if (userItems.length > this.config.maxItems) {
      this.pruneItems(userId);
    }

    // Update context last activity
    const context = this.contexts.get(userId);
    if (context) {
      context.lastActivity = new Date();
    }

    logger.debug(`[ShortTermMemory] Added item for ${userId}: ${item.type}`);
    return id;
  }

  /**
   * Add a message to memory
   */
  addMessage(userId: string, role: 'user' | 'assistant', content: string, importance: number = 50): string {
    return this.add(userId, {
      type: 'message',
      content: `${role}: ${content}`,
      importance,
      metadata: { role },
    });
  }

  /**
   * Add an observation (something Zira noticed)
   */
  addObservation(userId: string, observation: string, importance: number = 40): string {
    return this.add(userId, {
      type: 'observation',
      content: observation,
      importance,
    });
  }

  /**
   * Add a thought (internal reasoning)
   */
  addThought(userId: string, thought: string, importance: number = 30): string {
    return this.add(userId, {
      type: 'thought',
      content: thought,
      importance,
    });
  }

  /**
   * Add context information
   */
  addContext(userId: string, context: string, importance: number = 60): string {
    return this.add(userId, {
      type: 'context',
      content: context,
      importance,
    });
  }

  /**
   * Get recent items for a user
   */
  getRecent(userId: string, limit: number = 20, types?: MemoryItem['type'][]): MemoryItem[] {
    const userItems = this.items.get(userId) || [];

    let filtered = userItems;
    if (types && types.length > 0) {
      filtered = userItems.filter(item => types.includes(item.type));
    }

    return filtered
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  /**
   * Get items by importance
   */
  getImportant(userId: string, minImportance: number = 70): MemoryItem[] {
    const userItems = this.items.get(userId) || [];
    return userItems
      .filter(item => item.importance >= minImportance)
      .sort((a, b) => b.importance - a.importance);
  }

  /**
   * Search items by content
   */
  search(userId: string, query: string): MemoryItem[] {
    const userItems = this.items.get(userId) || [];
    const lowerQuery = query.toLowerCase();

    return userItems.filter(item =>
      item.content.toLowerCase().includes(lowerQuery)
    );
  }

  /**
   * Start or update conversation context
   */
  startContext(userId: string, sessionId?: string): ConversationContext {
    const existing = this.contexts.get(userId);

    if (existing && !sessionId) {
      existing.lastActivity = new Date();
      return existing;
    }

    const context: ConversationContext = {
      userId,
      sessionId: sessionId || `session_${Date.now()}`,
      startedAt: new Date(),
      lastActivity: new Date(),
      pendingTasks: [],
      referencedEntities: [],
    };

    this.contexts.set(userId, context);
    logger.info(`[ShortTermMemory] Started context for ${userId}`);
    return context;
  }

  /**
   * Get conversation context
   */
  getContext(userId: string): ConversationContext | null {
    return this.contexts.get(userId) || null;
  }

  /**
   * Update conversation topic
   */
  setTopic(userId: string, topic: string): void {
    const context = this.contexts.get(userId);
    if (context) {
      context.topic = topic;
      context.lastActivity = new Date();
    }
  }

  /**
   * Update user intent
   */
  setIntent(userId: string, intent: string): void {
    const context = this.contexts.get(userId);
    if (context) {
      context.intent = intent;
      context.lastActivity = new Date();
    }
  }

  /**
   * Add pending task
   */
  addPendingTask(userId: string, task: string): void {
    const context = this.contexts.get(userId);
    if (context && !context.pendingTasks.includes(task)) {
      context.pendingTasks.push(task);
    }
  }

  /**
   * Complete pending task
   */
  completePendingTask(userId: string, task: string): void {
    const context = this.contexts.get(userId);
    if (context) {
      context.pendingTasks = context.pendingTasks.filter(t => t !== task);
    }
  }

  /**
   * Add referenced entity
   */
  addEntity(userId: string, entity: string): void {
    const context = this.contexts.get(userId);
    if (context && !context.referencedEntities.includes(entity)) {
      context.referencedEntities.push(entity);
    }
  }

  /**
   * Generate context summary for prompt
   */
  generateContextSummary(userId: string): string {
    const context = this.getContext(userId);
    const recentItems = this.getRecent(userId, 10, ['message', 'observation']);
    const importantItems = this.getImportant(userId, 80);

    let summary = '';

    if (context) {
      if (context.topic) {
        summary += `Current topic: ${context.topic}\n`;
      }
      if (context.intent) {
        summary += `User intent: ${context.intent}\n`;
      }
      if (context.pendingTasks.length > 0) {
        summary += `Pending tasks: ${context.pendingTasks.join(', ')}\n`;
      }
      if (context.referencedEntities.length > 0) {
        summary += `Mentioned: ${context.referencedEntities.slice(-5).join(', ')}\n`;
      }
    }

    if (importantItems.length > 0) {
      summary += '\nImportant notes:\n';
      importantItems.slice(0, 3).forEach(item => {
        summary += `- ${item.content.substring(0, 100)}\n`;
      });
    }

    return summary;
  }

  /**
   * Generate messages for AI context
   */
  generateMessagesForAI(userId: string, limit: number = 20): Array<{ role: string; content: string }> {
    const messages = this.getRecent(userId, limit, ['message']);

    return messages.map(item => {
      const role = item.metadata?.role || 'user';
      const content = item.content.replace(/^(user|assistant): /i, '');
      return { role, content };
    }).reverse(); // Oldest first
  }

  /**
   * Prune items based on age and importance
   */
  private pruneItems(userId: string): void {
    const userItems = this.items.get(userId);
    if (!userItems) return;

    const now = new Date();
    const maxAgeMs = this.config.maxAge * 60 * 1000;

    // Remove expired and low-importance items
    const filtered = userItems.filter(item => {
      const age = now.getTime() - item.timestamp.getTime();
      if (age > maxAgeMs && item.importance < 70) return false;
      if (item.expiresAt && now > item.expiresAt) return false;
      return true;
    });

    // If still over limit, remove lowest importance
    if (filtered.length > this.config.maxItems) {
      filtered.sort((a, b) => b.importance - a.importance);
      filtered.splice(this.config.maxItems);
    }

    this.items.set(userId, filtered);
  }

  /**
   * Cleanup old data
   */
  private cleanup(): void {
    const now = new Date();
    const maxAgeMs = this.config.maxAge * 60 * 1000;

    // Cleanup items
    for (const [userId, items] of this.items.entries()) {
      const filtered = items.filter(item => {
        const age = now.getTime() - item.timestamp.getTime();
        return age <= maxAgeMs || item.importance >= 70;
      });

      if (filtered.length !== items.length) {
        this.items.set(userId, filtered);
        logger.debug(`[ShortTermMemory] Cleaned ${items.length - filtered.length} items for ${userId}`);
      }

      if (filtered.length === 0) {
        this.items.delete(userId);
        this.contexts.delete(userId);
      }
    }

    // Cleanup stale contexts
    for (const [userId, context] of this.contexts.entries()) {
      const inactiveTime = now.getTime() - context.lastActivity.getTime();
      if (inactiveTime > maxAgeMs) {
        this.contexts.delete(userId);
        logger.debug(`[ShortTermMemory] Removed stale context for ${userId}`);
      }
    }
  }

  /**
   * Clear all memory for a user
   */
  clear(userId: string): void {
    this.items.delete(userId);
    this.contexts.delete(userId);
    logger.info(`[ShortTermMemory] Cleared memory for ${userId}`);
  }

  /**
   * Clear all memory
   */
  clearAll(): void {
    this.items.clear();
    this.contexts.clear();
    logger.info('[ShortTermMemory] Cleared all memory');
  }

  /**
   * Get memory stats
   */
  getStats(): {
    totalUsers: number;
    totalItems: number;
    activeContexts: number;
  } {
    let totalItems = 0;
    for (const items of this.items.values()) {
      totalItems += items.length;
    }

    return {
      totalUsers: this.items.size,
      totalItems,
      activeContexts: this.contexts.size,
    };
  }
}

// Singleton instance
let shortTermInstance: ShortTermMemory | null = null;

export function getShortTermMemory(): ShortTermMemory {
  if (!shortTermInstance) {
    shortTermInstance = new ShortTermMemory();
  }
  return shortTermInstance;
}
