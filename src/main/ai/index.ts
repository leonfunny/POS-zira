/**
 * AI Module - Zira AI chatbot with human-like capabilities
 * Includes: Core AI, Personality, Memory, Knowledge, and Goals
 */

// Core AI
export { ZiraAI, ZIRA_TOOLS, executeTool, getBrowserSessionStatus } from './zira-ai';
export type { ZiraAIOptions, ChatMessage, ChatResponse } from './zira-ai';

// System Prompt
export { buildSystemPrompt, buildMessagePrompt, getDefaultSystemPrompt } from './system-prompt';

// Human AI Core - Main integration layer
export { HumanAICore, getHumanAICore, initializeHumanAI } from './human-core';
export type { HumanAIState, ResponseEnhancement } from './human-core';

// Personality Module
export { SoulManager, getSoulManager, initializeSoul } from './personality/soul';
export type { ZiraSoul, CoreValues, CommunicationStyle, Beliefs } from './personality/soul';
export { EmotionsManager, getEmotionsManager } from './personality/emotions';
export type { EmotionalState, PrimaryEmotion, EmotionInfluence } from './personality/emotions';

// Memory Module
export { ShortTermMemory, getShortTermMemory } from './memory/short-term';
export type { MemoryItem, ConversationContext } from './memory/short-term';
export { LongTermMemoryManager, getLongTermMemory } from './memory/long-term';
export type { LongTermMemory, MemoryCategory } from './memory/long-term';
export { EpisodicMemoryManager, getEpisodicMemory } from './memory/episodic';
export type { Episode, EpisodeType } from './memory/episodic';

// Knowledge Module
export { UserProfileManager, getUserProfileManager } from './knowledge/user-profile';
export type { UserProfile, InteractionPattern, RelationshipMilestone } from './knowledge/user-profile';

// Goals Module
export { GoalTracker, getGoalTracker } from './goals/goal-tracker';
export type { Goal, GoalStep, GoalStatus, GoalPriority, ProactiveSuggestion } from './goals/goal-tracker';
