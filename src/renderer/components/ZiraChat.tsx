import React, { useState, useRef, useEffect } from 'react';
import { ZiraAIStatus, ZiraAIChatResponse, AuthUser } from '../../shared/types';
import AuthScreen from './AuthScreen';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  usage?: ZiraAIChatResponse['usage'];
}

export default function ZiraChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<ZiraAIStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authChecking, setAuthChecking] = useState(true);

  useEffect(() => {
    async function checkAuth() {
      try {
        const result = await window.electronAPI.auth.getUser();
        if (result.success && result.data?.isAuthenticated && result.data.user) {
          setIsAuthenticated(true);
          setAuthUser(result.data.user);
        } else {
          setIsAuthenticated(false);
        }
      } catch (err) {
        console.error('[ZiraChat] Auth check failed:', err);
        setIsAuthenticated(false);
      } finally {
        setAuthChecking(false);
      }
    }
    checkAuth();
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;

    async function loadStatus() {
      try {
        const s = await window.electronAPI.ai.getStatus();
        setStatus(s);
      } catch (err) {
        console.error('[ZiraChat] Failed to get AI status:', err);
      } finally {
        setStatusLoading(false);
      }
    }
    loadStatus();
  }, [isAuthenticated]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (isAuthenticated) {
      inputRef.current?.focus();
    }
  }, [isAuthenticated]);

  const handleLoginSuccess = (user: AuthUser) => {
    setAuthUser(user);
    setIsAuthenticated(true);
  };

  const handleLogout = async () => {
    try {
      await window.electronAPI.auth.logout();
      setIsAuthenticated(false);
      setAuthUser(null);
      setMessages([]);
      setStatus(null);
      setStatusLoading(true);
    } catch (err) {
      console.error('[ZiraChat] Logout failed:', err);
    }
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = {
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const result = await window.electronAPI.ai.chat(text);
      if (result.success && result.data) {
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: result.data.content,
          timestamp: Date.now(),
          usage: result.data.usage,
        };
        setMessages((prev) => [...prev, assistantMsg]);
        const s = await window.electronAPI.ai.getStatus();
        setStatus(s);
      } else {
        const errorMsg: ChatMessage = {
          role: 'assistant',
          content: `Error: ${result.error || 'No response returned'}`,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, errorMsg]);
      }
    } catch (err: any) {
      const errorMsg: ChatMessage = {
        role: 'assistant',
        content: `Error: ${err.message || 'Unknown error'}`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleClearHistory = async () => {
    try {
      await window.electronAPI.ai.clearHistory();
      setMessages([]);
      const s = await window.electronAPI.ai.getStatus();
      setStatus(s);
    } catch (err) {
      console.error('[ZiraChat] Failed to clear history:', err);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (authChecking) {
    return (
      <div className="relative overflow-hidden rounded-2xl" style={{ height: 'calc(100vh - 180px)' }}>
        <div className="absolute inset-0 hero-bg">
          <div className="hero-orb orb-1"></div>
          <div className="hero-orb orb-2"></div>
          <div className="hero-orb orb-3"></div>
        </div>
        <div className="relative z-10 h-full flex items-center justify-center bg-white/60 backdrop-blur-sm border border-white/40 rounded-2xl shadow-lg">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-600"></div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <AuthScreen onLoginSuccess={handleLoginSuccess} />;
  }

  if (statusLoading) {
    return (
      <div className="relative overflow-hidden rounded-2xl" style={{ height: 'calc(100vh - 180px)' }}>
        <div className="absolute inset-0 hero-bg">
          <div className="hero-orb orb-1"></div>
          <div className="hero-orb orb-2"></div>
          <div className="hero-orb orb-3"></div>
        </div>
        <div className="relative z-10 h-full flex items-center justify-center bg-white/60 backdrop-blur-sm border border-white/40 rounded-2xl shadow-lg">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-600"></div>
        </div>
      </div>
    );
  }

  if (!status?.enabled || !status?.hasApiKey) {
    return (
      <div className="relative overflow-hidden rounded-2xl" style={{ height: 'calc(100vh - 180px)' }}>
        {/* Dynamic Pink Background */}
        <div className="absolute inset-0 hero-bg">
          <div className="hero-orb orb-1"></div>
          <div className="hero-orb orb-2"></div>
          <div className="hero-orb orb-3"></div>
        </div>

        {/* Glass panel overlay */}
        <div className="relative z-10 h-full flex flex-col bg-white/60 backdrop-blur-sm border border-white/40 rounded-2xl shadow-lg p-6">
          <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-200/50">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-brand-100/80 backdrop-blur-sm flex items-center justify-center">
                <span className="text-xs font-medium text-brand-700">
                  {authUser?.firstName?.charAt(0) || 'U'}
                </span>
              </div>
              <span className="text-xs text-slate-600">
                {authUser?.firstName} {authUser?.lastName}
                {authUser?.salonName && <span className="text-slate-400"> - {authUser.salonName}</span>}
              </span>
            </div>
            <button
              onClick={handleLogout}
              className="text-xs text-slate-400 hover:text-red-500 transition-colors"
              title="Sign out"
            >
              Sign out
            </button>
          </div>

          <div className="flex-1 flex flex-col items-center justify-center text-center gap-4">
            <div className="w-14 h-14 rounded-full bg-brand-100/80 backdrop-blur-sm flex items-center justify-center shadow-sm">
              <svg className="w-7 h-7 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714a2.25 2.25 0 00.659 1.591L19 14.5M14.25 3.104c.251.023.501.05.75.082M19 14.5l-2.47 2.47a2.25 2.25 0 01-1.591.659H9.061a2.25 2.25 0 01-1.591-.659L5 14.5m14 0V17a2 2 0 01-2 2H7a2 2 0 01-2-2v-2.5" />
              </svg>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-slate-800 mb-1">Zira AI is not configured</h3>
              <p className="text-sm text-slate-500 max-w-sm">
                {!status?.enabled
                  ? 'Enable Zira AI in Settings and add an API key to start a conversation.'
                  : 'Add an API key in Settings to start chatting with Zira AI.'}
              </p>
            </div>
            <div className="flex items-center gap-2 px-3 py-2 bg-amber-50/80 backdrop-blur-sm rounded-xl text-sm text-amber-800 shadow-sm">
              <svg className="w-4 h-4 text-amber-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Settings → Zira AI → Enable and add API key
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-2xl" style={{ height: 'calc(100vh - 180px)' }}>
      {/* Dynamic Pink Background */}
      <div className="absolute inset-0 hero-bg">
        <div className="hero-orb orb-1"></div>
        <div className="hero-orb orb-2"></div>
        <div className="hero-orb orb-3"></div>
      </div>

      {/* Glass panel overlay */}
      <div className="relative z-10 h-full flex flex-col bg-white/60 backdrop-blur-sm border border-white/40 rounded-2xl shadow-lg">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200/50 bg-white/70 backdrop-blur-sm rounded-t-2xl">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-brand-600 flex items-center justify-center">
            <span className="text-white text-xs font-bold">AI</span>
          </div>
          <div>
            <p className="text-sm font-medium text-slate-800">Zira AI</p>
            <p className="text-xs text-slate-500">
              {status.model || 'grok-4.1-fast'}
              {status.totalTokensUsed ? ` - ${status.totalTokensUsed.toLocaleString()} tokens` : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-2 py-1 bg-brand-50 rounded-md" title={`${authUser?.firstName} ${authUser?.lastName}${authUser?.salonName ? ` - ${authUser.salonName}` : ''}`}>
            <div className="w-4 h-4 rounded-full bg-brand-200 flex items-center justify-center">
              <span className="text-[9px] font-medium text-brand-700">
                {authUser?.firstName?.charAt(0) || 'U'}
              </span>
            </div>
            <span className="text-[10px] text-brand-700 font-medium max-w-[80px] truncate">
              {authUser?.firstName}
            </span>
          </div>

          <button
            onClick={handleLogout}
            className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors"
            title="Sign out"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>

          <button
            onClick={handleClearHistory}
            disabled={messages.length === 0 && !status.conversationCount}
            className="px-2.5 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Clear history"
          >
            Clear
          </button>
        </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center gap-2 py-8">
              <div className="w-10 h-10 rounded-full bg-brand-100/80 backdrop-blur-sm flex items-center justify-center">
                <svg className="w-5 h-5 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                </svg>
              </div>
              <p className="text-sm text-slate-600 font-medium">Type a message to start chatting</p>
              {authUser?.salonName && (
                <p className="text-xs text-slate-500">Salon: {authUser.salonName}</p>
              )}
            </div>
          )}

          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-xl px-3 py-2 text-sm shadow-sm ${
                  msg.role === 'user'
                    ? 'bg-brand-600 text-white'
                    : 'bg-white/90 backdrop-blur-sm border border-white/60 text-slate-800'
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                <p
                  className={`text-[10px] mt-1 ${
                    msg.role === 'user' ? 'text-brand-100' : 'text-slate-400'
                  }`}
                >
                  {new Date(msg.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                  {msg.usage && ` - ${msg.usage.totalTokens} tokens`}
                </p>
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-white/90 backdrop-blur-sm border border-white/60 rounded-xl px-3 py-2 shadow-sm">
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-bounce" style={{ animationDelay: '0ms' }}></div>
                  <div className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-bounce" style={{ animationDelay: '150ms' }}></div>
                  <div className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-bounce" style={{ animationDelay: '300ms' }}></div>
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <div className="border-t border-slate-200/50 px-3 py-2.5 bg-white/70 backdrop-blur-sm rounded-b-2xl">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              rows={1}
              disabled={loading}
              className="flex-1 resize-none px-3 py-2 bg-white/80 border border-slate-200/60 rounded-xl text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none disabled:opacity-50 max-h-24 backdrop-blur-sm"
              style={{ minHeight: '38px' }}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || loading}
              className="px-3 py-2 bg-brand-600 text-white rounded-xl hover:bg-brand-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0 shadow-sm"
              title="Send (Enter)"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
