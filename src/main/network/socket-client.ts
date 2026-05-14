import { io, Socket } from 'socket.io-client';
import { EventEmitter } from 'events';
import logger from '../logger';
import {
  PrintJobEvent,
  PrintJobStatus,
  RemoteSessionRequest,
  RemoteSessionResponse,
  RTCSessionDescriptionInit,
  RTCIceCandidateInit,
  SshTunnelRequest,
  SshTunnelResponse,
} from '../../shared/types';

/**
 * Socket.IO client for connecting to eNail backend
 */
export default class SocketClient extends EventEmitter {
  private socket: Socket | null = null;
  private remoteSocket: Socket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = Infinity;
  private reconnectDelay = 5000;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  /**
   * Connect to the server using API Key
   */
  async connectWithApiKey(serverUrl: string, apiKey: string, machineId?: string): Promise<void> {
    if (this.socket?.connected) {
      logger.warn('Already connected');
      return;
    }

    // Disconnect any existing socket to prevent orphaned connections
    this.cleanupExistingSocket();

    logger.info(`Connecting to ${serverUrl}/print-agent with API Key...`);

    this.socket = io(`${serverUrl}/print-agent`, {
      auth: {
        apiKey,
        ...(machineId && { machineId }),
      },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: this.maxReconnectAttempts,
      reconnectionDelay: this.reconnectDelay,
    });

    this.setupEventHandlers();

    // Connect remote socket to /print-agent-remote namespace
    this.connectRemoteSocket(serverUrl, apiKey, machineId);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Connection timeout'));
      }, 30000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.socket?.off('connected', onConnected);
        this.socket?.off('error', onError);
        this.socket?.off('disconnect', onDisconnect);
      };

      const onConnected = (data: any) => {
        cleanup();
        logger.info(`Connected to server. Agent ID: ${data.agentId}, Pending jobs: ${data.pendingJobs}`);
        this.startHeartbeat();
        resolve();
      };

      const onError = (error: any) => {
        cleanup();
        logger.error(`Connection error: ${error.message}`);
        reject(error);
      };

      const onDisconnect = (reason: string) => {
        cleanup();
        reject(new Error(`Socket disconnected during connect: ${reason}`));
      };

      this.socket!.once('connected', onConnected);
      this.socket!.once('error', onError);
      this.socket!.once('disconnect', onDisconnect);
    });
  }

  /**
   * Connect to the server (legacy - using machineId and token)
   * @deprecated Use connectWithApiKey instead
   */
  async connect(serverUrl: string, machineId: string, token: string): Promise<void> {
    if (this.socket?.connected) {
      logger.warn('Already connected');
      return;
    }

    // Disconnect any existing socket to prevent orphaned connections
    this.cleanupExistingSocket();

    logger.info(`Connecting to ${serverUrl}/print-agent (legacy)...`);

    this.socket = io(`${serverUrl}/print-agent`, {
      auth: {
        machineId,
        token,
      },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: this.maxReconnectAttempts,
      reconnectionDelay: this.reconnectDelay,
    });

    this.setupEventHandlers();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Connection timeout'));
      }, 30000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.socket?.off('connected', onConnected);
        this.socket?.off('error', onError);
        this.socket?.off('disconnect', onDisconnect);
      };

      const onConnected = (data: any) => {
        cleanup();
        logger.info(`Connected to server. Agent ID: ${data.agentId}, Pending jobs: ${data.pendingJobs}`);
        this.startHeartbeat();
        resolve();
      };

      const onError = (error: any) => {
        cleanup();
        logger.error(`Connection error: ${error.message}`);
        reject(error);
      };

      const onDisconnect = (reason: string) => {
        cleanup();
        reject(new Error(`Socket disconnected during connect: ${reason}`));
      };

      this.socket!.once('connected', onConnected);
      this.socket!.once('error', onError);
      this.socket!.once('disconnect', onDisconnect);
    });
  }

  /**
   * Disconnect from server
   */
  disconnect(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.remoteSocket) {
      this.remoteSocket.removeAllListeners();
      this.remoteSocket.disconnect();
      this.remoteSocket = null;
      logger.info('Remote socket disconnected');
    }

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }

    logger.info('Disconnected from server');
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.socket?.connected || false;
  }

  /**
   * Request Elavon card payment via backend gateway
   */
  requestElavonPayment(data: { amount: number; orderId: string }): void {
    if (!this.socket?.connected) {
      logger.warn('Cannot request Elavon payment: not connected');
      return;
    }
    this.socket.emit('elavon:payment-request', data);
    logger.info(`[Socket] Elavon payment requested: ${data.orderId}, amount: ${data.amount}`);
  }

  sendJobStatus(jobId: string, status: string, errorMessage?: string): void {
    if (!this.socket?.connected) {
      logger.warn('Cannot send job status: not connected');
      return;
    }

    this.socket.emit('job:status', {
      jobId,
      status,
      errorMessage,
    });

    logger.debug(`Sent job status: ${jobId} -> ${status}`);
  }

  /**
   * Send barcode scan event
   */
  sendBarcodeScan(barcode: string): void {
    if (!this.socket?.connected) {
      logger.warn('Cannot send barcode scan: not connected');
      return;
    }

    this.socket.emit('scan:barcode', {
      barcode,
      timestamp: new Date().toISOString(),
    });

    logger.debug(`Sent barcode scan: ${barcode}`);
  }

  /**
   * Send device status
   */
  sendDeviceStatus(status: {
    printerConnected: boolean;
    printerPort: string | null;
    scannerActive: boolean;
    appVersion: string;
    printerStatuses?: Array<{
      printerId: string;
      isOnline: boolean;
      lastError?: string | null;
    }>;
  }): void {
    if (!this.socket?.connected) {
      return;
    }

    this.socket.emit('device:status', status);
    logger.debug('Sent device status');
  }

  // ==========================================
  // Remote Control Methods (via /print-agent-remote namespace)
  // ==========================================

  /**
   * Send remote session response (accept/reject)
   */
  sendRemoteSessionResponse(response: RemoteSessionResponse): void {
    if (!this.remoteSocket?.connected) {
      logger.warn('Cannot send remote session response: remote socket not connected');
      return;
    }

    this.remoteSocket.emit('remote:session-response', response);
    logger.info(`Sent remote session response: ${response.accepted ? 'accepted' : 'rejected'}`);
  }

  /**
   * Send WebRTC answer to dashboard
   */
  sendRemoteAnswer(sessionId: string, answer: RTCSessionDescriptionInit): void {
    if (!this.remoteSocket?.connected) {
      logger.warn('Cannot send remote answer: remote socket not connected');
      return;
    }

    this.remoteSocket.emit('remote:answer', {
      sessionId,
      answer,
    });
    logger.debug('Sent WebRTC answer');
  }

  /**
   * Send ICE candidate to dashboard
   */
  sendRemoteIceCandidate(sessionId: string, candidate: RTCIceCandidateInit): void {
    if (!this.remoteSocket?.connected) {
      logger.warn('Cannot send remote ICE candidate: remote socket not connected');
      return;
    }

    this.remoteSocket.emit('remote:ice-candidate', {
      sessionId,
      candidate,
    });
    logger.debug('Sent ICE candidate');
  }

  /**
   * Send remote session end notification
   */
  sendRemoteSessionEnd(sessionId: string, reason?: string): void {
    if (!this.remoteSocket?.connected) {
      logger.warn('Cannot send remote session end: remote socket not connected');
      return;
    }

    this.remoteSocket.emit('remote:session-end', {
      sessionId,
      reason,
    });
    logger.info(`Sent remote session end: ${reason || 'no reason'}`);
  }

  // ==========================================
  // SSH Tunnel Methods
  // ==========================================

  /**
   * Send SSH tunnel response (accept/reject with port + public key)
   */
  sendSshTunnelResponse(response: SshTunnelResponse): void {
    if (!this.socket?.connected) {
      logger.warn('Cannot send SSH tunnel response: not connected');
      return;
    }

    this.socket.emit('ssh-tunnel:response', response);
    logger.info(`Sent SSH tunnel response: ${response.accepted ? 'accepted' : 'rejected'}`);
  }

  /**
   * Notify backend that SSH tunnel was auto-started (sshTunnelEnabled)
   * Backend receives port + username so admin can SSH in
   */
  sendSshTunnelRegistered(data: { port: number; username: string; publicKey?: string }): void {
    if (!this.socket?.connected) {
      logger.warn('Cannot send SSH tunnel registered: not connected');
      return;
    }

    this.socket.emit('ssh-tunnel:registered', data);
    logger.info(`Sent SSH tunnel registered: port=${data.port}, username=${data.username}`);
  }

  /**
   * Notify backend that SSH tunnel has disconnected
   */
  sendSshTunnelDisconnected(requestId: string): void {
    if (!this.socket?.connected) {
      logger.warn('Cannot send SSH tunnel disconnected: not connected');
      return;
    }

    this.socket.emit('ssh-tunnel:disconnected', { requestId });
    logger.info('Sent SSH tunnel disconnected notification');
  }

  /**
   * Cleanup existing socket connection to prevent orphaned sockets
   */
  private cleanupExistingSocket(): void {
    if (this.remoteSocket) {
      logger.info('Cleaning up existing remote socket');
      this.remoteSocket.removeAllListeners();
      this.remoteSocket.disconnect();
      this.remoteSocket = null;
    }
    if (this.socket) {
      logger.info('Cleaning up existing socket before new connection');
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Setup socket event handlers
   */
  private setupEventHandlers(): void {
    if (!this.socket) return;

    // Defensive: remove any existing listeners before adding new ones
    this.socket.removeAllListeners();

    // Connection events
    this.socket.on('connect', () => {
      logger.info('Socket connected');
      this.reconnectAttempts = 0;
      this.emit('connected');
    });

    this.socket.on('disconnect', (reason) => {
      logger.info(`Socket disconnected: ${reason}`);
      this.emit('disconnected');
    });

    this.socket.on('connect_error', (error) => {
      logger.error(`Connection error: ${error.message}`);
      this.reconnectAttempts++;

      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        logger.error('Max reconnect attempts reached');
        this.emit('error', new Error('Max reconnect attempts reached'));
      }
    });

    // Business events
    this.socket.on('job:new', (job: PrintJobEvent) => {
      logger.info(`Received print job: ${job.jobId}`);
      this.emit('job:new', job);
    });

    this.socket.on('job:updated', (data) => {
      logger.debug(`Job updated: ${data.jobId} -> ${data.status}`);
      this.emit('job:updated', data);
    });

    this.socket.on('barcode:scanned', (data) => {
      // This is broadcast from server, we sent it
      logger.debug(`Barcode scan confirmed: ${data.barcode}`);
    });

    this.socket.on('device:status', (data) => {
      logger.debug('Device status update received');
      this.emit('device:status', data);
    });

    // NOTE: Remote Control Events are handled on remoteSocket (see connectRemoteSocket)

    // ==========================================
    // SSH Tunnel Events
    // ==========================================

    this.socket.on('ssh-tunnel:request', (request: SshTunnelRequest) => {
      logger.info(`SSH tunnel request received from: ${request.userName}`);
      this.emit('ssh-tunnel:request', request);
    });

    // ==========================================
    // POS Catalog & Stock Events
    // ==========================================

    this.socket.on('catalog:updated', (data: { variantId: string; changes: any }) => {
      logger.debug(`Catalog updated: ${data.variantId}`);
      this.emit('catalog:updated', data);
    });

    this.socket.on('stock:updated', (data: { variantId: string; newStock: number }) => {
      logger.debug(`Stock updated: ${data.variantId} → ${data.newStock}`);
      this.emit('stock:updated', data);
    });

    // ==========================================
    // Elavon Payment Terminal Events
    // ==========================================

    this.socket.on('elavon:payment-response', (data: { orderId: string; success: boolean; transactionId?: string; error?: string }) => {
      logger.info(`Elavon payment response: ${data.orderId} → ${data.success ? 'SUCCESS' : 'FAILED'}`);
      this.emit('elavon:payment-response', data);
    });

    this.socket.on('elavon:payment-status-update', (data: { orderId: string; status: string }) => {
      logger.debug(`Elavon status update: ${data.orderId} → ${data.status}`);
      this.emit('elavon:payment-status-update', data);
    });

    // ==========================================
    // Billiard Events
    // ==========================================

    this.socket.on('billiard:session-updated', (data: any) => {
      logger.debug(`Billiard session updated: ${data?.sessionId || 'unknown'}`);
      this.emit('billiard:session-updated', data);
    });

    this.socket.on('billiard:resource-updated', (data: any) => {
      logger.debug(`Billiard resource updated: ${data?.resourceId || 'unknown'}`);
      this.emit('billiard:resource-updated', data);
    });

    // ==========================================
    // Path B: Sync Log real-time events
    // ==========================================

    this.socket.on('sync:entry', (data: any) => {
      logger.debug(`Sync entry received: seq=${data?.seq} type=${data?.entity_type}`);
      this.emit('sync:entry', data);
    });

    // Error handling
    this.socket.on('error', (error) => {
      logger.error(`Socket error: ${error.message || error}`);
      this.emit('error', error);
    });
  }

  /**
   * Connect to the /print-agent-remote namespace for remote control signaling
   */
  private connectRemoteSocket(serverUrl: string, apiKey: string, machineId?: string): void {
    if (this.remoteSocket?.connected) {
      logger.warn('Remote socket already connected');
      return;
    }

    logger.info(`Connecting to ${serverUrl}/print-agent-remote...`);

    this.remoteSocket = io(`${serverUrl}/print-agent-remote`, {
      auth: {
        apiKey,
        ...(machineId && { machineId }),
      },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: this.maxReconnectAttempts,
      reconnectionDelay: this.reconnectDelay,
    });

    // Defensive: remove any existing listeners before adding new ones
    this.remoteSocket.removeAllListeners();

    this.remoteSocket.on('connect', () => {
      logger.info('Remote socket connected to /print-agent-remote');
    });

    this.remoteSocket.on('disconnect', (reason) => {
      logger.info(`Remote socket disconnected: ${reason}`);
    });

    this.remoteSocket.on('connect_error', (error) => {
      logger.error(`Remote socket connection error: ${error.message}`);
    });

    // Remote Control Events (signaled through /print-agent-remote namespace)
    this.remoteSocket.on('remote:session-request', (request: RemoteSessionRequest) => {
      logger.info(`Remote session request received from user: ${request.userId}`);
      this.emit('remote:session-request', request);
    });

    this.remoteSocket.on('remote:offer', (data: { sessionId: string; offer: RTCSessionDescriptionInit }) => {
      logger.debug('Remote WebRTC offer received');
      this.emit('remote:offer', data);
    });

    this.remoteSocket.on('remote:ice-candidate', (data: { sessionId: string; candidate: RTCIceCandidateInit }) => {
      logger.debug('Remote ICE candidate received');
      this.emit('remote:ice-candidate', data);
    });

    this.remoteSocket.on('remote:session-end', (data: { sessionId: string; reason?: string }) => {
      logger.info(`Remote session ended: ${data.reason || 'no reason'}`);
      this.emit('remote:session-end', data);
    });

    this.remoteSocket.on('error', (error) => {
      logger.error(`Remote socket error: ${error.message || error}`);
    });
  }

  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Send heartbeat every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      if (this.socket?.connected) {
        this.socket.emit('heartbeat', {}, (response: any) => {
          if (response?.success) {
            logger.debug('Heartbeat OK');
          }
        });
      }
    }, 30000);
  }
}
