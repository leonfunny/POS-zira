/**
 * RemoteModule
 *
 * Owns RemoteSessionManager (WebRTC) and SshTunnelManager.
 * Handles remote control sessions and SSH tunnel for support.
 */

import { ipcMain } from 'electron';
import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import type { EventBus } from '../core/event-bus';
import type { ToolDefinition } from '../core/tool-registry';
import { SERVICE_TOKENS } from '../core/tokens';
import { RemoteSessionManager } from '../remote/remote-session-manager';
import { SshTunnelManager } from '../remote/ssh-tunnel';
import {
  IPC_CHANNELS,
  RemoteSessionRequest,
  RemoteControlState,
  RTCSessionDescriptionInit,
  RTCIceCandidateInit,
  SshTunnelRequest,
  SshTunnelStatus,
} from '../../shared/types';
import SocketClient from '../network/socket-client';
import { getConfigValue } from '../config/store';
import logger from '../logger';

export class RemoteModule extends BaseModule {
  readonly name = 'remote';

  private remoteSessionManager: RemoteSessionManager | null = null;
  private sshTunnelManager: SshTunnelManager | null = null;

  constructor(private container: ServiceContainer) {
    super();
  }

  async init(): Promise<void> {
    logger.info('[RemoteModule] Initializing...');

    this.remoteSessionManager = new RemoteSessionManager();
    await this.remoteSessionManager.initialize();
    this.container.set(SERVICE_TOKENS.REMOTE_SESSION_MANAGER, this.remoteSessionManager);

    this.sshTunnelManager = new SshTunnelManager();
    await this.sshTunnelManager.initialize();
    this.container.set(SERVICE_TOKENS.SSH_TUNNEL_MANAGER, this.sshTunnelManager);

    this.setState(ModuleState.READY);
    logger.info('[RemoteModule] Initialized');
  }

  registerIpcHandlers(): void {
    // Remote control
    ipcMain.handle(IPC_CHANNELS.REMOTE_GET_STATE, () => {
      return this.remoteSessionManager?.getState() || { isBeingControlled: false, session: null };
    });

    ipcMain.handle(IPC_CHANNELS.REMOTE_ACCEPT_SESSION, async () => {
      await this.remoteSessionManager?.acceptSession();
      return { success: true };
    });

    ipcMain.handle(IPC_CHANNELS.REMOTE_REJECT_SESSION, async (_, reason?: string) => {
      this.remoteSessionManager?.rejectSession(reason || 'User rejected');
      return { success: true };
    });

    ipcMain.handle(IPC_CHANNELS.REMOTE_END_SESSION, async () => {
      this.remoteSessionManager?.endSession('User ended session');
      return { success: true };
    });

    // SSH tunnel
    ipcMain.handle(IPC_CHANNELS.SSH_TUNNEL_GET_STATUS, () => {
      return this.sshTunnelManager?.getStatus() || { state: 'disconnected' };
    });

    ipcMain.handle(IPC_CHANNELS.SSH_TUNNEL_DISCONNECT, async () => {
      await this.sshTunnelManager?.disconnect();
      return { success: true };
    });

    ipcMain.handle(IPC_CHANNELS.SSH_TUNNEL_GENERATE_KEY, async () => {
      try {
        const keyPair = await this.sshTunnelManager?.generateKeyPair();
        return { success: true, data: keyPair };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle(IPC_CHANNELS.SSH_TUNNEL_START, async () => {
      try {
        const port = 10001 + Math.floor(Math.random() * 999);
        const result = await this.sshTunnelManager?.autoStart(port);
        if (result) {
          const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
          socket?.sendSshTunnelRegistered({ port: result.port, username: result.username, publicKey: result.publicKey });
          return { success: true, data: result };
        }
        return { success: false, error: 'Auto-start failed' };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

    logger.info('[RemoteModule] IPC handlers registered');
  }

  registerEventHandlers(bus: EventBus): void {
    // Auto-start SSH tunnel on socket connect
    bus.on('socket:connected', () => {
      if (getConfigValue('sshTunnelEnabled')) {
        this.autoStartSshTunnel();
      }
    });
  }

  /**
   * Wire up socket events for remote control.
   * Called after socket is available.
   */
  setupSocketHandlers(socket: SocketClient): void {
    const mainWindow = this.container.getOptional<Electron.BrowserWindow>(SERVICE_TOKENS.MAIN_WINDOW);

    // Remote session requests
    socket.on('remote:session-request', async (request: RemoteSessionRequest) => {
      try { await this.remoteSessionManager?.handleSessionRequest(request); } catch (e) { logger.error('[Remote] Error:', e); }
    });

    socket.on('remote:offer', async (data: { sessionId: string; offer: RTCSessionDescriptionInit }) => {
      try {
        const answer = await this.remoteSessionManager?.handleOffer(data.offer);
        if (answer) socket.sendRemoteAnswer(data.sessionId, answer);
      } catch (e) { logger.error('[Remote] Offer error:', e); }
    });

    socket.on('remote:ice-candidate', async (data: { sessionId: string; candidate: RTCIceCandidateInit }) => {
      try { await this.remoteSessionManager?.handleIceCandidate(data.candidate); } catch (e) { logger.error('[Remote] ICE error:', e); }
    });

    socket.on('remote:session-end', (data: { sessionId: string; reason?: string }) => {
      this.remoteSessionManager?.endSession(data.reason);
    });

    // SSH tunnel requests
    socket.on('ssh-tunnel:request', async (request: SshTunnelRequest) => {
      try {
        if (!this.sshTunnelManager) {
          socket.sendSshTunnelResponse({ requestId: request.requestId, accepted: false, reason: 'SSH tunnel manager not initialized' });
          return;
        }
        const response = await this.sshTunnelManager.handleTunnelRequest(request, mainWindow || undefined);
        socket.sendSshTunnelResponse(response);
      } catch (e: any) {
        socket.sendSshTunnelResponse({ requestId: request.requestId, accepted: false, reason: `Error: ${e.message}` });
      }
    });

    // Manager events
    if (this.remoteSessionManager) {
      this.remoteSessionManager.on('sessionRequest', async (request: RemoteSessionRequest) => {
        try {
          const unattendedEnabled = getConfigValue('remoteAccessEnabled');

          if (unattendedEnabled) {
            const configPin = getConfigValue('remoteAccessPin');

            if (!configPin) {
              // No PIN set → auto-accept (trust backend auth)
              logger.info('[Remote] Unattended: auto-accept (no PIN)');
              await this.remoteSessionManager?.acceptSession();
              return;
            }

            if (request.passcode && request.passcode === configPin) {
              // Correct PIN → auto-accept
              logger.info('[Remote] Unattended: PIN verified, auto-accept');
              await this.remoteSessionManager?.acceptSession();
              return;
            }

            // Wrong/missing PIN → fallback to dialog
            logger.info('[Remote] Unattended: wrong PIN, showing dialog');
          }

          // Attended mode (default): show native dialog
          const accepted = await this.remoteSessionManager?.showSessionRequestDialog(request, mainWindow || undefined);
          if (accepted) await this.remoteSessionManager?.acceptSession();
          else this.remoteSessionManager?.rejectSession('User declined');
        } catch { this.remoteSessionManager?.rejectSession('Error processing request'); }
      });

      this.remoteSessionManager.on('sessionResponse', (response) => socket.sendRemoteSessionResponse(response));

      this.remoteSessionManager.on('iceCandidate', (candidate: RTCIceCandidateInit) => {
        const session = this.remoteSessionManager?.getState().session;
        if (session) socket.sendRemoteIceCandidate(session.sessionId, candidate);
      });

      this.remoteSessionManager.on('stateChanged', (state: RemoteControlState) => {
        mainWindow?.webContents.send(IPC_CHANNELS.REMOTE_STATE_CHANGED, state);
      });

      this.remoteSessionManager.on('sessionEnded', (session) => {
        socket.sendRemoteSessionEnd(session.sessionId);
      });
    }

    // SSH tunnel status
    if (this.sshTunnelManager) {
      this.sshTunnelManager.on('statusChanged', (status: SshTunnelStatus) => {
        mainWindow?.webContents.send(IPC_CHANNELS.SSH_TUNNEL_STATUS_CHANGED, status);
      });
    }
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        definition: {
          type: 'function',
          function: {
            name: 'request_remote_access',
            description: 'Get remote control session status',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
        module: this.name,
        category: 'remote',
        execute: async () => {
          const state = this.remoteSessionManager?.getState();
          return state?.isBeingControlled ? `🟢 Remote session active: ${state.session?.sessionId}` : '🔴 No active remote session';
        },
      },
    ];
  }

  private async autoStartSshTunnel(): Promise<void> {
    if (!this.sshTunnelManager) return;
    const status = this.sshTunnelManager.getStatus();
    if (status.state === 'connected' || status.state === 'connecting') return;

    const port = 10001 + Math.floor(Math.random() * 999);
    const result = await this.sshTunnelManager.autoStart(port);
    if (result) {
      const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
      socket?.sendSshTunnelRegistered({ port: result.port, username: result.username, publicKey: result.publicKey });
    }
  }

  async start(): Promise<void> { this.setState(ModuleState.RUNNING); }

  async stop(): Promise<void> {
    this.remoteSessionManager?.endSession('App shutting down');
    await this.sshTunnelManager?.disconnect();
    this.setState(ModuleState.STOPPED);
  }

  async destroy(): Promise<void> { this.setState(ModuleState.STOPPED); }
}
