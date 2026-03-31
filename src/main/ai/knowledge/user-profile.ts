/**
 * User Profile & Knowledge - Comprehensive user understanding
 * Tracks facts, preferences, behaviors, and relationship strength
 */

import { getDatabase } from '../ai-database';
import logger from '../../logger';
import { getLongTermMemory } from '../memory/long-term';
import { getEpisodicMemory } from '../memory/episodic';

// User profile data
export interface UserProfile {
  userId: string;
  name?: string;
  preferredName?: string;     // How they like to be called
  language: string;           // Preferred language
  timezone?: string;
  firstSeen: Date;
  lastSeen: Date;
  totalInteractions: number;
  relationshipLevel: number;  // 0-100
  trust: number;              // 0-100
  satisfaction: number;       // 0-100 (based on feedback)
  communicationStyle: 'formal' | 'casual' | 'mixed';
  traits: string[];           // Observed traits
  interests: string[];        // Topics they're interested in
  expertise: string[];        // Things they're good at
  challenges: string[];       // Things they struggle with
}

// Interaction pattern
export interface InteractionPattern {
  preferredTime?: string;     // When they usually interact
  avgSessionLength: number;   // Minutes
  frequentTopics: string[];   // What they often ask about
  frequentTools: string[];    // Tools they use most
  sentimentTrend: 'positive' | 'neutral' | 'negative';
}

// Relationship milestone
export interface RelationshipMilestone {
  level: number;
  name: string;
  description: string;
  unlockedAt?: Date;
}

// Relationship levels
const RELATIONSHIP_MILESTONES: RelationshipMilestone[] = [
  { level: 0, name: 'Stranger', description: 'Just met' },
  { level: 10, name: 'Acquaintance', description: 'Getting to know each other' },
  { level: 25, name: 'Familiar', description: 'Regular interactions' },
  { level: 50, name: 'Friend', description: 'Trusted helper' },
  { level: 75, name: 'Close Friend', description: 'Deep understanding' },
  { level: 90, name: 'Best Friend', description: 'Like family' },
  { level: 100, name: 'Soulmate', description: 'Perfect understanding' },
];

/**
 * User Profile Manager
 * Manages comprehensive user understanding
 */
export class UserProfileManager {
  private initialized = false;
  private profiles: Map<string, UserProfile> = new Map();

  constructor() {
    logger.info('[UserProfile] Manager created');
  }

  /**
   * Initialize database tables
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const db = getDatabase();
    if (!db) {
      logger.warn('[UserProfile] Database not available');
      return;
    }

    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_user_profiles (
          user_id TEXT PRIMARY KEY,
          name TEXT,
          preferred_name TEXT,
          language TEXT DEFAULT 'en',
          timezone TEXT,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          total_interactions INTEGER DEFAULT 0,
          relationship_level INTEGER DEFAULT 0,
          trust INTEGER DEFAULT 50,
          satisfaction INTEGER DEFAULT 70,
          communication_style TEXT DEFAULT 'mixed',
          traits TEXT,
          interests TEXT,
          expertise TEXT,
          challenges TEXT,
          metadata TEXT
        );

        CREATE TABLE IF NOT EXISTS ai_interaction_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          duration_seconds INTEGER,
          topic TEXT,
          tools_used TEXT,
          sentiment TEXT,
          was_helpful INTEGER,
          FOREIGN KEY (user_id) REFERENCES ai_user_profiles(user_id)
        );

        CREATE INDEX IF NOT EXISTS idx_interactions_user ON ai_interaction_logs(user_id);
        CREATE INDEX IF NOT EXISTS idx_interactions_time ON ai_interaction_logs(timestamp);
      `);

      this.initialized = true;
      logger.info('[UserProfile] Database initialized');
    } catch (error) {
      logger.error('[UserProfile] Failed to initialize:', error);
    }
  }

  /**
   * Get or create user profile
   */
  async getProfile(userId: string): Promise<UserProfile> {
    await this.initialize();

    // Check cache first
    if (this.profiles.has(userId)) {
      return this.profiles.get(userId)!;
    }

    const db = getDatabase();
    if (!db) {
      return this.createDefaultProfile(userId);
    }

    try {
      const row = db.prepare(`SELECT * FROM ai_user_profiles WHERE user_id = ?`).get(userId) as any;

      if (row) {
        const profile = this.rowToProfile(row);
        this.profiles.set(userId, profile);
        return profile;
      }

      // Create new profile
      const profile = await this.createProfile(userId);
      return profile;
    } catch (error) {
      logger.error('[UserProfile] Failed to get profile:', error);
      return this.createDefaultProfile(userId);
    }
  }

  /**
   * Create a new user profile
   */
  private async createProfile(userId: string): Promise<UserProfile> {
    const db = getDatabase();
    const now = new Date().toISOString();

    const profile: UserProfile = {
      userId,
      language: 'vi', // Default to Vietnamese
      firstSeen: new Date(),
      lastSeen: new Date(),
      totalInteractions: 0,
      relationshipLevel: 0,
      trust: 50,
      satisfaction: 70,
      communicationStyle: 'mixed',
      traits: [],
      interests: [],
      expertise: [],
      challenges: [],
    };

    if (db) {
      try {
        db.prepare(`
          INSERT INTO ai_user_profiles
            (user_id, language, first_seen, last_seen, total_interactions,
             relationship_level, trust, satisfaction, communication_style,
             traits, interests, expertise, challenges)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          userId,
          profile.language,
          now,
          now,
          0,
          0,
          50,
          70,
          'mixed',
          '[]',
          '[]',
          '[]',
          '[]'
        );

        // Record first meeting
        const episodic = getEpisodicMemory();
        await episodic.recordFirstMeeting(userId);
      } catch (error) {
        logger.error('[UserProfile] Failed to create profile:', error);
      }
    }

    this.profiles.set(userId, profile);
    return profile;
  }

  /**
   * Create default profile (when DB not available)
   */
  private createDefaultProfile(userId: string): UserProfile {
    return {
      userId,
      language: 'vi',
      firstSeen: new Date(),
      lastSeen: new Date(),
      totalInteractions: 0,
      relationshipLevel: 0,
      trust: 50,
      satisfaction: 70,
      communicationStyle: 'mixed',
      traits: [],
      interests: [],
      expertise: [],
      challenges: [],
    };
  }

  /**
   * Update user profile
   */
  async updateProfile(userId: string, updates: Partial<UserProfile>): Promise<void> {
    await this.initialize();

    const profile = await this.getProfile(userId);
    const updated = { ...profile, ...updates, lastSeen: new Date() };
    this.profiles.set(userId, updated);

    const db = getDatabase();
    if (!db) return;

    try {
      db.prepare(`
        UPDATE ai_user_profiles SET
          name = ?,
          preferred_name = ?,
          language = ?,
          timezone = ?,
          last_seen = ?,
          total_interactions = ?,
          relationship_level = ?,
          trust = ?,
          satisfaction = ?,
          communication_style = ?,
          traits = ?,
          interests = ?,
          expertise = ?,
          challenges = ?
        WHERE user_id = ?
      `).run(
        updated.name || null,
        updated.preferredName || null,
        updated.language,
        updated.timezone || null,
        new Date().toISOString(),
        updated.totalInteractions,
        updated.relationshipLevel,
        updated.trust,
        updated.satisfaction,
        updated.communicationStyle,
        JSON.stringify(updated.traits),
        JSON.stringify(updated.interests),
        JSON.stringify(updated.expertise),
        JSON.stringify(updated.challenges),
        userId
      );
    } catch (error) {
      logger.error('[UserProfile] Failed to update:', error);
    }
  }

  /**
   * Record an interaction
   */
  async recordInteraction(
    userId: string,
    options: {
      durationSeconds?: number;
      topic?: string;
      toolsUsed?: string[];
      sentiment?: 'positive' | 'neutral' | 'negative';
      wasHelpful?: boolean;
    } = {}
  ): Promise<void> {
    await this.initialize();

    // Update profile
    const profile = await this.getProfile(userId);
    profile.totalInteractions++;
    profile.lastSeen = new Date();

    // Increase relationship level based on interaction
    const relationshipGain = options.wasHelpful ? 2 : 1;
    profile.relationshipLevel = Math.min(100, profile.relationshipLevel + relationshipGain);

    // Adjust trust based on sentiment
    if (options.sentiment === 'positive') {
      profile.trust = Math.min(100, profile.trust + 1);
    } else if (options.sentiment === 'negative') {
      profile.trust = Math.max(0, profile.trust - 2);
    }

    // Adjust satisfaction based on helpfulness
    if (options.wasHelpful !== undefined) {
      if (options.wasHelpful) {
        profile.satisfaction = Math.min(100, profile.satisfaction + 2);
      } else {
        profile.satisfaction = Math.max(0, profile.satisfaction - 5);
      }
    }

    await this.updateProfile(userId, profile);

    // Log interaction
    const db = getDatabase();
    if (db) {
      try {
        db.prepare(`
          INSERT INTO ai_interaction_logs
            (user_id, timestamp, duration_seconds, topic, tools_used, sentiment, was_helpful)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          userId,
          new Date().toISOString(),
          options.durationSeconds || null,
          options.topic || null,
          options.toolsUsed ? JSON.stringify(options.toolsUsed) : null,
          options.sentiment || null,
          options.wasHelpful !== undefined ? (options.wasHelpful ? 1 : 0) : null
        );
      } catch (error) {
        logger.error('[UserProfile] Failed to log interaction:', error);
      }
    }

    // Check for milestone
    await this.checkMilestones(userId, profile.relationshipLevel);
  }

  /**
   * Check and record relationship milestones
   */
  private async checkMilestones(userId: string, level: number): Promise<void> {
    const ltm = getLongTermMemory();
    const episodic = getEpisodicMemory();

    for (const milestone of RELATIONSHIP_MILESTONES) {
      if (level >= milestone.level) {
        const key = `milestone_${milestone.level}`;
        const existing = await ltm.get(userId, 'relationship', key);

        if (!existing) {
          // New milestone reached!
          await ltm.store(userId, 'relationship', key, milestone.name, {
            source: 'milestone',
            confidence: 100,
          });

          await episodic.recordMilestone(
            userId,
            `Reached ${milestone.name} level`,
            milestone.description
          );

          logger.info(`[UserProfile] ${userId} reached milestone: ${milestone.name}`);
        }
      }
    }
  }

  /**
   * Learn a fact about the user
   */
  async learnFact(userId: string, key: string, value: string, confidence: number = 80): Promise<void> {
    const ltm = getLongTermMemory();
    await ltm.storeFact(userId, key, value, confidence);

    // Update profile based on fact type
    const profile = await this.getProfile(userId);

    if (key === 'name' || key === 'user_name') {
      await this.updateProfile(userId, { name: value });
    } else if (key === 'preferred_name' || key === 'nickname') {
      await this.updateProfile(userId, { preferredName: value });
    } else if (key === 'language' || key === 'preferred_language') {
      await this.updateProfile(userId, { language: value });
    } else if (key === 'timezone') {
      await this.updateProfile(userId, { timezone: value });
    }

    logger.info(`[UserProfile] Learned fact for ${userId}: ${key} = ${value}`);
  }

  /**
   * Learn a preference
   */
  async learnPreference(userId: string, key: string, value: string): Promise<void> {
    const ltm = getLongTermMemory();
    await ltm.storePreference(userId, key, value);
  }

  /**
   * Add an interest
   */
  async addInterest(userId: string, interest: string): Promise<void> {
    const profile = await this.getProfile(userId);
    if (!profile.interests.includes(interest)) {
      profile.interests.push(interest);
      await this.updateProfile(userId, { interests: profile.interests });
    }
  }

  /**
   * Add a trait observation
   */
  async addTrait(userId: string, trait: string): Promise<void> {
    const profile = await this.getProfile(userId);
    if (!profile.traits.includes(trait)) {
      profile.traits.push(trait);
      await this.updateProfile(userId, { traits: profile.traits });
    }
  }

  /**
   * Get interaction patterns
   */
  async getInteractionPatterns(userId: string): Promise<InteractionPattern | null> {
    await this.initialize();

    const db = getDatabase();
    if (!db) return null;

    try {
      // Get recent interactions
      const rows = db.prepare(`
        SELECT * FROM ai_interaction_logs
        WHERE user_id = ?
        ORDER BY timestamp DESC
        LIMIT 100
      `).all(userId) as any[];

      if (rows.length === 0) return null;

      // Calculate average session length
      const durations = rows.filter(r => r.duration_seconds).map(r => r.duration_seconds);
      const avgSessionLength = durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 60)
        : 0;

      // Count topics
      const topicCounts: Record<string, number> = {};
      rows.forEach(r => {
        if (r.topic) {
          topicCounts[r.topic] = (topicCounts[r.topic] || 0) + 1;
        }
      });
      const frequentTopics = Object.entries(topicCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([topic]) => topic);

      // Count tools
      const toolCounts: Record<string, number> = {};
      rows.forEach(r => {
        if (r.tools_used) {
          const tools = JSON.parse(r.tools_used);
          tools.forEach((tool: string) => {
            toolCounts[tool] = (toolCounts[tool] || 0) + 1;
          });
        }
      });
      const frequentTools = Object.entries(toolCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([tool]) => tool);

      // Sentiment trend
      const sentiments = rows.filter(r => r.sentiment).map(r => r.sentiment);
      const positives = sentiments.filter(s => s === 'positive').length;
      const negatives = sentiments.filter(s => s === 'negative').length;
      let sentimentTrend: 'positive' | 'neutral' | 'negative' = 'neutral';
      if (positives > negatives * 2) sentimentTrend = 'positive';
      else if (negatives > positives * 2) sentimentTrend = 'negative';

      return {
        avgSessionLength,
        frequentTopics,
        frequentTools,
        sentimentTrend,
      };
    } catch (error) {
      logger.error('[UserProfile] Failed to get patterns:', error);
      return null;
    }
  }

  /**
   * Get current relationship milestone
   */
  getCurrentMilestone(relationshipLevel: number): RelationshipMilestone {
    for (let i = RELATIONSHIP_MILESTONES.length - 1; i >= 0; i--) {
      if (relationshipLevel >= RELATIONSHIP_MILESTONES[i].level) {
        return RELATIONSHIP_MILESTONES[i];
      }
    }
    return RELATIONSHIP_MILESTONES[0];
  }

  /**
   * Generate profile context for AI prompt
   */
  async generateProfilePrompt(userId: string): Promise<string> {
    const profile = await this.getProfile(userId);
    const patterns = await this.getInteractionPatterns(userId);
    const milestone = this.getCurrentMilestone(profile.relationshipLevel);

    let prompt = `\n## User Profile\n`;

    if (profile.preferredName || profile.name) {
      prompt += `Name: ${profile.preferredName || profile.name}\n`;
    }

    prompt += `Language: ${profile.language}\n`;
    prompt += `Relationship: ${milestone.name} (${profile.relationshipLevel}%)\n`;
    prompt += `Trust: ${profile.trust}%\n`;
    prompt += `Interactions: ${profile.totalInteractions}\n`;

    if (profile.traits.length > 0) {
      prompt += `Traits: ${profile.traits.slice(0, 5).join(', ')}\n`;
    }

    if (profile.interests.length > 0) {
      prompt += `Interests: ${profile.interests.slice(0, 5).join(', ')}\n`;
    }

    if (patterns) {
      if (patterns.frequentTopics.length > 0) {
        prompt += `Often asks about: ${patterns.frequentTopics.join(', ')}\n`;
      }
      prompt += `Sentiment: ${patterns.sentimentTrend}\n`;
    }

    // Communication style guidance
    prompt += `\nCommunication style: ${profile.communicationStyle}\n`;
    if (profile.communicationStyle === 'formal') {
      prompt += `- Use polite, professional language\n`;
    } else if (profile.communicationStyle === 'casual') {
      prompt += `- Use friendly, relaxed language\n`;
    }

    return prompt;
  }

  /**
   * Convert database row to profile
   */
  private rowToProfile(row: any): UserProfile {
    return {
      userId: row.user_id,
      name: row.name || undefined,
      preferredName: row.preferred_name || undefined,
      language: row.language,
      timezone: row.timezone || undefined,
      firstSeen: new Date(row.first_seen),
      lastSeen: new Date(row.last_seen),
      totalInteractions: row.total_interactions,
      relationshipLevel: row.relationship_level,
      trust: row.trust,
      satisfaction: row.satisfaction,
      communicationStyle: row.communication_style as any,
      traits: row.traits ? JSON.parse(row.traits) : [],
      interests: row.interests ? JSON.parse(row.interests) : [],
      expertise: row.expertise ? JSON.parse(row.expertise) : [],
      challenges: row.challenges ? JSON.parse(row.challenges) : [],
    };
  }
}

// Singleton instance
let profileInstance: UserProfileManager | null = null;

export function getUserProfileManager(): UserProfileManager {
  if (!profileInstance) {
    profileInstance = new UserProfileManager();
  }
  return profileInstance;
}
