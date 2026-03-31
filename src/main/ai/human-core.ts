/**
 * Human AI Core - Integration layer for all human-like AI components
 * Brings together Soul, Emotions, Memory, Knowledge, and Goals
 * to create a cohesive, human-like AI experience
 */

import logger from '../logger';

// Import all components
import { getSoulManager, SoulManager, ZiraSoul } from './personality/soul';
import { getEmotionsManager, EmotionsManager, EmotionalState, PrimaryEmotion } from './personality/emotions';
import { getShortTermMemory, ShortTermMemory, ConversationContext } from './memory/short-term';
import { getLongTermMemory, LongTermMemoryManager } from './memory/long-term';
import { getEpisodicMemory, EpisodicMemoryManager } from './memory/episodic';
import { getUserProfileManager, UserProfileManager, UserProfile } from './knowledge/user-profile';
import { getGoalTracker, GoalTracker, ProactiveSuggestion } from './goals/goal-tracker';

// Human AI state snapshot
export interface HumanAIState {
  // Soul
  soulVersion: string;
  personalityDescription: string;

  // Emotions
  currentEmotion: EmotionalState;
  emotionInfluence: {
    toneAdjustment: string;
    temperatureModifier: number;
  };

  // User context
  userProfile?: UserProfile;
  relationshipLevel: number;
  conversationContext?: ConversationContext;

  // Goals & suggestions
  activeGoals: number;
  proactiveSuggestions: ProactiveSuggestion[];
}

// Response enhancement from human components
export interface ResponseEnhancement {
  prefix?: string;           // Emotion-based prefix
  suffix?: string;           // Emotion-based suffix
  emoji?: string;            // Suggested emoji
  temperatureModifier: number;
  toneGuidance: string;
  shouldMentionGoals: boolean;
  contextNotes: string[];
}

/**
 * Human AI Core - The integration layer
 * This is the main interface for making Zira "human-like"
 */
export class HumanAICore {
  private soul: SoulManager;
  private emotions: EmotionsManager;
  private shortTermMemory: ShortTermMemory;
  private longTermMemory: LongTermMemoryManager;
  private episodicMemory: EpisodicMemoryManager;
  private userProfiles: UserProfileManager;
  private goalTracker: GoalTracker;
  private initialized = false;

  constructor() {
    this.soul = getSoulManager();
    this.emotions = getEmotionsManager();
    this.shortTermMemory = getShortTermMemory();
    this.longTermMemory = getLongTermMemory();
    this.episodicMemory = getEpisodicMemory();
    this.userProfiles = getUserProfileManager();
    this.goalTracker = getGoalTracker();

    logger.info('[HumanAICore] Created');
  }

  /**
   * Initialize all components
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('[HumanAICore] Initializing all components...');

    // Initialize database-backed components
    await Promise.all([
      this.longTermMemory.initialize(),
      this.episodicMemory.initialize(),
      this.userProfiles.initialize(),
      this.goalTracker.initialize(),
    ]);

    this.initialized = true;
    logger.info('[HumanAICore] All components initialized');
  }

  /**
   * Process incoming message - analyze and update state
   */
  async processIncomingMessage(userId: string, message: string): Promise<void> {
    await this.initialize();

    // 1. Update short-term memory
    this.shortTermMemory.addMessage(userId, 'user', message);

    // 2. Start/update conversation context
    this.shortTermMemory.startContext(userId);

    // 3. Analyze emotions from message
    this.emotions.analyzeAndUpdateEmotion(message);

    // 4. Update user profile activity
    await this.userProfiles.getProfile(userId); // Ensures profile exists

    // 5. Extract potential facts/preferences from message
    await this.extractKnowledge(userId, message);

    // 6. Detect potential goals
    const goalDetection = this.goalTracker.detectGoalFromMessage(message);
    if (goalDetection.detected && goalDetection.title) {
      this.shortTermMemory.addObservation(
        userId,
        `User might have a goal: ${goalDetection.title}`,
        70
      );
    }

    logger.debug(`[HumanAICore] Processed message from ${userId}`);
  }

  /**
   * Process outgoing response - enhance and record
   */
  async processOutgoingResponse(
    userId: string,
    response: string,
    wasHelpful?: boolean
  ): Promise<string> {
    await this.initialize();

    // 1. Add to short-term memory
    this.shortTermMemory.addMessage(userId, 'assistant', response);

    // 2. Record interaction
    await this.userProfiles.recordInteraction(userId, {
      wasHelpful,
      sentiment: wasHelpful ? 'positive' : 'neutral',
    });

    // 3. Get response enhancement
    const enhancement = await this.getResponseEnhancement(userId);

    // 4. Apply emotional prefix/suffix (subtle, not always)
    let enhancedResponse = response;
    if (enhancement.prefix && Math.random() < 0.3) {
      enhancedResponse = enhancement.prefix + enhancedResponse;
    }
    if (enhancement.suffix && Math.random() < 0.2) {
      enhancedResponse = enhancedResponse + enhancement.suffix;
    }

    return enhancedResponse;
  }

  /**
   * Extract knowledge from message
   */
  private async extractKnowledge(userId: string, message: string): Promise<void> {
    const lowerMsg = message.toLowerCase();

    // Name patterns
    const nameMatch = message.match(/(?:tên tôi là|my name is|i'm|i am|call me)\s+([A-Za-zÀ-ỹ]+)/i);
    if (nameMatch) {
      await this.userProfiles.learnFact(userId, 'name', nameMatch[1]);
    }

    // Language detection
    const vietnameseChars = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/;
    if (vietnameseChars.test(message)) {
      await this.longTermMemory.store(userId, 'preference', 'language', 'vietnamese', {
        confidence: 90,
      });
    }

    // Interest patterns
    const interestPatterns = [
      { pattern: /(?:i love|i like|thích|yêu thích|quan tâm)\s+(.+?)(?:\.|,|$)/i, type: 'interest' },
      { pattern: /(?:i hate|i don't like|ghét|không thích)\s+(.+?)(?:\.|,|$)/i, type: 'dislike' },
    ];

    for (const { pattern, type } of interestPatterns) {
      const match = message.match(pattern);
      if (match) {
        const topic = match[1].trim().substring(0, 50);
        if (type === 'interest') {
          await this.userProfiles.addInterest(userId, topic);
        }
        await this.longTermMemory.store(userId, 'preference', type, topic);
      }
    }

    // Work/profession patterns
    const workMatch = message.match(/(?:i work as|tôi làm|nghề của tôi là|i'm a)\s+([^,.]+)/i);
    if (workMatch) {
      await this.userProfiles.learnFact(userId, 'profession', workMatch[1].trim());
    }
  }

  /**
   * Get response enhancement based on current state
   */
  async getResponseEnhancement(userId: string): Promise<ResponseEnhancement> {
    const emotionState = this.emotions.getCurrentState();
    const influence = this.emotions.getInfluence();
    const goals = await this.goalTracker.getActiveGoals(userId);
    const context = this.shortTermMemory.getContext(userId);

    const contextNotes: string[] = [];

    // Add context notes
    if (context?.pendingTasks.length) {
      contextNotes.push(`User has pending tasks: ${context.pendingTasks.join(', ')}`);
    }

    if (goals.length > 0) {
      contextNotes.push(`User has ${goals.length} active goals`);
    }

    return {
      prefix: this.emotions.getResponsePrefix(),
      suffix: this.emotions.getResponseSuffix(),
      emoji: this.emotions.getSuggestedEmoji() || undefined,
      temperatureModifier: this.emotions.getTemperatureModifier(),
      toneGuidance: influence.toneAdjustment,
      shouldMentionGoals: goals.length > 0 && Math.random() < 0.1, // 10% chance
      contextNotes,
    };
  }

  /**
   * Generate comprehensive system prompt with all human components
   */
  async generateHumanSystemPrompt(userId: string): Promise<string> {
    await this.initialize();

    const parts: string[] = [];

    // 1. Soul/Personality
    const personalityPrompt = this.soul.generatePersonalityPrompt();
    parts.push(personalityPrompt);

    // 2. Current Emotion
    const emotionPrompt = this.emotions.generateEmotionPrompt();
    if (emotionPrompt) {
      parts.push(emotionPrompt);
    }

    // 3. User Profile
    const profilePrompt = await this.userProfiles.generateProfilePrompt(userId);
    if (profilePrompt) {
      parts.push(profilePrompt);
    }

    // 4. Long-term Memory (facts & preferences)
    const memoryPrompt = await this.longTermMemory.generateMemoryPrompt(userId);
    if (memoryPrompt) {
      parts.push(memoryPrompt);
    }

    // 5. Episodic Memory (past experiences)
    const episodicPrompt = await this.episodicMemory.generateEpisodicPrompt(userId);
    if (episodicPrompt) {
      parts.push(episodicPrompt);
    }

    // 6. Short-term Context
    const contextSummary = this.shortTermMemory.generateContextSummary(userId);
    if (contextSummary) {
      parts.push(`\n## Current Conversation Context\n${contextSummary}`);
    }

    // 7. Goals
    const goalsPrompt = await this.goalTracker.generateGoalsPrompt(userId);
    if (goalsPrompt) {
      parts.push(goalsPrompt);
    }

    return parts.filter(p => p.trim()).join('\n\n---\n\n');
  }

  /**
   * Get current state snapshot
   */
  async getState(userId: string): Promise<HumanAIState> {
    await this.initialize();

    const profile = await this.userProfiles.getProfile(userId);
    const goals = await this.goalTracker.getActiveGoals(userId);
    const suggestions = await this.goalTracker.getProactiveSuggestions(userId);
    const context = this.shortTermMemory.getContext(userId) || undefined;
    const emotion = this.emotions.getCurrentState();
    const influence = this.emotions.getInfluence();

    return {
      soulVersion: this.soul.getSoul().version,
      personalityDescription: this.soul.generatePersonalityPrompt().substring(0, 200),
      currentEmotion: emotion,
      emotionInfluence: {
        toneAdjustment: influence.toneAdjustment,
        temperatureModifier: influence.temperatureModifier,
      },
      userProfile: profile,
      relationshipLevel: profile.relationshipLevel,
      conversationContext: context,
      activeGoals: goals.length,
      proactiveSuggestions: suggestions.slice(0, 3),
    };
  }

  /**
   * Learn from feedback
   */
  async learnFromFeedback(
    userId: string,
    isPositive: boolean,
    feedback?: string
  ): Promise<void> {
    await this.initialize();

    // Store feedback
    if (feedback) {
      await this.longTermMemory.storeFeedback(userId, feedback, isPositive);
    }

    // Adjust emotion
    if (isPositive) {
      this.emotions.setEmotion('grateful', 80, 5);
    } else {
      this.emotions.setEmotion('apologetic', 70, 5);
    }

    // Record episode
    await this.episodicMemory.recordConversation(
      userId,
      isPositive ? 'Positive feedback received' : 'Negative feedback received',
      feedback || 'No specific feedback',
      isPositive,
      isPositive ? 'grateful' : 'apologetic'
    );

    // Update user profile
    await this.userProfiles.recordInteraction(userId, {
      sentiment: isPositive ? 'positive' : 'negative',
      wasHelpful: isPositive,
    });
  }

  /**
   * Learn from a mistake
   */
  async learnFromMistake(
    userId: string,
    mistake: string,
    correction: string
  ): Promise<void> {
    await this.initialize();

    // Store correction in long-term memory
    await this.longTermMemory.storeCorrection(userId, mistake, correction);

    // Record as episode
    await this.episodicMemory.recordMistake(
      userId,
      mistake,
      correction,
      `Don't make this mistake again: ${mistake}`
    );

    // Set apologetic emotion
    this.emotions.setEmotion('apologetic', 80, 3);
  }

  /**
   * Record when Zira helps solve a problem
   */
  async recordHelpfulMoment(
    userId: string,
    problem: string,
    solution: string
  ): Promise<void> {
    await this.initialize();

    // Record episode
    await this.episodicMemory.recordProblemSolved(userId, problem, solution, 'medium');

    // Set happy emotion
    this.emotions.setEmotion('happy', 75, 5);

    // Update profile
    await this.userProfiles.recordInteraction(userId, {
      wasHelpful: true,
      sentiment: 'positive',
      topic: problem.substring(0, 50),
    });
  }

  /**
   * Create a goal for user
   */
  async createGoal(
    userId: string,
    title: string,
    options?: {
      description?: string;
      steps?: string[];
      dueDate?: Date;
    }
  ) {
    await this.initialize();
    return this.goalTracker.createGoal(userId, title, options);
  }

  /**
   * Get proactive suggestions for user
   */
  async getProactiveSuggestions(userId: string): Promise<ProactiveSuggestion[]> {
    await this.initialize();
    return this.goalTracker.getProactiveSuggestions(userId);
  }

  /**
   * Set emotion manually
   */
  setEmotion(emotion: PrimaryEmotion, intensity: number = 70): void {
    this.emotions.setEmotion(emotion, intensity);
  }

  /**
   * Get current emotion
   */
  getCurrentEmotion(): EmotionalState {
    return this.emotions.getCurrentState();
  }

  /**
   * Get soul configuration
   */
  getSoul(): ZiraSoul {
    return this.soul.getSoul();
  }

  /**
   * Clear all data for a user (GDPR-style)
   */
  async clearUserData(userId: string): Promise<void> {
    await this.initialize();

    this.shortTermMemory.clear(userId);
    await this.longTermMemory.clearUser(userId);
    // Note: episodic and goals would need clearUser methods too

    logger.info(`[HumanAICore] Cleared all data for ${userId}`);
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<{
    shortTermMemory: { totalUsers: number; totalItems: number };
    longTermMemory: { totalMemories: number; uniqueUsers: number };
    emotions: { current: PrimaryEmotion; intensity: number };
  }> {
    await this.initialize();

    const stmStats = this.shortTermMemory.getStats();
    const ltmStats = await this.longTermMemory.getStats();
    const emotion = this.emotions.getCurrentState();

    return {
      shortTermMemory: stmStats,
      longTermMemory: ltmStats,
      emotions: {
        current: emotion.primary,
        intensity: emotion.intensity,
      },
    };
  }
}

// Singleton instance
let humanCoreInstance: HumanAICore | null = null;

export function getHumanAICore(): HumanAICore {
  if (!humanCoreInstance) {
    humanCoreInstance = new HumanAICore();
  }
  return humanCoreInstance;
}

// Initialize on import
export async function initializeHumanAI(): Promise<HumanAICore> {
  const core = getHumanAICore();
  await core.initialize();
  return core;
}
