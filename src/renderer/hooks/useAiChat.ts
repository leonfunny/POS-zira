/**
 * useAiChat – wraps electronAPI AI chat operations
 *
 * Provides chat, status, and history management for the Zira AI assistant.
 */

import { useState, useCallback } from 'react';

interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
  toolExecuted?: boolean;
  model?: string;
  timestamp: number;
}

interface AiChatState {
  messages: AiMessage[];
  loading: boolean;
  error: string | null;
}

export function useAiChat(userId?: string) {
  const [state, setState] = useState<AiChatState>({
    messages: [],
    loading: false,
    error: null,
  });

  const sendMessage = useCallback(async (message: string) => {
    // Add user message immediately
    const userMsg: AiMessage = {
      role: 'user',
      content: message,
      timestamp: Date.now(),
    };

    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, userMsg],
      loading: true,
      error: null,
    }));

    try {
      const result = await window.electronAPI.ai.chat(message, userId);

      if (result.success && result.data) {
        const assistantMsg: AiMessage = {
          role: 'assistant',
          content: result.data.content || '',
          toolExecuted: result.data.toolExecuted,
          model: result.data.model,
          timestamp: Date.now(),
        };

        setState((prev) => ({
          ...prev,
          messages: [...prev.messages, assistantMsg],
          loading: false,
        }));

        return result.data;
      } else {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: result.error || 'AI chat failed',
        }));
        return null;
      }
    } catch (e: any) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: e.message,
      }));
      return null;
    }
  }, [userId]);

  const clearHistory = useCallback(async () => {
    await window.electronAPI.ai.clearHistory(userId);
    setState({ messages: [], loading: false, error: null });
  }, [userId]);

  const getStatus = useCallback(async () => {
    return window.electronAPI.ai.getStatus();
  }, []);

  return {
    messages: state.messages,
    loading: state.loading,
    error: state.error,
    sendMessage,
    clearHistory,
    getStatus,
  };
}
