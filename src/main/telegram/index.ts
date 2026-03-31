/**
 * Telegram Module Index (moltbot-style)
 * Exports all Telegram-related functionality
 */

// Bot management
export {
  createTelegramBot,
  getTelegramBot,
  getBotUsername,
  setBotUsername,
  destroyTelegramBot,
  isBotRunning,
  getBotInfo,
  Bot,
  TelegramBot,
} from './bot';

// Polling
export {
  startPolling,
  stopPolling,
  isPollingRunning,
  restartPolling,
} from './polling';

// Commands
export { registerCommands, TelegramCommands, TelegramCommandsOptions, PrinterFunctions } from './commands';
export { registerNativeCommands } from './native-commands';

// Access Control
export {
  checkDMAccess,
  checkGroupAccess,
  isBotMentioned,
  approvePairing,
  rejectPairing,
  getPendingPairings,
  addToAllowlist,
  removeFromAllowlist,
  configureGroup,
  checkUnauthorizedRateLimit,
} from './access-control';

// History
export {
  getHistory,
  addToHistory,
  addUserMessage,
  addBotMessage,
  addSystemEvent,
  clearHistory,
  clearAllHistory,
  buildHistoryContext,
  getHistoryStats,
  exportHistory,
  getHistoryKey,
} from './history';

// Message Handler
export {
  buildMessageContext,
  checkAccess,
  handleMediaGroup,
  handleTextFragment,
  debounceMessage,
  sequentialize,
  sendTyping,
  sendReply,
  recordAndGetContext,
  recordBotResponse,
} from './message-handler';

// Media Handler
export {
  getMediaType,
  getFileId,
  checkFileSizeLimit,
  downloadMedia,
  getStickerDescription,
  cleanupOldMedia,
  getMediaDescription,
} from './media-handler';
