/**
 * Emotions Module - Emotional state machine for Zira AI
 * Tracks and manages emotional responses to make interactions more human-like
 */

import logger from '../../logger';

// Primary emotions Zira can experience
export type PrimaryEmotion =
  | 'happy'       // User success, positive feedback
  | 'excited'     // New interesting task, discovery
  | 'curious'     // Learning something new
  | 'neutral'     // Default state
  | 'thoughtful'  // Complex problem solving
  | 'concerned'   // User seems frustrated or in trouble
  | 'empathetic'  // User sharing personal issues
  | 'apologetic'  // Made a mistake
  | 'grateful'    // User gives positive feedback
  | 'determined'; // Challenging task

// Emotional state with intensity and context
export interface EmotionalState {
  primary: PrimaryEmotion;
  secondary?: PrimaryEmotion;    // Mixed emotions possible
  intensity: number;             // 0-100
  confidence: number;            // How sure about this emotion
  triggers: string[];            // What caused this emotion
  startedAt: Date;
  expiresAt: Date;               // Emotions fade over time
}

// Emotion triggers - what causes each emotion
export interface EmotionTrigger {
  patterns: RegExp[];            // Message patterns
  keywords: string[];            // Keywords to detect
  emotion: PrimaryEmotion;
  intensityRange: [number, number];
  duration: number;              // Minutes before fading
}

// Emotion influence on responses
export interface EmotionInfluence {
  prefixPhrases: string[];       // Phrases to start with
  suffixPhrases: string[];       // Phrases to end with
  emojiSuggestions: string[];    // Suggested emojis
  toneAdjustment: string;        // Description of tone
  temperatureModifier: number;   // AI temperature adjustment
}

// Default emotion triggers
const DEFAULT_TRIGGERS: EmotionTrigger[] = [
  // Happy triggers
  {
    patterns: [/thank|thanks|cảm ơn|tuyệt vời|great|awesome|perfect/i],
    keywords: ['thank', 'thanks', 'great', 'awesome', 'perfect', 'cảm ơn', 'tuyệt'],
    emotion: 'happy',
    intensityRange: [60, 90],
    duration: 10,
  },
  // Excited triggers
  {
    patterns: [/new feature|let's try|thử.*mới|exciting|cool/i],
    keywords: ['new', 'try', 'exciting', 'discover', 'cool', 'mới', 'thử'],
    emotion: 'excited',
    intensityRange: [50, 80],
    duration: 8,
  },
  // Curious triggers
  {
    patterns: [/how does|what is|why|explain|tell me about/i],
    keywords: ['how', 'what', 'why', 'explain', 'curious', 'wonder'],
    emotion: 'curious',
    intensityRange: [40, 70],
    duration: 15,
  },
  // Concerned triggers
  {
    patterns: [/error|bug|broken|not working|failed|lỗi|hỏng|không được/i],
    keywords: ['error', 'bug', 'broken', 'failed', 'problem', 'lỗi', 'hỏng'],
    emotion: 'concerned',
    intensityRange: [50, 85],
    duration: 12,
  },
  // Empathetic triggers
  {
    patterns: [/stressed|frustrated|tired|difficult day|mệt|stress|khó khăn/i],
    keywords: ['stressed', 'frustrated', 'tired', 'hard', 'difficult', 'mệt', 'buồn'],
    emotion: 'empathetic',
    intensityRange: [60, 90],
    duration: 20,
  },
  // Apologetic triggers (user reports Zira made mistake)
  {
    patterns: [/wrong|mistake|incorrect|sai rồi|không đúng|you broke/i],
    keywords: ['wrong', 'mistake', 'incorrect', 'error', 'sai', 'lỗi'],
    emotion: 'apologetic',
    intensityRange: [70, 95],
    duration: 5,
  },
  // Grateful triggers
  {
    patterns: [/love this|you're amazing|best assistant|giỏi quá|hay quá/i],
    keywords: ['love', 'amazing', 'best', 'wonderful', 'giỏi', 'hay'],
    emotion: 'grateful',
    intensityRange: [70, 100],
    duration: 15,
  },
  // Determined triggers
  {
    patterns: [/challenge|difficult|complex|hard problem|thử thách/i],
    keywords: ['challenge', 'difficult', 'complex', 'hard', 'impossible'],
    emotion: 'determined',
    intensityRange: [60, 85],
    duration: 20,
  },
];

// Emotion influences on response style
const EMOTION_INFLUENCES: Record<PrimaryEmotion, EmotionInfluence> = {
  happy: {
    prefixPhrases: ['Great!', 'Wonderful!', 'Tuyệt vời!', 'Glad to help!'],
    suffixPhrases: ['Happy to assist anytime!', 'Let me know if you need more help!'],
    emojiSuggestions: ['😊', '🎉', '✨'],
    toneAdjustment: 'warm and positive',
    temperatureModifier: 0.1,
  },
  excited: {
    prefixPhrases: ['Oh, this is interesting!', 'I love this!', 'Let me show you!'],
    suffixPhrases: ['This is going to be great!', 'Can\'t wait to see the result!'],
    emojiSuggestions: ['🚀', '⚡', '🔥'],
    toneAdjustment: 'energetic and enthusiastic',
    temperatureModifier: 0.15,
  },
  curious: {
    prefixPhrases: ['Interesting question!', 'Let me explore this...', 'Hmm, let me think...'],
    suffixPhrases: ['Would you like to know more?', 'This is fascinating!'],
    emojiSuggestions: ['🤔', '💡', '🔍'],
    toneAdjustment: 'inquisitive and engaged',
    temperatureModifier: 0.05,
  },
  neutral: {
    prefixPhrases: [],
    suffixPhrases: [],
    emojiSuggestions: [],
    toneAdjustment: 'balanced and professional',
    temperatureModifier: 0,
  },
  thoughtful: {
    prefixPhrases: ['Let me analyze this carefully...', 'Thinking about this...'],
    suffixPhrases: ['I hope this helps!', 'Let me know if this makes sense.'],
    emojiSuggestions: ['🧠', '📊', '💭'],
    toneAdjustment: 'careful and analytical',
    temperatureModifier: -0.1,
  },
  concerned: {
    prefixPhrases: ['I understand this is frustrating.', 'Let me help fix this.', 'Tôi hiểu bạn đang gặp khó khăn.'],
    suffixPhrases: ['We\'ll get this sorted out.', 'Don\'t worry, I\'m here to help.'],
    emojiSuggestions: ['🔧', '💪', '🤝'],
    toneAdjustment: 'supportive and solution-focused',
    temperatureModifier: -0.05,
  },
  empathetic: {
    prefixPhrases: ['I understand how you feel.', 'That sounds really tough.', 'Tôi hiểu cảm giác của bạn.'],
    suffixPhrases: ['Take your time.', 'I\'m here whenever you need.'],
    emojiSuggestions: ['💙', '🤗', '💐'],
    toneAdjustment: 'gentle and understanding',
    temperatureModifier: 0.05,
  },
  apologetic: {
    prefixPhrases: ['I\'m sorry about that!', 'My apologies!', 'Xin lỗi bạn!', 'I made a mistake.'],
    suffixPhrases: ['Let me fix this right away.', 'I\'ll be more careful.'],
    emojiSuggestions: ['🙏', '😅'],
    toneAdjustment: 'humble and corrective',
    temperatureModifier: -0.1,
  },
  grateful: {
    prefixPhrases: ['Thank you so much!', 'That means a lot!', 'Cảm ơn bạn nhiều!'],
    suffixPhrases: ['Your feedback helps me improve!', 'I appreciate your kind words!'],
    emojiSuggestions: ['🙏', '❤️', '🌟'],
    toneAdjustment: 'warm and appreciative',
    temperatureModifier: 0.1,
  },
  determined: {
    prefixPhrases: ['Challenge accepted!', 'Let\'s tackle this!', 'I\'ll figure this out!'],
    suffixPhrases: ['We\'ve got this!', 'Nothing is impossible!'],
    emojiSuggestions: ['💪', '🎯', '⚔️'],
    toneAdjustment: 'confident and persistent',
    temperatureModifier: 0.05,
  },
};

/**
 * Emotions Manager - Tracks and manages Zira's emotional state
 */
export class EmotionsManager {
  private currentState: EmotionalState;
  private emotionHistory: EmotionalState[] = [];
  private triggers: EmotionTrigger[] = DEFAULT_TRIGGERS;
  private maxHistorySize = 50;

  constructor() {
    this.currentState = this.createNeutralState();
    logger.info('[Emotions] Initialized emotions manager');
  }

  /**
   * Create a neutral emotional state
   */
  private createNeutralState(): EmotionalState {
    const now = new Date();
    return {
      primary: 'neutral',
      intensity: 30,
      confidence: 100,
      triggers: [],
      startedAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000), // 1 hour
    };
  }

  /**
   * Get current emotional state
   */
  getCurrentState(): EmotionalState {
    // Check if current emotion has expired
    if (new Date() > this.currentState.expiresAt) {
      this.fadeToNeutral();
    }
    return { ...this.currentState };
  }

  /**
   * Analyze message and update emotional state
   */
  analyzeAndUpdateEmotion(message: string): EmotionalState {
    const detectedEmotions: Array<{
      emotion: PrimaryEmotion;
      intensity: number;
      trigger: string;
    }> = [];

    // Check each trigger
    for (const trigger of this.triggers) {
      // Check patterns
      for (const pattern of trigger.patterns) {
        if (pattern.test(message)) {
          const intensity = Math.floor(
            trigger.intensityRange[0] +
            Math.random() * (trigger.intensityRange[1] - trigger.intensityRange[0])
          );
          detectedEmotions.push({
            emotion: trigger.emotion,
            intensity,
            trigger: `pattern: ${pattern.source}`,
          });
          break;
        }
      }

      // Check keywords
      const lowerMessage = message.toLowerCase();
      for (const keyword of trigger.keywords) {
        if (lowerMessage.includes(keyword.toLowerCase())) {
          const intensity = Math.floor(
            trigger.intensityRange[0] +
            Math.random() * (trigger.intensityRange[1] - trigger.intensityRange[0])
          );
          detectedEmotions.push({
            emotion: trigger.emotion,
            intensity,
            trigger: `keyword: ${keyword}`,
          });
          break;
        }
      }
    }

    // If emotions detected, update state
    if (detectedEmotions.length > 0) {
      // Find strongest emotion
      const strongest = detectedEmotions.reduce((a, b) =>
        a.intensity > b.intensity ? a : b
      );

      // Find secondary emotion if different
      const secondary = detectedEmotions.find(
        e => e.emotion !== strongest.emotion && e.intensity > 40
      );

      const now = new Date();
      const trigger = this.triggers.find(t => t.emotion === strongest.emotion);
      const duration = trigger?.duration || 10;

      const newState: EmotionalState = {
        primary: strongest.emotion,
        secondary: secondary?.emotion,
        intensity: strongest.intensity,
        confidence: Math.min(100, detectedEmotions.length * 30),
        triggers: detectedEmotions.map(e => e.trigger),
        startedAt: now,
        expiresAt: new Date(now.getTime() + duration * 60 * 1000),
      };

      // Save to history
      this.emotionHistory.push(this.currentState);
      if (this.emotionHistory.length > this.maxHistorySize) {
        this.emotionHistory.shift();
      }

      this.currentState = newState;
      logger.info(`[Emotions] State changed to ${strongest.emotion} (${strongest.intensity}%)`);
    }

    return this.getCurrentState();
  }

  /**
   * Gradually return to neutral state
   */
  private fadeToNeutral(): void {
    if (this.currentState.primary !== 'neutral') {
      this.emotionHistory.push(this.currentState);
      this.currentState = this.createNeutralState();
      logger.info('[Emotions] Faded to neutral state');
    }
  }

  /**
   * Manually set emotion (for specific scenarios)
   */
  setEmotion(emotion: PrimaryEmotion, intensity: number = 70, durationMinutes: number = 10): void {
    const now = new Date();
    this.emotionHistory.push(this.currentState);

    this.currentState = {
      primary: emotion,
      intensity: Math.min(100, Math.max(0, intensity)),
      confidence: 100,
      triggers: ['manual_set'],
      startedAt: now,
      expiresAt: new Date(now.getTime() + durationMinutes * 60 * 1000),
    };

    logger.info(`[Emotions] Manually set to ${emotion} (${intensity}%)`);
  }

  /**
   * Get influence for current emotion
   */
  getInfluence(): EmotionInfluence {
    return EMOTION_INFLUENCES[this.currentState.primary];
  }

  /**
   * Get response prefix based on current emotion
   */
  getResponsePrefix(): string {
    const influence = this.getInfluence();
    if (influence.prefixPhrases.length === 0) return '';

    // Higher intensity = more likely to use prefix
    if (Math.random() * 100 < this.currentState.intensity) {
      const idx = Math.floor(Math.random() * influence.prefixPhrases.length);
      return influence.prefixPhrases[idx] + ' ';
    }
    return '';
  }

  /**
   * Get response suffix based on current emotion
   */
  getResponseSuffix(): string {
    const influence = this.getInfluence();
    if (influence.suffixPhrases.length === 0) return '';

    // Lower threshold for suffix
    if (Math.random() * 100 < this.currentState.intensity * 0.7) {
      const idx = Math.floor(Math.random() * influence.suffixPhrases.length);
      return ' ' + influence.suffixPhrases[idx];
    }
    return '';
  }

  /**
   * Get suggested emoji for current emotion
   */
  getSuggestedEmoji(): string | null {
    const influence = this.getInfluence();
    if (influence.emojiSuggestions.length === 0) return null;

    if (Math.random() * 100 < this.currentState.intensity * 0.5) {
      const idx = Math.floor(Math.random() * influence.emojiSuggestions.length);
      return influence.emojiSuggestions[idx];
    }
    return null;
  }

  /**
   * Get temperature modifier for AI
   */
  getTemperatureModifier(): number {
    const influence = this.getInfluence();
    return influence.temperatureModifier * (this.currentState.intensity / 100);
  }

  /**
   * Generate emotion context for system prompt
   */
  generateEmotionPrompt(): string {
    const state = this.getCurrentState();
    const influence = this.getInfluence();

    if (state.primary === 'neutral' && state.intensity < 40) {
      return '';
    }

    let prompt = `\n## Current Emotional State\n`;
    prompt += `Zira is currently feeling **${state.primary}**`;
    if (state.secondary) {
      prompt += ` with hints of **${state.secondary}**`;
    }
    prompt += ` (intensity: ${state.intensity}%).\n`;
    prompt += `Tone adjustment: ${influence.toneAdjustment}\n`;

    if (state.triggers.length > 0) {
      prompt += `Triggered by: ${state.triggers.slice(0, 2).join(', ')}\n`;
    }

    return prompt;
  }

  /**
   * Get emotion history for analysis
   */
  getHistory(): EmotionalState[] {
    return [...this.emotionHistory];
  }

  /**
   * Get dominant emotion over recent history
   */
  getDominantRecentEmotion(): PrimaryEmotion {
    const recentStates = this.emotionHistory.slice(-10);
    if (recentStates.length === 0) return 'neutral';

    const counts: Record<string, number> = {};
    recentStates.forEach(state => {
      counts[state.primary] = (counts[state.primary] || 0) + state.intensity;
    });

    let dominant: PrimaryEmotion = 'neutral';
    let maxScore = 0;
    for (const [emotion, score] of Object.entries(counts)) {
      if (score > maxScore) {
        maxScore = score;
        dominant = emotion as PrimaryEmotion;
      }
    }

    return dominant;
  }

  /**
   * Add custom trigger
   */
  addTrigger(trigger: EmotionTrigger): void {
    this.triggers.push(trigger);
    logger.info(`[Emotions] Added new trigger for ${trigger.emotion}`);
  }

  /**
   * Reset to neutral
   */
  reset(): void {
    this.currentState = this.createNeutralState();
    logger.info('[Emotions] Reset to neutral');
  }
}

// Singleton instance
let emotionsInstance: EmotionsManager | null = null;

export function getEmotionsManager(): EmotionsManager {
  if (!emotionsInstance) {
    emotionsInstance = new EmotionsManager();
  }
  return emotionsInstance;
}
