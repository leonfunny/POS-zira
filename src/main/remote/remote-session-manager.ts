/**
 * Remote Session Manager - Orchestrates remote control sessions
 * Manages screen capture, WebRTC connection, and input execution
 */

import { EventEmitter } from 'events';
import { BrowserWindow, dialog } from 'electron';
import { ScreenCapturer } from './screen-capturer';
import { WebRTCPeer } from './webrtc-peer';
import { InputExecutor } from './input-executor';
import {
  RemoteSession,
  RemoteSessionStatus,
  RemoteSessionRequest,
  RemoteSessionResponse,
  RemoteQuality,
  RemoteControlState,
  RTCSessionDescriptionInit,
  RTCIceCandidateInit,
  IceServer,
} from '../../shared/types';

// Session timeout: 30 minutes
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// Session request timeout: 30 seconds
const REQUEST_TIMEOUT_MS = 30 * 1000;

export interface RemoteSessionManagerOptions {
  iceServers?: IceServer[];
  autoAccept?: boolean; // For testing, auto-accept requests
}

export interface RemoteSessionManagerEvents {
  sessionRequest: (request: RemoteSessionRequest) => void;
  sessionStarted: (session: RemoteSession) => void;
  sessionEnded: (session: RemoteSession) => void;
  stateChanged: (state: RemoteControlState) => void;
  error: (error: Error) => void;
}

export class RemoteSessionManager extends EventEmitter {
  private _screenCapturer: ScreenCapturer;
  private webrtcPeer: WebRTCPeer;
  private _inputExecutor: InputExecutor;

  // Public getters for Telegram integration
  get screenCapturer(): ScreenCapturer {
    return this._screenCapturer;
  }

  get inputExecutor(): InputExecutor {
    return this._inputExecutor;
  }

  private currentSession: RemoteSession | null = null;
  private pendingRequest: RemoteSessionRequest | null = null;
  private requestTimeout: NodeJS.Timeout | null = null;
  private sessionTimeout: NodeJS.Timeout | null = null;

  private iceServers: IceServer[];
  private autoAccept: boolean;
  private initialized = false;

  constructor(options: RemoteSessionManagerOptions = {}) {
    super();
    this.iceServers = options.iceServers || [];
    this.autoAccept = options.autoAccept || false;

    this._screenCapturer = new ScreenCapturer();
    this.webrtcPeer = new WebRTCPeer({ iceServers: this.iceServers });
    this._inputExecutor = new InputExecutor();

    this.setupEventHandlers();
  }

  /**
   * Initialize the remote session manager
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Initialize input executor (loads nut-js)
      await this._inputExecutor.initialize();
      this.initialized = true;
      console.log('[RemoteSession] Initialized');
    } catch (error) {
      console.error('[RemoteSession] Initialization error:', error);
      // Continue even if nut-js fails - screen sharing will still work
      this.initialized = true;
    }
  }

  /**
   * Setup event handlers for components
   */
  private setupEventHandlers(): void {
    // Screen capturer events
    this._screenCapturer.on('ended', () => {
      console.log('[RemoteSession] Screen capture ended');
      this.endSession('Screen capture ended');
    });

    this._screenCapturer.on('error', (error) => {
      console.error('[RemoteSession] Screen capture error:', error);
      this.emit('error', error);
    });

    // WebRTC peer events
    this.webrtcPeer.on('iceCandidate', (candidate: RTCIceCandidateInit) => {
      this.emit('iceCandidate', candidate);
    });

    this.webrtcPeer.on('connectionStateChange', (state: RTCPeerConnectionState) => {
      console.log(`[RemoteSession] WebRTC connection state: ${state}`);
      this.updateSessionStatus(state);
    });

    this.webrtcPeer.on('dataChannelOpen', () => {
      console.log('[RemoteSession] Data channel open - enabling input');
      if (this._inputExecutor.isEnabled() !== undefined) {
        this._inputExecutor.setEnabled(true);
      } else {
        console.warn('[RemoteSession] Input executor not initialized, input disabled');
      }
    });

    this.webrtcPeer.on('dataChannelClose', () => {
      console.log('[RemoteSession] Data channel closed - disabling input');
      this._inputExecutor.setEnabled(false);
    });

    this.webrtcPeer.on('inputEvent', (event) => {
      this._inputExecutor.executeEvent(event);
    });

    this.webrtcPeer.on('error', (error) => {
      console.error('[RemoteSession] WebRTC error:', error);
      this.emit('error', error);
    });

    // Input executor events
    this._inputExecutor.on('error', (error) => {
      console.error('[RemoteSession] Input executor error:', error);
    });
  }

  /**
   * Update session status based on WebRTC state
   */
  private updateSessionStatus(state: RTCPeerConnectionState): void {
    if (!this.currentSession) return;

    switch (state) {
      case 'connecting':
        this.currentSession.status = RemoteSessionStatus.CONNECTING;
        break;
      case 'connected':
        this.currentSession.status = RemoteSessionStatus.CONNECTED;
        this.currentSession.startedAt = new Date();
        this.emit('sessionStarted', this.currentSession);
        this.startSessionTimeout();
        break;
      case 'disconnected':
      case 'failed':
      case 'closed':
        this.endSession(`Connection ${state}`);
        break;
    }

    this.emitStateChanged();
  }

  /**
   * Handle incoming session request from dashboard
   */
  async handleSessionRequest(request: RemoteSessionRequest): Promise<void> {
    console.log('[RemoteSession] Session request received:', request);

    // Check if already in a session
    if (this.currentSession && this.currentSession.status === RemoteSessionStatus.CONNECTED) {
      console.log('[RemoteSession] Already in session, rejecting');
      this.emit('sessionResponse', {
        sessionId: request.sessionId,
        accepted: false,
        reason: 'Already in a remote session',
      } as RemoteSessionResponse);
      return;
    }

    // Store pending request
    this.pendingRequest = request;

    // Set request timeout
    this.requestTimeout = setTimeout(() => {
      if (this.pendingRequest?.sessionId === request.sessionId) {
        console.log('[RemoteSession] Request timed out');
        this.rejectSession('Request timed out');
      }
    }, REQUEST_TIMEOUT_MS);

    // Emit event for UI to show dialog
    this.emit('sessionRequest', request);

    // Auto-accept for testing
    if (this.autoAccept) {
      setTimeout(() => this.acceptSession(), 1000);
    }
  }

  /**
   * Accept pending session request
   */
  async acceptSession(): Promise<void> {
    if (!this.pendingRequest) {
      console.warn('[RemoteSession] No pending request to accept');
      return;
    }

    const request = this.pendingRequest;
    this.clearRequestTimeout();

    console.log('[RemoteSession] Accepting session:', request.sessionId);

    // Create session
    this.currentSession = {
      sessionId: request.sessionId,
      userId: request.userId,
      userName: request.userName,
      salonId: request.salonId,
      quality: request.quality,
      status: RemoteSessionStatus.PENDING,
    };

    try {
      // Start screen capture
      this._screenCapturer.setQuality(request.quality);
      const stream = await this._screenCapturer.startCapture();

      // Initialize WebRTC peer
      if (this.iceServers.length > 0) {
        this.webrtcPeer.setIceServers(this.iceServers);
      }
      await this.webrtcPeer.initialize(stream);

      // Emit acceptance
      this.emit('sessionResponse', {
        sessionId: request.sessionId,
        accepted: true,
      } as RemoteSessionResponse);

      this.pendingRequest = null;
      this.emitStateChanged();
    } catch (error) {
      console.error('[RemoteSession] Error accepting session:', error);
      this.rejectSession(`Error: ${(error as Error).message}`);
    }
  }

  /**
   * Reject pending session request
   */
  rejectSession(reason: string = 'User rejected'): void {
    if (!this.pendingRequest) {
      return;
    }

    console.log('[RemoteSession] Rejecting session:', reason);

    this.emit('sessionResponse', {
      sessionId: this.pendingRequest.sessionId,
      accepted: false,
      reason,
    } as RemoteSessionResponse);

    this.clearRequestTimeout();
    this.pendingRequest = null;
    this.emitStateChanged();
  }

  /**
   * Handle WebRTC offer from dashboard
   */
  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    if (!this.currentSession) {
      throw new Error('No active session');
    }

    console.log('[RemoteSession] Handling WebRTC offer');
    const answer = await this.webrtcPeer.handleOffer(offer);
    return answer;
  }

  /**
   * Handle ICE candidate from dashboard
   */
  async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.webrtcPeer.addIceCandidate(candidate);
  }

  /**
   * End current session
   */
  endSession(reason: string = 'Session ended'): void {
    if (!this.currentSession) {
      return;
    }

    console.log('[RemoteSession] Ending session:', reason);

    const session = this.currentSession;
    session.status = RemoteSessionStatus.DISCONNECTED;
    session.endedAt = new Date();

    // Stop all components
    this._inputExecutor.setEnabled(false);
    this.webrtcPeer.close();
    this._screenCapturer.stopCapture();

    // Clear timeouts
    this.clearSessionTimeout();
    this.clearRequestTimeout();

    // Emit session ended (single event with full session data)
    this.emit('sessionEnded', session);

    this.currentSession = null;
    this.pendingRequest = null;
    this.emitStateChanged();
  }

  /**
   * Set quality during active session
   */
  async setQuality(quality: RemoteQuality): Promise<void> {
    if (!this.currentSession) {
      return;
    }

    console.log('[RemoteSession] Changing quality to:', quality);
    this.currentSession.quality = quality;

    // Restart capture with new quality
    this._screenCapturer.setQuality(quality);
    // Note: In a real implementation, you might need to renegotiate WebRTC
    this.emitStateChanged();
  }

  /**
   * Set ICE servers (for TURN)
   */
  setIceServers(servers: IceServer[]): void {
    this.iceServers = servers;
    this.webrtcPeer.setIceServers(servers);
  }

  /**
   * Get current state for UI
   */
  getState(): RemoteControlState {
    return {
      isBeingControlled:
        this.currentSession?.status === RemoteSessionStatus.CONNECTED,
      session: this.currentSession,
      connectionQuality: this.getConnectionQuality(),
    };
  }

  /**
   * Emit state changed event
   */
  private emitStateChanged(): void {
    this.emit('stateChanged', this.getState());
  }

  /**
   * Get connection quality indicator
   */
  private getConnectionQuality(): 'poor' | 'fair' | 'good' | 'excellent' | undefined {
    if (!this.webrtcPeer.isConnected()) {
      return undefined;
    }
    // TODO: Implement actual quality measurement from WebRTC stats
    return 'good';
  }

  /**
   * Start session timeout
   */
  private startSessionTimeout(): void {
    this.clearSessionTimeout();
    this.sessionTimeout = setTimeout(() => {
      console.log('[RemoteSession] Session timed out');
      this.endSession('Session timeout (30 minutes)');
    }, SESSION_TIMEOUT_MS);
  }

  /**
   * Clear session timeout
   */
  private clearSessionTimeout(): void {
    if (this.sessionTimeout) {
      clearTimeout(this.sessionTimeout);
      this.sessionTimeout = null;
    }
  }

  /**
   * Clear request timeout
   */
  private clearRequestTimeout(): void {
    if (this.requestTimeout) {
      clearTimeout(this.requestTimeout);
      this.requestTimeout = null;
    }
  }

  /**
   * Check if has active session
   */
  hasActiveSession(): boolean {
    return (
      this.currentSession !== null &&
      this.currentSession.status === RemoteSessionStatus.CONNECTED
    );
  }

  /**
   * Get pending request
   */
  getPendingRequest(): RemoteSessionRequest | null {
    return this.pendingRequest;
  }

  /**
   * Show session request dialog to user
   */
  async showSessionRequestDialog(
    request: RemoteSessionRequest,
    parentWindow?: BrowserWindow
  ): Promise<boolean> {
    const message = `${request.userName || 'Someone'} wants to remotely control this computer.\n\nDo you want to allow this?`;

    // Get window - use parentWindow, focused window, or show without parent
    const targetWindow = parentWindow || BrowserWindow.getFocusedWindow();

    const dialogOptions = {
      type: 'question' as const,
      buttons: ['Allow', 'Deny'],
      defaultId: 1,
      cancelId: 1,
      title: 'Remote Control Request',
      message: 'Remote Control Request',
      detail: message,
    };

    const result = targetWindow
      ? await dialog.showMessageBox(targetWindow, dialogOptions)
      : await dialog.showMessageBox(dialogOptions);

    return result.response === 0;
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    console.log('[RemoteSession] Destroying...');
    this.endSession('Manager destroyed');
    this._screenCapturer.destroy();
    this.webrtcPeer.destroy();
    this._inputExecutor.destroy();
    this.removeAllListeners();
    console.log('[RemoteSession] Destroyed');
  }
}
