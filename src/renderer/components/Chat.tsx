import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ZiraAIStatus } from '../../shared/types';
import { getTranslation, Language } from '../i18n/translations';
import { useDeleteConfirm } from './DeleteConfirmModal';
import rlog from '../utils/logger';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  tokens?: number;
  attachments?: { type: 'image' | 'video'; name: string; data: string }[];
  timestamp?: Date;
  error?: boolean;
}

interface ChatProps {
  language: Language;
}

export default function Chat({ language }: ChatProps) {
  const t = getTranslation(language);
  const { confirmDelete, DeleteModal } = useDeleteConfirm();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [aiStatus, setAiStatus] = useState<ZiraAIStatus | null>(null);
  const [attachments, setAttachments] = useState<{ type: 'image' | 'video'; name: string; data: string }[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [lastUserMessage, setLastUserMessage] = useState<string>('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    window.electronAPI.ai.getStatus().then(setAiStatus).catch(console.error);
  }, []);

  // Focus input helper - ensures focus after React re-render
  const focusInput = useCallback(() => {
    // Use requestAnimationFrame to wait for React to finish rendering
    requestAnimationFrame(() => {
      if (inputRef.current && !inputRef.current.disabled) {
        inputRef.current.focus();
      }
    });
  }, []);

  // Auto-focus input on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      focusInput();
    }, 100);
    return () => clearTimeout(timer);
  }, [focusInput]);

  // Focus when loading finishes (AI responds)
  useEffect(() => {
    if (!loading) {
      focusInput();
    }
  }, [loading, focusInput]);

  // Focus input when window/tab becomes visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !loading) {
        focusInput();
      }
    };
    const handleFocus = () => {
      if (!loading) {
        focusInput();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [loading, focusInput]);

  // Keep focus on input - refocus if clicked outside but still in chat area
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Don't steal focus from buttons or other interactive elements
      if (target.tagName === 'BUTTON' || target.tagName === 'A' || target.closest('button')) {
        return;
      }
      // If clicking in the chat area, focus input
      if (!loading) {
        setTimeout(() => focusInput(), 10);
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [loading, focusInput]);

  // Keyboard shortcut: Ctrl+/ or Cmd+/ to focus input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        inputRef.current?.focus();
      }
      // Escape to blur
      if (e.key === 'Escape') {
        inputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Auto-resize textarea
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 200) + 'px';
    }
  }, [input]);

  const handleFileProcess = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files);
    fileArray.forEach(file => {
      if (file.type.startsWith('image/') || file.type.startsWith('video/')) {
        const reader = new FileReader();
        reader.onload = (e) => {
          const data = e.target?.result as string;
          setAttachments(prev => [...prev, {
            type: file.type.startsWith('image/') ? 'image' : 'video',
            name: file.name,
            data,
          }]);
        };
        reader.readAsDataURL(file);
      }
    });
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files?.length) {
      handleFileProcess(e.dataTransfer.files);
    }
  }, [handleFileProcess]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      handleFileProcess(files);
    }
  }, [handleFileProcess]);

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  // Copy message to clipboard
  const handleCopy = useCallback(async (content: string, index: number) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
    } catch (err) {
      rlog.error('Failed to copy:', err);
    }
  }, []);

  // Regenerate last AI response
  const handleRegenerate = useCallback(async () => {
    if (!lastUserMessage || loading) return;

    // Remove the last assistant message
    setMessages(prev => {
      const newMessages = [...prev];
      if (newMessages.length > 0 && newMessages[newMessages.length - 1].role === 'assistant') {
        newMessages.pop();
      }
      return newMessages;
    });

    setLoading(true);
    try {
      const result = await window.electronAPI.ai.chat(lastUserMessage);
      if (result.success && result.data) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: result.data!.content,
          tokens: result.data!.usage?.totalTokens,
          timestamp: new Date(),
        }]);
      } else {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: result.error || t('chat.error'),
          timestamp: new Date(),
          error: true,
        }]);
      }
    } catch (err: any) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: err.message || t('chat.error'),
        timestamp: new Date(),
        error: true,
      }]);
    } finally {
      setLoading(false);
      // Focus is handled by useEffect watching loading state
    }
  }, [lastUserMessage, loading, t]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if ((!trimmed && attachments.length === 0) || loading) return;

    // Store for regenerate
    if (trimmed) setLastUserMessage(trimmed);

    const userMsg: ChatMessage = {
      role: 'user',
      content: trimmed,
      attachments: attachments.length > 0 ? [...attachments] : undefined,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setAttachments([]);
    setLoading(true);

    try {
      // Pass attachments to AI if any
      const result = await window.electronAPI.ai.chat(
        trimmed,
        undefined, // userId
        userMsg.attachments // Pass attachments
      );
      if (result.success && result.data) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: result.data!.content,
          tokens: result.data!.usage?.totalTokens,
          timestamp: new Date(),
        }]);
      } else {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: result.error || t('chat.error'),
          timestamp: new Date(),
          error: true,
        }]);
      }
    } catch (err: any) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: err.message || t('chat.error'),
        timestamp: new Date(),
        error: true,
      }]);
    } finally {
      setLoading(false);
      // Focus is handled by useEffect watching loading state
    }
  };

  const handleClear = () => {
    if (messages.length === 0) return;
    confirmDelete({
      title: t('deleteConfirm.title'),
      message: t('chat.clearConfirm'),
      onConfirm: async () => {
        try {
          await window.electronAPI.ai.clearHistory();
          setMessages([]);
        } catch (err) {
          rlog.error('Failed to clear history:', err);
        }
      },
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Format AI response text with basic markdown-like rendering
  const formatContent = (text: string) => {
    const parts: React.ReactNode[] = [];
    const lines = text.split('\n');
    let inCodeBlock = false;
    let codeLines: string[] = [];
    let codeKey = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('```')) {
        if (inCodeBlock) {
          parts.push(
            <pre key={`code-${codeKey++}`} className="bg-slate-800 text-slate-100 rounded-lg p-4 my-3 text-sm overflow-x-auto font-mono">
              {codeLines.join('\n')}
            </pre>
          );
          codeLines = [];
          inCodeBlock = false;
        } else {
          inCodeBlock = true;
        }
        continue;
      }

      if (inCodeBlock) {
        codeLines.push(line);
        continue;
      }

      // Inline formatting
      let formatted: React.ReactNode = line;
      if (typeof formatted === 'string' && formatted.length > 0) {
        // Bold
        const boldParts = formatted.split(/\*\*(.*?)\*\*/g);
        if (boldParts.length > 1) {
          formatted = boldParts.map((part, idx) =>
            idx % 2 === 1 ? <strong key={idx}>{part}</strong> : part
          );
        }

        // Inline code
        if (typeof formatted === 'string') {
          const codeParts = formatted.split(/`([^`]+)`/g);
          if (codeParts.length > 1) {
            formatted = codeParts.map((part, idx) =>
              idx % 2 === 1 ? <code key={idx} className="bg-slate-100 px-1.5 py-0.5 rounded text-sm font-mono text-brand-700">{part}</code> : part
            );
          }
        }
      }

      parts.push(
        <React.Fragment key={`line-${i}`}>
          {i > 0 && !inCodeBlock && <br />}
          {formatted}
        </React.Fragment>
      );
    }

    // Close unclosed code block
    if (inCodeBlock && codeLines.length > 0) {
      parts.push(
        <pre key={`code-${codeKey}`} className="bg-slate-800 text-slate-100 rounded-lg p-4 my-3 text-sm overflow-x-auto font-mono">
          {codeLines.join('\n')}
        </pre>
      );
    }

    return parts;
  };

  // Not configured state
  if (aiStatus && (!aiStatus.enabled || !aiStatus.hasApiKey)) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-180px)] gap-4 px-6 text-center">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center shadow-lg">
          <span className="text-3xl font-bold text-white">Z</span>
        </div>
        <h2 className="text-xl font-semibold text-slate-800">{t('chat.notConfigured')}</h2>
        <p className="text-base text-slate-500 max-w-sm">{t('chat.configureHint')}</p>
      </div>
    );
  }

  return (
    <div
      className="relative flex flex-col h-[calc(100vh-140px)] w-full"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 bg-brand-500/10 border-2 border-dashed border-brand-500 rounded-2xl z-50 flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <div className="w-16 h-16 mx-auto mb-3 rounded-2xl bg-brand-100 flex items-center justify-center">
              <svg className="w-8 h-8 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <p className="text-lg font-medium text-brand-700">{t('chat.dropFiles')}</p>
          </div>
        </div>
      )}

      {/* Messages area - centered like Claude */}
      <div className="flex-1 overflow-y-auto px-4 py-6 max-w-4xl mx-auto w-full">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
            <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center shadow-lg">
              <span className="text-4xl font-bold text-white">Z</span>
            </div>
            <div>
              <h2 className="text-2xl font-semibold text-slate-800 mb-2">Zira AI</h2>
              <p className="text-base text-slate-500">{t('chat.empty')}</p>
            </div>
            {aiStatus?.model && (
              <span className="px-3 py-1 rounded-full bg-slate-100 text-sm text-slate-500">{aiStatus.model}</span>
            )}
          </div>
        ) : (
          <div className="space-y-6 max-w-3xl mx-auto w-full">
            {messages.map((msg, i) => (
              <div key={i} className={`group flex gap-4 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.role === 'assistant' && (
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center flex-shrink-0 shadow">
                    <span className="text-sm font-bold text-white">Z</span>
                  </div>
                )}
                <div className={`max-w-[85%] ${msg.role === 'user' ? 'order-first' : ''}`}>
                  {/* Attachments */}
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2">
                      {msg.attachments.map((att, idx) => (
                        <div key={idx} className="relative">
                          {att.type === 'image' ? (
                            <img src={att.data} alt={att.name} className="max-w-[200px] max-h-[150px] rounded-lg object-cover" />
                          ) : (
                            <video src={att.data} className="max-w-[200px] max-h-[150px] rounded-lg" controls />
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <div
                    className={`rounded-2xl px-4 py-3 ${
                      msg.role === 'user'
                        ? 'bg-brand-600 text-white text-base'
                        : msg.error
                        ? 'bg-red-50 border border-red-200 text-red-800 text-base'
                        : 'bg-white border border-slate-200 text-slate-800 text-base shadow-sm'
                    }`}
                  >
                    {msg.role === 'assistant' ? formatContent(msg.content) : msg.content}
                  </div>
                  {/* Message footer with timestamp and actions */}
                  <div className="flex items-center justify-between mt-1.5 px-1">
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                      {msg.timestamp && (
                        <span>{msg.timestamp.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</span>
                      )}
                      {msg.tokens && <span>• {msg.tokens} tokens</span>}
                    </div>
                    {/* Action buttons - show for both user and assistant messages */}
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {/* Copy button - for ALL messages */}
                      <button
                        onClick={() => handleCopy(msg.content, i)}
                        className={`p-1 rounded transition-colors ${
                          msg.role === 'user'
                            ? 'text-brand-300 hover:text-white hover:bg-brand-500/30'
                            : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
                        }`}
                        title="Copy"
                      >
                        {copiedIndex === i ? (
                          <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                        )}
                      </button>
                      {/* Regenerate button - only show on last assistant message */}
                      {msg.role === 'assistant' && i === messages.length - 1 && (
                        <button
                          onClick={handleRegenerate}
                          disabled={loading}
                          className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition-colors disabled:opacity-40"
                          title="Tạo lại"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                {msg.role === 'user' && (
                  <div className="w-10 h-10 rounded-xl bg-slate-200 flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                  </div>
                )}
              </div>
            ))}

            {loading && (
              <div className="flex gap-4 justify-start">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center flex-shrink-0 shadow">
                  <span className="text-sm font-bold text-white">Z</span>
                </div>
                <div className="bg-white border border-slate-200 rounded-2xl px-5 py-4 shadow-sm">
                  <div className="flex gap-1.5">
                    <span className="w-2.5 h-2.5 bg-brand-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
                    <span className="w-2.5 h-2.5 bg-brand-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
                    <span className="w-2.5 h-2.5 bg-brand-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input area - centered at bottom like Claude */}
      <div className="flex-shrink-0 px-4 py-4 border-t border-slate-200/50 bg-white/80 backdrop-blur">
        <div className="max-w-3xl mx-auto w-full">
          {/* Attachment previews */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3 p-3 bg-white rounded-xl border border-slate-200">
              {attachments.map((att, idx) => (
                <div key={idx} className="relative group">
                  {att.type === 'image' ? (
                    <img src={att.data} alt={att.name} className="w-16 h-16 rounded-lg object-cover" />
                  ) : (
                    <div className="w-16 h-16 rounded-lg bg-slate-100 flex items-center justify-center">
                      <svg className="w-6 h-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </div>
                  )}
                  <button
                    onClick={() => removeAttachment(idx)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="relative bg-white rounded-2xl border border-slate-200 shadow-sm focus-within:ring-2 focus-within:ring-brand-300 focus-within:border-transparent transition-all">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={t('chat.placeholder')}
              rows={1}
              className="w-full resize-none rounded-2xl px-5 py-4 pr-28 text-base focus:outline-none bg-transparent min-h-[56px] max-h-[200px]"
              disabled={loading}
              autoFocus
            />
            <div className="absolute right-2 bottom-2 flex items-center gap-1">
              {/* File upload button */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*"
                multiple
                className="hidden"
                onChange={(e) => e.target.files && handleFileProcess(e.target.files)}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-2.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-xl transition-colors"
                title={t('chat.attachFile')}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
              </button>
              {/* Send button */}
              <button
                onClick={handleSend}
                disabled={(!input.trim() && attachments.length === 0) || loading}
                className="p-2.5 bg-brand-600 text-white rounded-xl hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>

          {/* Footer with model info and clear button */}
          <div className="flex items-center justify-between mt-2 px-1">
            <div className="flex items-center gap-2">
              {aiStatus?.model && (
                <span className="text-xs text-slate-400">{aiStatus.model}</span>
              )}
            </div>
            {messages.length > 0 && (
              <button
                onClick={handleClear}
                className="text-xs text-slate-400 hover:text-red-500 transition-colors"
              >
                {t('chat.clear')}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      <DeleteModal />
    </div>
  );
}
