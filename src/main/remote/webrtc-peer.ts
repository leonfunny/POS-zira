/**
 * WebRTC Peer - Handles WebRTC peer connection for remote control
 * Agent side: Sends video stream, receives input events via DataChannel
 */

import { EventEmitter } from 'events';
import {
  IceServer,
  RTCSessionDescriptionInit,
  RTCIceCandidateInit,
  RemoteInputEvent,
} from '../../shared/types';

// Default ICE servers
const DEFAULT_ICE_SERVERS: IceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

export interface WebRTCPeerOptions {
  iceServers?: IceServer[];
  iceCandidatePoolSize?: number;
}

export interface WebRTCPeerEvents {
  iceCandidate: (candidate: RTCIceCandidateInit) => void;
  connectionStateChange: (state: RTCPeerConnectionState) => void;
  iceConnectionStateChange: (state: RTCIceConnectionState) => void;
  inputEvent: (event: RemoteInputEvent) => void;
  dataChannelOpen: () => void;
  dataChannelClose: () => void;
  error: (error: Error) => void;
}

export class WebRTCPeer extends EventEmitter {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private localStream: MediaStream | null = null;
  private iceServers: IceServer[];
  private iceCandidatePoolSize: number;
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private isConnecting = false;

  constructor(options: WebRTCPeerOptions = {}) {
    super();
    this.iceServers = options.iceServers || DEFAULT_ICE_SERVERS;
    this.iceCandidatePoolSize = options.iceCandidatePoolSize || 10;
  }

  /**
   * Set ICE servers (for TURN server configuration)
   */
  setIceServers(servers: IceServer[]): void {
    this.iceServers = servers;
    console.log('[WebRTCPeer] ICE servers updated:', servers.length);
  }

  /**
   * Create peer connection and prepare for incoming offer
   */
  async initialize(stream: MediaStream): Promise<void> {
    if (this.peerConnection) {
      console.log('[WebRTCPeer] Already initialized, closing existing connection');
      this.close();
    }

    this.localStream = stream;
    this.isConnecting = true;

    // Create RTCPeerConnection
    const config: RTCConfiguration = {
      iceServers: this.iceServers.map((server) => ({
        urls: server.urls,
        username: server.username,
        credential: server.credential,
      })),
      iceCandidatePoolSize: this.iceCandidatePoolSize,
    };

    this.peerConnection = new RTCPeerConnection(config);
    console.log('[WebRTCPeer] Peer connection created');

    // Add video tracks to connection
    stream.getTracks().forEach((track) => {
      console.log(`[WebRTCPeer] Adding track: ${track.kind}`);
      this.peerConnection!.addTrack(track, stream);
    });

    // Setup event handlers
    this.setupEventHandlers();

    console.log('[WebRTCPeer] Initialized with stream');
  }

  /**
   * Handle incoming offer from dashboard and create answer
   */
  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    if (!this.peerConnection) {
      throw new Error('Peer connection not initialized');
    }

    console.log('[WebRTCPeer] Handling offer');

    try {
      // Set remote description (offer from dashboard)
      await this.peerConnection.setRemoteDescription(
        new RTCSessionDescription(offer)
      );
      console.log('[WebRTCPeer] Remote description set');

      // Apply any pending ICE candidates
      for (const candidate of this.pendingIceCandidates) {
        await this.addIceCandidate(candidate);
      }
      this.pendingIceCandidates = [];

      // Create answer
      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);
      console.log('[WebRTCPeer] Answer created and local description set');

      return {
        type: answer.type as 'answer',
        sdp: answer.sdp || '',
      };
    } catch (error) {
      console.error('[WebRTCPeer] Error handling offer:', error);
      throw error;
    }
  }

  /**
   * Add ICE candidate received from dashboard
   */
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.peerConnection) {
      // Queue candidate for later if connection not ready
      this.pendingIceCandidates.push(candidate);
      return;
    }

    // Check if remote description is set
    if (!this.peerConnection.remoteDescription) {
      this.pendingIceCandidates.push(candidate);
      return;
    }

    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      console.log('[WebRTCPeer] ICE candidate added');
    } catch (error) {
      console.error('[WebRTCPeer] Error adding ICE candidate:', error);
    }
  }

  /**
   * Setup WebRTC event handlers
   */
  private setupEventHandlers(): void {
    if (!this.peerConnection) return;

    // ICE candidate handler - send to dashboard via signaling
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('[WebRTCPeer] Local ICE candidate generated');
        this.emit('iceCandidate', {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid || undefined,
          sdpMLineIndex: event.candidate.sdpMLineIndex ?? undefined,
        });
      }
    };

    // Connection state change
    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState;
      console.log(`[WebRTCPeer] Connection state: ${state}`);
      this.emit('connectionStateChange', state);

      if (state === 'connected') {
        this.isConnecting = false;
      } else if (state === 'failed' || state === 'disconnected') {
        this.emit('error', new Error(`Connection ${state}`));
      }
    };

    // ICE connection state change
    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection?.iceConnectionState;
      console.log(`[WebRTCPeer] ICE connection state: ${state}`);
      this.emit('iceConnectionStateChange', state);
    };

    // ICE gathering state change
    this.peerConnection.onicegatheringstatechange = () => {
      console.log(
        `[WebRTCPeer] ICE gathering state: ${this.peerConnection?.iceGatheringState}`
      );
    };

    // Data channel handler - for receiving input events
    this.peerConnection.ondatachannel = (event) => {
      console.log('[WebRTCPeer] Data channel received:', event.channel.label);
      this.setupDataChannel(event.channel);
    };
  }

  /**
   * Setup data channel for input events
   */
  private setupDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;

    channel.onopen = () => {
      console.log('[WebRTCPeer] Data channel opened');
      this.emit('dataChannelOpen');
    };

    channel.onclose = () => {
      console.log('[WebRTCPeer] Data channel closed');
      this.emit('dataChannelClose');
    };

    channel.onerror = (error) => {
      console.error('[WebRTCPeer] Data channel error:', error);
      this.emit('error', new Error('Data channel error'));
    };

    channel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'mouse' || data.type === 'keyboard') {
          this.emit('inputEvent', data as RemoteInputEvent);
        } else {
          console.log('[WebRTCPeer] Unknown message type:', data.type);
        }
      } catch (error) {
        console.error('[WebRTCPeer] Error parsing message:', error);
      }
    };
  }

  /**
   * Send a message through the data channel
   */
  sendMessage(message: any): void {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(message));
    }
  }

  /**
   * Get connection state
   */
  getConnectionState(): RTCPeerConnectionState | null {
    return this.peerConnection?.connectionState || null;
  }

  /**
   * Get ICE connection state
   */
  getIceConnectionState(): RTCIceConnectionState | null {
    return this.peerConnection?.iceConnectionState || null;
  }

  /**
   * Check if data channel is open
   */
  isDataChannelOpen(): boolean {
    return this.dataChannel?.readyState === 'open';
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.peerConnection?.connectionState === 'connected';
  }

  /**
   * Get connection statistics
   */
  async getStats(): Promise<RTCStatsReport | null> {
    if (!this.peerConnection) return null;
    return this.peerConnection.getStats();
  }

  /**
   * Close the peer connection
   */
  close(): void {
    console.log('[WebRTCPeer] Closing connection');

    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.localStream = null;
    this.pendingIceCandidates = [];
    this.isConnecting = false;

    console.log('[WebRTCPeer] Connection closed');
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.close();
    this.removeAllListeners();
    console.log('[WebRTCPeer] Destroyed');
  }
}
