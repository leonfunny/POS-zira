/**
 * Long-Term Memory - Persistent storage for facts, knowledge, and important information
 * Uses SQLite for persistence across sessions
 */

import { getDatabase } from '../ai-database';
import logger from '../../logger';

// Types of long-term memories
export type MemoryCategory =
  | 'fact'           // Factual information about user/world
  | 'preference'     // User preferences
  | 'skill'          // Learned skills/patterns
  | 'relationship'   // Relationship information
  | 'event'          // Important events
  | 'feedback'       // User feedback about Zira
  | 'correction'     // Corrections Zira learned
  | 'custom';        // Custom memories

// Long-term memory entry
export interface LongTermMemory {
  id: number;
  userId: string;
  category: MemoryCategory;
  key: string;              // Unique key for this memory
  value: string;            // The actual memory content
  context?: string;         // Additional context
  source: string;           // Where this memory came from
  confidence: number;       // 0-100, how confident about this memory
  accessCount: number;      // How often this memory is accessed
  lastAccessed?: Date;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, any>;
}

// Memory search options
export interface SearchOptions {
  category?: MemoryCategory;
  minConfidence?: number;
  limit?: number;
  sortBy?: 'relevance' | 'recent' | 'frequent';
}

/**
 * Long-Term Memory Manager
 * Provides persistent storage for important information
 */
export class LongTermMemoryManager {
  private initialized = false;

  constructor() {
    logger.info('[LongTermMemory] Manager created');
  }

  /**
   * Initialize database tables
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const db = getDatabase();
    if (!db) {
      logger.warn('[LongTermMemory] Database not available');
      return;
    }

    try {
      // Create long-term memory table
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_long_term_memory (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          category TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          context TEXT,
          source TEXT NOT NULL,
          confidence INTEGER DEFAULT 70,
          access_count INTEGER DEFAULT 0,
          last_accessed TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          metadata TEXT,
          UNIQUE(user_id, category, key)
        );

        CREATE INDEX IF NOT EXISTS idx_ltm_user ON ai_long_term_memory(user_id);
        CREATE INDEX IF NOT EXISTS idx_ltm_category ON ai_long_term_memory(category);
        CREATE INDEX IF NOT EXISTS idx_ltm_confidence ON ai_long_term_memory(confidence);
      `);

      this.initialized = true;
      logger.info('[LongTermMemory] Database initialized');
    } catch (error) {
      logger.error('[LongTermMemory] Failed to initialize:', error);
    }
  }

  /**
   * Store a memory
   */
  async store(
    userId: string,
    category: MemoryCategory,
    key: string,
    value: string,
    options: {
      context?: string;
      source?: string;
      confidence?: number;
      metadata?: Record<string, any>;
    } = {}
  ): Promise<number | null> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return null;

    const now = new Date().toISOString();
    const {
      context,
      source = 'conversation',
      confidence = 70,
      metadata,
    } = options;

    try {
      // Upsert memory
      const stmt = db.prepare(`
        INSERT INTO ai_long_term_memory
          (user_id, category, key, value, context, source, confidence, created_at, updated_at, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, category, key) DO UPDATE SET
          value = excluded.value,
          context = excluded.context,
          confidence = excluded.confidence,
          updated_at = excluded.updated_at,
          metadata = excluded.metadata
      `);

      const result = stmt.run(
        userId,
        category,
        key,
        value,
        context || null,
        source,
        confidence,
        now,
        now,
        metadata ? JSON.stringify(metadata) : null
      );

      logger.info(`[LongTermMemory] Stored: ${category}/${key} for ${userId}`);
      return result.lastInsertRowid as number;
    } catch (error) {
      logger.error('[LongTermMemory] Failed to store:', error);
      return null;
    }
  }

  /**
   * Store a fact about the user
   */
  async storeFact(userId: string, key: string, value: string, confidence: number = 80): Promise<number | null> {
    return this.store(userId, 'fact', key, value, { confidence, source: 'learned' });
  }

  /**
   * Store a preference
   */
  async storePreference(userId: string, key: string, value: string): Promise<number | null> {
    return this.store(userId, 'preference', key, value, { confidence: 90, source: 'user_stated' });
  }

  /**
   * Store feedback about Zira
   */
  async storeFeedback(userId: string, feedback: string, isPositive: boolean): Promise<number | null> {
    const key = `feedback_${Date.now()}`;
    return this.store(userId, 'feedback', key, feedback, {
      confidence: 100,
      source: 'user_feedback',
      metadata: { isPositive },
    });
  }

  /**
   * Store a correction (something Zira learned was wrong)
   */
  async storeCorrection(userId: string, wrong: string, correct: string): Promise<number | null> {
    const key = `correction_${Date.now()}`;
    return this.store(userId, 'correction', key, correct, {
      context: `Was incorrectly: ${wrong}`,
      confidence: 95,
      source: 'user_correction',
    });
  }

  /**
   * Retrieve a specific memory
   */
  async get(userId: string, category: MemoryCategory, key: string): Promise<LongTermMemory | null> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return null;

    try {
      const stmt = db.prepare(`
        SELECT * FROM ai_long_term_memory
        WHERE user_id = ? AND category = ? AND key = ?
      `);

      const row = stmt.get(userId, category, key) as any;
      if (!row) return null;

      // Update access count
      db.prepare(`
        UPDATE ai_long_term_memory
        SET access_count = access_count + 1, last_accessed = ?
        WHERE id = ?
      `).run(new Date().toISOString(), row.id);

      return this.rowToMemory(row);
    } catch (error) {
      logger.error('[LongTermMemory] Failed to get:', error);
      return null;
    }
  }

  /**
   * Get all memories for a user by category
   */
  async getByCategory(userId: string, category: MemoryCategory, limit: number = 50): Promise<LongTermMemory[]> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return [];

    try {
      const stmt = db.prepare(`
        SELECT * FROM ai_long_term_memory
        WHERE user_id = ? AND category = ?
        ORDER BY confidence DESC, updated_at DESC
        LIMIT ?
      `);

      const rows = stmt.all(userId, category, limit) as any[];
      return rows.map(row => this.rowToMemory(row));
    } catch (error) {
      logger.error('[LongTermMemory] Failed to get by category:', error);
      return [];
    }
  }

  /**
   * Search memories
   */
  async search(userId: string, query: string, options: SearchOptions = {}): Promise<LongTermMemory[]> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return [];

    const {
      category,
      minConfidence = 0,
      limit = 20,
      sortBy = 'relevance',
    } = options;

    try {
      let sql = `
        SELECT * FROM ai_long_term_memory
        WHERE user_id = ?
          AND confidence >= ?
          AND (
            key LIKE ? OR
            value LIKE ? OR
            context LIKE ?
          )
      `;

      const params: any[] = [userId, minConfidence];
      const searchPattern = `%${query}%`;
      params.push(searchPattern, searchPattern, searchPattern);

      if (category) {
        sql += ` AND category = ?`;
        params.push(category);
      }

      // Sort order
      switch (sortBy) {
        case 'recent':
          sql += ` ORDER BY updated_at DESC`;
          break;
        case 'frequent':
          sql += ` ORDER BY access_count DESC`;
          break;
        default:
          sql += ` ORDER BY confidence DESC, access_count DESC`;
      }

      sql += ` LIMIT ?`;
      params.push(limit);

      const stmt = db.prepare(sql);
      const rows = stmt.all(...params) as any[];

      return rows.map(row => this.rowToMemory(row));
    } catch (error) {
      logger.error('[LongTermMemory] Search failed:', error);
      return [];
    }
  }

  /**
   * Get all facts about a user
   */
  async getFacts(userId: string): Promise<Record<string, string>> {
    const memories = await this.getByCategory(userId, 'fact');
    const facts: Record<string, string> = {};

    for (const memory of memories) {
      facts[memory.key] = memory.value;
    }

    return facts;
  }

  /**
   * Get all preferences for a user
   */
  async getPreferences(userId: string): Promise<Record<string, string>> {
    const memories = await this.getByCategory(userId, 'preference');
    const prefs: Record<string, string> = {};

    for (const memory of memories) {
      prefs[memory.key] = memory.value;
    }

    return prefs;
  }

  /**
   * Get user profile summary
   */
  async getUserProfile(userId: string): Promise<{
    facts: Record<string, string>;
    preferences: Record<string, string>;
    totalMemories: number;
    oldestMemory?: Date;
  }> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return { facts: {}, preferences: {}, totalMemories: 0 };

    const facts = await this.getFacts(userId);
    const preferences = await this.getPreferences(userId);

    // Get stats
    const statsStmt = db.prepare(`
      SELECT COUNT(*) as total, MIN(created_at) as oldest
      FROM ai_long_term_memory
      WHERE user_id = ?
    `);
    const stats = statsStmt.get(userId) as any;

    return {
      facts,
      preferences,
      totalMemories: stats?.total || 0,
      oldestMemory: stats?.oldest ? new Date(stats.oldest) : undefined,
    };
  }

  /**
   * Generate memory context for AI prompt
   */
  async generateMemoryPrompt(userId: string): Promise<string> {
    const facts = await this.getFacts(userId);
    const preferences = await this.getPreferences(userId);
    const corrections = await this.getByCategory(userId, 'correction', 5);

    let prompt = '';

    if (Object.keys(facts).length > 0) {
      prompt += '\n## Known Facts About User\n';
      for (const [key, value] of Object.entries(facts).slice(0, 10)) {
        prompt += `- ${key}: ${value}\n`;
      }
    }

    if (Object.keys(preferences).length > 0) {
      prompt += '\n## User Preferences\n';
      for (const [key, value] of Object.entries(preferences).slice(0, 10)) {
        prompt += `- ${key}: ${value}\n`;
      }
    }

    if (corrections.length > 0) {
      prompt += '\n## Previous Corrections (Don\'t repeat these mistakes)\n';
      for (const correction of corrections) {
        prompt += `- ${correction.context} → Correct: ${correction.value}\n`;
      }
    }

    return prompt;
  }

  /**
   * Delete a memory
   */
  async delete(userId: string, category: MemoryCategory, key: string): Promise<boolean> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return false;

    try {
      const stmt = db.prepare(`
        DELETE FROM ai_long_term_memory
        WHERE user_id = ? AND category = ? AND key = ?
      `);

      const result = stmt.run(userId, category, key);
      logger.info(`[LongTermMemory] Deleted: ${category}/${key} for ${userId}`);
      return result.changes > 0;
    } catch (error) {
      logger.error('[LongTermMemory] Failed to delete:', error);
      return false;
    }
  }

  /**
   * Clear all memories for a user
   */
  async clearUser(userId: string): Promise<number> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return 0;

    try {
      const stmt = db.prepare(`
        DELETE FROM ai_long_term_memory WHERE user_id = ?
      `);

      const result = stmt.run(userId);
      logger.info(`[LongTermMemory] Cleared ${result.changes} memories for ${userId}`);
      return result.changes;
    } catch (error) {
      logger.error('[LongTermMemory] Failed to clear:', error);
      return 0;
    }
  }

  /**
   * Update confidence for a memory
   */
  async updateConfidence(id: number, delta: number): Promise<void> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return;

    try {
      db.prepare(`
        UPDATE ai_long_term_memory
        SET confidence = MIN(100, MAX(0, confidence + ?)),
            updated_at = ?
        WHERE id = ?
      `).run(delta, new Date().toISOString(), id);
    } catch (error) {
      logger.error('[LongTermMemory] Failed to update confidence:', error);
    }
  }

  /**
   * Convert database row to memory object
   */
  private rowToMemory(row: any): LongTermMemory {
    return {
      id: row.id,
      userId: row.user_id,
      category: row.category as MemoryCategory,
      key: row.key,
      value: row.value,
      context: row.context || undefined,
      source: row.source,
      confidence: row.confidence,
      accessCount: row.access_count,
      lastAccessed: row.last_accessed ? new Date(row.last_accessed) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<{
    totalMemories: number;
    byCategory: Record<MemoryCategory, number>;
    uniqueUsers: number;
  }> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return { totalMemories: 0, byCategory: {} as any, uniqueUsers: 0 };

    try {
      const total = db.prepare(`SELECT COUNT(*) as count FROM ai_long_term_memory`).get() as any;
      const users = db.prepare(`SELECT COUNT(DISTINCT user_id) as count FROM ai_long_term_memory`).get() as any;
      const categories = db.prepare(`
        SELECT category, COUNT(*) as count FROM ai_long_term_memory GROUP BY category
      `).all() as any[];

      const byCategory: Record<string, number> = {};
      for (const row of categories) {
        byCategory[row.category] = row.count;
      }

      return {
        totalMemories: total?.count || 0,
        byCategory: byCategory as Record<MemoryCategory, number>,
        uniqueUsers: users?.count || 0,
      };
    } catch (error) {
      logger.error('[LongTermMemory] Failed to get stats:', error);
      return { totalMemories: 0, byCategory: {} as any, uniqueUsers: 0 };
    }
  }
}

// Singleton instance
let longTermInstance: LongTermMemoryManager | null = null;

export function getLongTermMemory(): LongTermMemoryManager {
  if (!longTermInstance) {
    longTermInstance = new LongTermMemoryManager();
  }
  return longTermInstance;
}
