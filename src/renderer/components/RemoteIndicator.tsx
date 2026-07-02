import React from 'react';
import { RemoteControlState, RemoteSessionStatus } from '../../shared/types';

interface RemoteIndicatorProps {
  remoteState: RemoteControlState;
  onEndSession: () => void;
}

export default function RemoteIndicator({
  remoteState,
  onEndSession,
}: RemoteIndicatorProps) {
  // Don't show anything if not being controlled
  if (!remoteState.isBeingControlled || !remoteState.session) {
    return null;
  }

  const session = remoteState.session;

  // Format the session duration
  const getDuration = (): string => {
    if (!session.startedAt) return '00:00';
    const start = new Date(session.startedAt);
    const now = new Date();
    const diff = Math.floor((now.getTime() - start.getTime()) / 1000);
    const minutes = Math.floor(diff / 60);
    const seconds = diff % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  // Get connection quality color
  const getQualityColor = (): string => {
    switch (remoteState.connectionQuality) {
      case 'excellent':
        return 'bg-emerald-500';
      case 'good':
        return 'bg-emerald-400';
      case 'fair':
        return 'bg-yellow-400';
      case 'poor':
        return 'bg-red-400';
      default:
        return 'bg-slate-400';
    }
  };

  return (
    <div className="fixed top-0 left-0 right-0 z-50">
      {/* Red banner indicating remote control is active */}
      <div className="bg-red-600 text-white px-4 py-2 flex items-center justify-between shadow-lg">
        <div className="flex items-center gap-3">
          {/* Recording indicator */}
          <div className="flex items-center gap-2">
            <div className="relative">
              <div className="w-3 h-3 bg-white rounded-full animate-pulse"></div>
              <div className="absolute inset-0 w-3 h-3 bg-white rounded-full animate-ping opacity-75"></div>
            </div>
            <span className="font-semibold text-sm">REMOTE CONTROL ACTIVE</span>
          </div>

          {/* User info */}
          <div className="flex items-center gap-2 text-red-100 text-sm">
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
              />
            </svg>
            <span>{session.userName || 'Unknown user'}</span>
          </div>

          {/* Duration */}
          <div className="flex items-center gap-2 text-red-100 text-sm">
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <span>{getDuration()}</span>
          </div>

          {/* Connection quality */}
          <div className="flex items-center gap-2 text-red-100 text-sm">
            <div className={`w-2 h-2 rounded-full ${getQualityColor()}`}></div>
            <span className="capitalize">{remoteState.connectionQuality || 'Unknown'}</span>
          </div>
        </div>

        {/* End session button */}
        <button
          onClick={onEndSession}
          className="flex items-center gap-2 bg-red-700 hover:bg-red-800 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
          End Session
        </button>
      </div>

      {/* Security notice */}
      <div className="bg-red-500 text-red-100 text-xs px-4 py-1 text-center">
        Your screen is being shared and your mouse/keyboard can be controlled remotely.
        Click "End Session" to stop.
      </div>
    </div>
  );
}
