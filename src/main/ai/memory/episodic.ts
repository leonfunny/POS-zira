/**
 * Episodic Memory - Stores past experiences and events
 * Records important interactions, achievements, and emotional moments
 */

import { getDatabase } from '../ai-database';
import logger from '../../logger';
import { PrimaryEmotion } from '../personality/emotions';

// Types of episodes
export type EpisodeType =
  | 'conversation'    // Notable conversation
  | 'achievement'     // User achieved something
  | 'problem_solved'  // Zira helped solve a problem
  | 'mistake'         // Zira made a mistake (for learning)
  | 'first_meeting'   // First interaction with user
  | 'milestone'       // Relationship milestone
  | 'emotional'       // Emotionally significant moment
  | 'learning'        // Learned something new
  | 'celebration';    // Celebratory moment

// An episode (memory of an experience)
export interface Episode {
  id: number;
  userId: string;
  type: EpisodeType;
  title: string;              // Brief title of the episode
  description: string;        // What happened
  outcome: string;            // How it ended (positive/negative/neutral)
  emotion?: PrimaryEmotion;   // Emotional context
  emotionIntensity?: number;  // How strong was the emotion
  participants?: string[];    // Who was involved
  tags: string[];             // Tags for searching
  importance: number;         // 0-100
  lessonsLearned?: string[];  // What Zira learned from this
  timestamp: Date;
  metadata?: Record<string, any>;
}

// Episode search options
export interface EpisodeSearchOptions {
  type?: EpisodeType;
  emotion?: PrimaryEmotion;
  minImportance?: number;
  tags?: string[];
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
}

/**
 * Episodic Memory Manager
 * Stores and retrieves past experiences
 */
export class EpisodicMemoryManager {
  private initialized = false;

  constructor() {
    logger.info('[EpisodicMemory] Manager created');
  }

  /**
   * Initialize database tables
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const db = getDatabase();
    if (!db) {
      logger.warn('[EpisodicMemory] Database not available');
      return;
    }

    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_episodes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          outcome TEXT NOT NULL,
          emotion TEXT,
          emotion_intensity INTEGER,
          participants TEXT,
          tags TEXT NOT NULL,
          importance INTEGER DEFAULT 50,
          lessons_learned TEXT,
          timestamp TEXT NOT NULL,
          metadata TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_episodes_user ON ai_episodes(user_id);
        CREATE INDEX IF NOT EXISTS idx_episodes_type ON ai_episodes(type);
        CREATE INDEX IF NOT EXISTS idx_episodes_importance ON ai_episodes(importance);
        CREATE INDEX IF NOT EXISTS idx_episodes_timestamp ON ai_episodes(timestamp);
      `);

      this.initialized = true;
      logger.info('[EpisodicMemory] Database initialized');
    } catch (error) {
      logger.error('[EpisodicMemory] Failed to initialize:', error);
    }
  }

  /**
   * Record a new episode
   */
  async record(
    userId: string,
    episode: Omit<Episode, 'id' | 'userId' | 'timestamp'>
  ): Promise<number | null> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return null;

    try {
      const stmt = db.prepare(`
        INSERT INTO ai_episodes
          (user_id, type, title, description, outcome, emotion, emotion_intensity,
           participants, tags, importance, lessons_learned, timestamp, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        userId,
        episode.type,
        episode.title,
        episode.description,
        episode.outcome,
        episode.emotion || null,
        episode.emotionIntensity || null,
        episode.participants ? JSON.stringify(episode.participants) : null,
        JSON.stringify(episode.tags),
        episode.importance,
        episode.lessonsLearned ? JSON.stringify(episode.lessonsLearned) : null,
        new Date().toISOString(),
        episode.metadata ? JSON.stringify(episode.metadata) : null
      );

      logger.info(`[EpisodicMemory] Recorded episode: ${episode.title} for ${userId}`);
      return result.lastInsertRowid as number;
    } catch (error) {
      logger.error('[EpisodicMemory] Failed to record:', error);
      return null;
    }
  }

  /**
   * Record a conversation episode
   */
  async recordConversation(
    userId: string,
    title: string,
    description: string,
    wasHelpful: boolean,
    emotion?: PrimaryEmotion
  ): Promise<number | null> {
    return this.record(userId, {
      type: 'conversation',
      title,
      description,
      outcome: wasHelpful ? 'positive' : 'neutral',
      emotion,
      tags: ['conversation'],
      importance: wasHelpful ? 60 : 40,
    });
  }

  /**
   * Record when Zira helped solve a problem
   */
  async recordProblemSolved(
    userId: string,
    problem: string,
    solution: string,
    difficulty: 'easy' | 'medium' | 'hard'
  ): Promise<number | null> {
    const importance = difficulty === 'hard' ? 90 : difficulty === 'medium' ? 70 : 50;

    return this.record(userId, {
      type: 'problem_solved',
      title: `Solved: ${problem.substring(0, 50)}`,
      description: `Problem: ${problem}\nSolution: ${solution}`,
      outcome: 'positive',
      emotion: 'happy',
      emotionIntensity: importance,
      tags: ['problem', 'solved', difficulty],
      importance,
      lessonsLearned: [`Solution for "${problem}": ${solution}`],
    });
  }

  /**
   * Record a mistake (for learning)
   */
  async recordMistake(
    userId: string,
    mistake: string,
    correction: string,
    lesson: string
  ): Promise<number | null> {
    return this.record(userId, {
      type: 'mistake',
      title: `Mistake: ${mistake.substring(0, 50)}`,
      description: `Mistake: ${mistake}\nCorrection: ${correction}`,
      outcome: 'negative',
      emotion: 'apologetic',
      emotionIntensity: 70,
      tags: ['mistake', 'learning', 'correction'],
      importance: 85, // High importance to remember mistakes
      lessonsLearned: [lesson],
    });
  }

  /**
   * Record first meeting with a user
   */
  async recordFirstMeeting(userId: string, userName?: string): Promise<number | null> {
    return this.record(userId, {
      type: 'first_meeting',
      title: `First meeting with ${userName || 'user'}`,
      description: `Started relationship with ${userName || 'new user'}`,
      outcome: 'positive',
      emotion: 'excited',
      emotionIntensity: 70,
      tags: ['first_meeting', 'relationship'],
      importance: 90, // Very important to remember
    });
  }

  /**
   * Record a milestone
   */
  async recordMilestone(
    userId: string,
    milestone: string,
    significance: string
  ): Promise<number | null> {
    return this.record(userId, {
      type: 'milestone',
      title: milestone,
      description: significance,
      outcome: 'positive',
      emotion: 'happy',
      emotionIntensity: 80,
      tags: ['milestone', 'achievement'],
      importance: 85,
    });
  }

  /**
   * Record an emotional moment
   */
  async recordEmotionalMoment(
    userId: string,
    description: string,
    emotion: PrimaryEmotion,
    intensity: number
  ): Promise<number | null> {
    return this.record(userId, {
      type: 'emotional',
      title: `Emotional moment: ${emotion}`,
      description,
      outcome: ['happy', 'excited', 'grateful'].includes(emotion) ? 'positive' : 'neutral',
      emotion,
      emotionIntensity: intensity,
      tags: ['emotional', emotion],
      importance: Math.min(100, intensity + 20),
    });
  }

  /**
   * Get episodes for a user
   */
  async getEpisodes(userId: string, options: EpisodeSearchOptions = {}): Promise<Episode[]> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return [];

    const {
      type,
      emotion,
      minImportance = 0,
      tags,
      dateFrom,
      dateTo,
      limit = 50,
    } = options;

    try {
      let sql = `
        SELECT * FROM ai_episodes
        WHERE user_id = ? AND importance >= ?
      `;
      const params: any[] = [userId, minImportance];

      if (type) {
        sql += ` AND type = ?`;
        params.push(type);
      }

      if (emotion) {
        sql += ` AND emotion = ?`;
        params.push(emotion);
      }

      if (dateFrom) {
        sql += ` AND timestamp >= ?`;
        params.push(dateFrom.toISOString());
      }

      if (dateTo) {
        sql += ` AND timestamp <= ?`;
        params.push(dateTo.toISOString());
      }

      sql += ` ORDER BY importance DESC, timestamp DESC LIMIT ?`;
      params.push(limit);

      const rows = db.prepare(sql).all(...params) as any[];

      let episodes = rows.map(row => this.rowToEpisode(row));

      // Filter by tags if specified
      if (tags && tags.length > 0) {
        episodes = episodes.filter(ep =>
          tags.some(tag => ep.tags.includes(tag))
        );
      }

      return episodes;
    } catch (error) {
      logger.error('[EpisodicMemory] Failed to get episodes:', error);
      return [];
    }
  }

  /**
   * Get recent episodes
   */
  async getRecent(userId: string, limit: number = 10): Promise<Episode[]> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return [];

    try {
      const rows = db.prepare(`
        SELECT * FROM ai_episodes
        WHERE user_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(userId, limit) as any[];

      return rows.map(row => this.rowToEpisode(row));
    } catch (error) {
      logger.error('[EpisodicMemory] Failed to get recent:', error);
      return [];
    }
  }

  /**
   * Get most important episodes
   */
  async getMostImportant(userId: string, limit: number = 10): Promise<Episode[]> {
    return this.getEpisodes(userId, { minImportance: 70, limit });
  }

  /**
   * Get lessons learned
   */
  async getLessonsLearned(userId: string): Promise<string[]> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return [];

    try {
      const rows = db.prepare(`
        SELECT lessons_learned FROM ai_episodes
        WHERE user_id = ? AND lessons_learned IS NOT NULL
        ORDER BY importance DESC
        LIMIT 50
      `).all(userId) as any[];

      const lessons: string[] = [];
      for (const row of rows) {
        const parsed = JSON.parse(row.lessons_learned);
        if (Array.isArray(parsed)) {
          lessons.push(...parsed);
        }
      }

      return [...new Set(lessons)]; // Unique lessons
    } catch (error) {
      logger.error('[EpisodicMemory] Failed to get lessons:', error);
      return [];
    }
  }

  /**
   * Get mistakes to avoid
   */
  async getMistakesToAvoid(userId: string): Promise<Episode[]> {
    return this.getEpisodes(userId, { type: 'mistake', limit: 20 });
  }

  /**
   * Generate episodic context for AI prompt
   */
  async generateEpisodicPrompt(userId: string): Promise<string> {
    const important = await this.getMostImportant(userId, 5);
    const recent = await this.getRecent(userId, 3);
    const lessons = await this.getLessonsLearned(userId);
    const mistakes = await this.getMistakesToAvoid(userId);

    let prompt = '';

    // First meeting check
    const firstMeeting = await this.getEpisodes(userId, { type: 'first_meeting', limit: 1 });
    if (firstMeeting.length > 0) {
      const daysSinceFirst = Math.floor(
        (Date.now() - firstMeeting[0].timestamp.getTime()) / (1000 * 60 * 60 * 24)
      );
      prompt += `\n## Relationship History\n`;
      prompt += `- First met ${daysSinceFirst} days ago\n`;
    }

    if (important.length > 0) {
      prompt += `\n## Important Past Events\n`;
      for (const ep of important) {
        prompt += `- ${ep.title} (${ep.outcome})\n`;
      }
    }

    if (lessons.length > 0) {
      prompt += `\n## Lessons Learned\n`;
      for (const lesson of lessons.slice(0, 5)) {
        prompt += `- ${lesson}\n`;
      }
    }

    if (mistakes.length > 0) {
      prompt += `\n## Mistakes to Avoid\n`;
      for (const mistake of mistakes.slice(0, 3)) {
        prompt += `- ${mistake.title}\n`;
      }
    }

    return prompt;
  }

  /**
   * Search episodes by text
   */
  async search(userId: string, query: string, limit: number = 20): Promise<Episode[]> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return [];

    try {
      const searchPattern = `%${query}%`;
      const rows = db.prepare(`
        SELECT * FROM ai_episodes
        WHERE user_id = ?
          AND (title LIKE ? OR description LIKE ? OR tags LIKE ?)
        ORDER BY importance DESC, timestamp DESC
        LIMIT ?
      `).all(userId, searchPattern, searchPattern, searchPattern, limit) as any[];

      return rows.map(row => this.rowToEpisode(row));
    } catch (error) {
      logger.error('[EpisodicMemory] Search failed:', error);
      return [];
    }
  }

  /**
   * Delete an episode
   */
  async delete(id: number): Promise<boolean> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return false;

    try {
      const result = db.prepare(`DELETE FROM ai_episodes WHERE id = ?`).run(id);
      return result.changes > 0;
    } catch (error) {
      logger.error('[EpisodicMemory] Delete failed:', error);
      return false;
    }
  }

  /**
   * Convert database row to Episode
   */
  private rowToEpisode(row: any): Episode {
    return {
      id: row.id,
      userId: row.user_id,
      type: row.type as EpisodeType,
      title: row.title,
      description: row.description,
      outcome: row.outcome,
      emotion: row.emotion as PrimaryEmotion | undefined,
      emotionIntensity: row.emotion_intensity || undefined,
      participants: row.participants ? JSON.parse(row.participants) : undefined,
      tags: JSON.parse(row.tags),
      importance: row.importance,
      lessonsLearned: row.lessons_learned ? JSON.parse(row.lessons_learned) : undefined,
      timestamp: new Date(row.timestamp),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  /**
   * Get statistics
   */
  async getStats(userId: string): Promise<{
    totalEpisodes: number;
    byType: Record<EpisodeType, number>;
    avgImportance: number;
    lessonsCount: number;
  }> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return { totalEpisodes: 0, byType: {} as any, avgImportance: 0, lessonsCount: 0 };

    try {
      const total = db.prepare(
        `SELECT COUNT(*) as count, AVG(importance) as avg FROM ai_episodes WHERE user_id = ?`
      ).get(userId) as any;

      const types = db.prepare(`
        SELECT type, COUNT(*) as count FROM ai_episodes WHERE user_id = ? GROUP BY type
      `).all(userId) as any[];

      const byType: Record<string, number> = {};
      for (const row of types) {
        byType[row.type] = row.count;
      }

      const lessons = await this.getLessonsLearned(userId);

      return {
        totalEpisodes: total?.count || 0,
        byType: byType as Record<EpisodeType, number>,
        avgImportance: total?.avg || 0,
        lessonsCount: lessons.length,
      };
    } catch (error) {
      logger.error('[EpisodicMemory] Failed to get stats:', error);
      return { totalEpisodes: 0, byType: {} as any, avgImportance: 0, lessonsCount: 0 };
    }
  }
}

// Singleton instance
let episodicInstance: EpisodicMemoryManager | null = null;

export function getEpisodicMemory(): EpisodicMemoryManager {
  if (!episodicInstance) {
    episodicInstance = new EpisodicMemoryManager();
  }
  return episodicInstance;
}
