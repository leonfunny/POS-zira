/**
 * Goal Tracker - Tracks user goals and enables proactive assistance
 * Helps Zira understand what users are trying to achieve
 */

import { getDatabase } from '../ai-database';
import logger from '../../logger';

// Goal status
export type GoalStatus = 'active' | 'completed' | 'abandoned' | 'paused';

// Goal priority
export type GoalPriority = 'low' | 'medium' | 'high' | 'critical';

// A user goal
export interface Goal {
  id: number;
  userId: string;
  title: string;
  description: string;
  status: GoalStatus;
  priority: GoalPriority;
  category: string;           // e.g., 'work', 'learning', 'personal'
  progress: number;           // 0-100
  steps: GoalStep[];
  dueDate?: Date;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  notes: string[];
  blockers: string[];         // What's preventing progress
  metadata?: Record<string, any>;
}

// A step within a goal
export interface GoalStep {
  id: string;
  description: string;
  completed: boolean;
  completedAt?: Date;
  order: number;
}

// Suggestion for proactive help
export interface ProactiveSuggestion {
  type: 'reminder' | 'help' | 'encouragement' | 'tip';
  goalId?: number;
  message: string;
  action?: string;           // Suggested action
  priority: number;          // Higher = more important
}

/**
 * Goal Tracker Manager
 * Tracks goals and provides proactive assistance
 */
export class GoalTracker {
  private initialized = false;

  constructor() {
    logger.info('[GoalTracker] Manager created');
  }

  /**
   * Initialize database tables
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const db = getDatabase();
    if (!db) {
      logger.warn('[GoalTracker] Database not available');
      return;
    }

    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_goals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT DEFAULT 'active',
          priority TEXT DEFAULT 'medium',
          category TEXT DEFAULT 'general',
          progress INTEGER DEFAULT 0,
          steps TEXT,
          due_date TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          notes TEXT,
          blockers TEXT,
          metadata TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_goals_user ON ai_goals(user_id);
        CREATE INDEX IF NOT EXISTS idx_goals_status ON ai_goals(status);
        CREATE INDEX IF NOT EXISTS idx_goals_priority ON ai_goals(priority);
      `);

      this.initialized = true;
      logger.info('[GoalTracker] Database initialized');
    } catch (error) {
      logger.error('[GoalTracker] Failed to initialize:', error);
    }
  }

  /**
   * Create a new goal
   */
  async createGoal(
    userId: string,
    title: string,
    options: {
      description?: string;
      priority?: GoalPriority;
      category?: string;
      steps?: string[];
      dueDate?: Date;
    } = {}
  ): Promise<Goal | null> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return null;

    const now = new Date().toISOString();
    const steps: GoalStep[] = (options.steps || []).map((desc, idx) => ({
      id: `step_${Date.now()}_${idx}`,
      description: desc,
      completed: false,
      order: idx,
    }));

    try {
      const stmt = db.prepare(`
        INSERT INTO ai_goals
          (user_id, title, description, status, priority, category, progress,
           steps, due_date, created_at, updated_at, notes, blockers)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        userId,
        title,
        options.description || '',
        'active',
        options.priority || 'medium',
        options.category || 'general',
        0,
        JSON.stringify(steps),
        options.dueDate?.toISOString() || null,
        now,
        now,
        '[]',
        '[]'
      );

      logger.info(`[GoalTracker] Created goal: ${title} for ${userId}`);

      return {
        id: result.lastInsertRowid as number,
        userId,
        title,
        description: options.description || '',
        status: 'active',
        priority: options.priority || 'medium',
        category: options.category || 'general',
        progress: 0,
        steps,
        dueDate: options.dueDate,
        createdAt: new Date(),
        updatedAt: new Date(),
        notes: [],
        blockers: [],
      };
    } catch (error) {
      logger.error('[GoalTracker] Failed to create goal:', error);
      return null;
    }
  }

  /**
   * Get a goal by ID
   */
  async getGoal(goalId: number): Promise<Goal | null> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return null;

    try {
      const row = db.prepare(`SELECT * FROM ai_goals WHERE id = ?`).get(goalId) as any;
      return row ? this.rowToGoal(row) : null;
    } catch (error) {
      logger.error('[GoalTracker] Failed to get goal:', error);
      return null;
    }
  }

  /**
   * Get active goals for a user
   */
  async getActiveGoals(userId: string): Promise<Goal[]> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return [];

    try {
      const rows = db.prepare(`
        SELECT * FROM ai_goals
        WHERE user_id = ? AND status = 'active'
        ORDER BY
          CASE priority
            WHEN 'critical' THEN 0
            WHEN 'high' THEN 1
            WHEN 'medium' THEN 2
            ELSE 3
          END,
          due_date ASC NULLS LAST
      `).all(userId) as any[];

      return rows.map(row => this.rowToGoal(row));
    } catch (error) {
      logger.error('[GoalTracker] Failed to get active goals:', error);
      return [];
    }
  }

  /**
   * Get all goals for a user
   */
  async getAllGoals(userId: string, includeCompleted: boolean = false): Promise<Goal[]> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return [];

    try {
      let sql = `SELECT * FROM ai_goals WHERE user_id = ?`;
      if (!includeCompleted) {
        sql += ` AND status != 'completed'`;
      }
      sql += ` ORDER BY created_at DESC`;

      const rows = db.prepare(sql).all(userId) as any[];
      return rows.map(row => this.rowToGoal(row));
    } catch (error) {
      logger.error('[GoalTracker] Failed to get goals:', error);
      return [];
    }
  }

  /**
   * Update goal progress
   */
  async updateProgress(goalId: number, progress: number): Promise<void> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return;

    const clampedProgress = Math.min(100, Math.max(0, progress));

    try {
      db.prepare(`
        UPDATE ai_goals
        SET progress = ?, updated_at = ?,
            status = CASE WHEN ? >= 100 THEN 'completed' ELSE status END,
            completed_at = CASE WHEN ? >= 100 THEN ? ELSE completed_at END
        WHERE id = ?
      `).run(
        clampedProgress,
        new Date().toISOString(),
        clampedProgress,
        clampedProgress,
        new Date().toISOString(),
        goalId
      );

      if (clampedProgress >= 100) {
        logger.info(`[GoalTracker] Goal ${goalId} completed!`);
      }
    } catch (error) {
      logger.error('[GoalTracker] Failed to update progress:', error);
    }
  }

  /**
   * Complete a step
   */
  async completeStep(goalId: number, stepId: string): Promise<void> {
    await this.initialize();

    const goal = await this.getGoal(goalId);
    if (!goal) return;

    const step = goal.steps.find(s => s.id === stepId);
    if (step && !step.completed) {
      step.completed = true;
      step.completedAt = new Date();

      // Calculate new progress
      const completedSteps = goal.steps.filter(s => s.completed).length;
      const totalSteps = goal.steps.length;
      const newProgress = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

      const db = getDatabase();
      if (db) {
        try {
          db.prepare(`
            UPDATE ai_goals
            SET steps = ?, progress = ?, updated_at = ?,
                status = CASE WHEN ? >= 100 THEN 'completed' ELSE status END,
                completed_at = CASE WHEN ? >= 100 THEN ? ELSE completed_at END
            WHERE id = ?
          `).run(
            JSON.stringify(goal.steps),
            newProgress,
            new Date().toISOString(),
            newProgress,
            newProgress,
            new Date().toISOString(),
            goalId
          );
        } catch (error) {
          logger.error('[GoalTracker] Failed to complete step:', error);
        }
      }
    }
  }

  /**
   * Add a note to a goal
   */
  async addNote(goalId: number, note: string): Promise<void> {
    await this.initialize();

    const goal = await this.getGoal(goalId);
    if (!goal) return;

    goal.notes.push(`[${new Date().toISOString()}] ${note}`);

    const db = getDatabase();
    if (db) {
      try {
        db.prepare(`
          UPDATE ai_goals SET notes = ?, updated_at = ? WHERE id = ?
        `).run(JSON.stringify(goal.notes), new Date().toISOString(), goalId);
      } catch (error) {
        logger.error('[GoalTracker] Failed to add note:', error);
      }
    }
  }

  /**
   * Add a blocker
   */
  async addBlocker(goalId: number, blocker: string): Promise<void> {
    await this.initialize();

    const goal = await this.getGoal(goalId);
    if (!goal) return;

    if (!goal.blockers.includes(blocker)) {
      goal.blockers.push(blocker);

      const db = getDatabase();
      if (db) {
        try {
          db.prepare(`
            UPDATE ai_goals SET blockers = ?, updated_at = ? WHERE id = ?
          `).run(JSON.stringify(goal.blockers), new Date().toISOString(), goalId);
        } catch (error) {
          logger.error('[GoalTracker] Failed to add blocker:', error);
        }
      }
    }
  }

  /**
   * Remove a blocker
   */
  async removeBlocker(goalId: number, blocker: string): Promise<void> {
    await this.initialize();

    const goal = await this.getGoal(goalId);
    if (!goal) return;

    goal.blockers = goal.blockers.filter(b => b !== blocker);

    const db = getDatabase();
    if (db) {
      try {
        db.prepare(`
          UPDATE ai_goals SET blockers = ?, updated_at = ? WHERE id = ?
        `).run(JSON.stringify(goal.blockers), new Date().toISOString(), goalId);
      } catch (error) {
        logger.error('[GoalTracker] Failed to remove blocker:', error);
      }
    }
  }

  /**
   * Change goal status
   */
  async setStatus(goalId: number, status: GoalStatus): Promise<void> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return;

    try {
      db.prepare(`
        UPDATE ai_goals
        SET status = ?, updated_at = ?,
            completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END
        WHERE id = ?
      `).run(
        status,
        new Date().toISOString(),
        status,
        new Date().toISOString(),
        goalId
      );
    } catch (error) {
      logger.error('[GoalTracker] Failed to set status:', error);
    }
  }

  /**
   * Generate proactive suggestions
   */
  async getProactiveSuggestions(userId: string): Promise<ProactiveSuggestion[]> {
    const suggestions: ProactiveSuggestion[] = [];
    const goals = await this.getActiveGoals(userId);
    const now = new Date();

    for (const goal of goals) {
      // Overdue goals
      if (goal.dueDate && goal.dueDate < now) {
        suggestions.push({
          type: 'reminder',
          goalId: goal.id,
          message: `Goal "${goal.title}" is overdue! Would you like to update it?`,
          action: 'Update goal',
          priority: 90,
        });
      }

      // Due soon (within 24 hours)
      if (goal.dueDate) {
        const hoursUntilDue = (goal.dueDate.getTime() - now.getTime()) / (1000 * 60 * 60);
        if (hoursUntilDue > 0 && hoursUntilDue <= 24) {
          suggestions.push({
            type: 'reminder',
            goalId: goal.id,
            message: `Goal "${goal.title}" is due in ${Math.round(hoursUntilDue)} hours!`,
            action: 'Work on goal',
            priority: 80,
          });
        }
      }

      // Stalled goals (no progress in 3 days)
      const daysSinceUpdate = (now.getTime() - goal.updatedAt.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceUpdate > 3 && goal.progress < 100) {
        suggestions.push({
          type: 'help',
          goalId: goal.id,
          message: `You haven't made progress on "${goal.title}" in ${Math.round(daysSinceUpdate)} days. Need help?`,
          action: 'Get assistance',
          priority: 60,
        });
      }

      // Goals with blockers
      if (goal.blockers.length > 0) {
        suggestions.push({
          type: 'help',
          goalId: goal.id,
          message: `"${goal.title}" has blockers: ${goal.blockers[0]}. Can I help resolve this?`,
          action: 'Resolve blocker',
          priority: 70,
        });
      }

      // Encouragement for progress
      if (goal.progress > 50 && goal.progress < 100) {
        suggestions.push({
          type: 'encouragement',
          goalId: goal.id,
          message: `You're ${goal.progress}% done with "${goal.title}"! Keep going!`,
          priority: 30,
        });
      }

      // Critical priority reminder
      if (goal.priority === 'critical') {
        suggestions.push({
          type: 'reminder',
          goalId: goal.id,
          message: `Don't forget your critical goal: "${goal.title}"`,
          priority: 85,
        });
      }
    }

    // Sort by priority
    suggestions.sort((a, b) => b.priority - a.priority);

    return suggestions;
  }

  /**
   * Generate goals context for AI prompt
   */
  async generateGoalsPrompt(userId: string): Promise<string> {
    const goals = await this.getActiveGoals(userId);
    const suggestions = await this.getProactiveSuggestions(userId);

    if (goals.length === 0) {
      return '';
    }

    let prompt = `\n## User's Active Goals\n`;

    for (const goal of goals.slice(0, 5)) {
      prompt += `\n### ${goal.title} (${goal.priority} priority)\n`;
      prompt += `Progress: ${goal.progress}%\n`;

      if (goal.dueDate) {
        const daysLeft = Math.ceil((goal.dueDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        prompt += `Due: ${daysLeft > 0 ? `in ${daysLeft} days` : 'OVERDUE'}\n`;
      }

      if (goal.steps.length > 0) {
        const nextStep = goal.steps.find(s => !s.completed);
        if (nextStep) {
          prompt += `Next step: ${nextStep.description}\n`;
        }
      }

      if (goal.blockers.length > 0) {
        prompt += `Blockers: ${goal.blockers.join(', ')}\n`;
      }
    }

    if (suggestions.length > 0) {
      const topSuggestion = suggestions[0];
      prompt += `\n## Proactive Suggestion\n`;
      prompt += `${topSuggestion.message}\n`;
    }

    return prompt;
  }

  /**
   * Detect goal from conversation
   * Returns potential goal if user mentions wanting to achieve something
   */
  detectGoalFromMessage(message: string): { detected: boolean; title?: string; category?: string } {
    const goalPatterns = [
      /i want to (.+)/i,
      /i need to (.+)/i,
      /tôi muốn (.+)/i,
      /tôi cần (.+)/i,
      /help me (.+)/i,
      /giúp tôi (.+)/i,
      /my goal is to (.+)/i,
      /i'm trying to (.+)/i,
    ];

    for (const pattern of goalPatterns) {
      const match = message.match(pattern);
      if (match) {
        return {
          detected: true,
          title: match[1].trim(),
          category: 'general',
        };
      }
    }

    return { detected: false };
  }

  /**
   * Delete a goal
   */
  async deleteGoal(goalId: number): Promise<boolean> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return false;

    try {
      const result = db.prepare(`DELETE FROM ai_goals WHERE id = ?`).run(goalId);
      return result.changes > 0;
    } catch (error) {
      logger.error('[GoalTracker] Failed to delete goal:', error);
      return false;
    }
  }

  /**
   * Convert database row to Goal
   */
  private rowToGoal(row: any): Goal {
    return {
      id: row.id,
      userId: row.user_id,
      title: row.title,
      description: row.description || '',
      status: row.status as GoalStatus,
      priority: row.priority as GoalPriority,
      category: row.category,
      progress: row.progress,
      steps: row.steps ? JSON.parse(row.steps) : [],
      dueDate: row.due_date ? new Date(row.due_date) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      notes: row.notes ? JSON.parse(row.notes) : [],
      blockers: row.blockers ? JSON.parse(row.blockers) : [],
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }
}

// Singleton instance
let goalTrackerInstance: GoalTracker | null = null;

export function getGoalTracker(): GoalTracker {
  if (!goalTrackerInstance) {
    goalTrackerInstance = new GoalTracker();
  }
  return goalTrackerInstance;
}
