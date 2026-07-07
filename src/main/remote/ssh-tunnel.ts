/**
 * SSH Tunnel Manager - Creates reverse SSH tunnels for remote support
 *
 * Two flows:
 * A) Auto-start (sshTunnelEnabled=true):
 *    1. User ticks "Allow remote support" at login
 *    2. On socket connect: auto-start sshd, generate key, create reverse tunnel
 *    3. Backend receives port + username via 'ssh-tunnel:registered'
 *
 * B) On-demand (sshTunnelEnabled=false):
 *    1. SuperAdmin requests SSH access via Socket.IO
 *    2. Print Agent shows consent dialog (like TeamViewer)
 *    3. If accepted: generates SSH key (if needed), starts reverse tunnel
 *    4. SuperAdmin can SSH through the backend server to reach this machine
 */

import { EventEmitter } from 'events';
import { BrowserWindow, dialog } from 'electron';
import { spawn, execFile, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { app } from 'electron';
import logger from '../logger';
import {
  SshTunnelState,
  SshTunnelRequest,
  SshTunnelResponse,
  SshTunnelStatus,
} from '../../shared/types';
import { getConfigValue } from '../config/store';

// Server connection details
const SSH_SERVER_HOST = '37.60.231.45';
const SSH_SERVER_PORT = 2222;
const SSH_SERVER_USER = 'paul';

// Reconnect settings
const MIN_RECONNECT_DELAY = 5000;
const MAX_RECONNECT_DELAY = 60000;

function execFileText(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout || '');
    });
  });
}

export interface SshTunnelManagerEvents {
  statusChanged: (status: SshTunnelStatus) => void;
}

export class SshTunnelManager extends EventEmitter {
  private state: SshTunnelState = 'disconnected';
  private sshProcess: ChildProcess | null = null;
  private sshExePath: string | null = null;
  private sshServerAvailable = false;
  private keyDir: string;
  private keyPath: string;
  private pubKeyPath: string;
  private assignedPort: number | null = null;
  private lastError: string | null = null;
  private retryCount = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectedSince: string | null = null;
  private requestedBy: string | null = null;
  private currentRequestId: string | null = null;
  private autoReconnect = true;
  private username: string | null = null;
  private capabilitiesHydrated = false;
  private capabilitiesProbePromise: Promise<void> | null = null;

  constructor() {
    super();
    const userDataDir = app.getPath('userData');
    this.keyDir = path.join(userDataDir, 'ssh');
    this.keyPath = path.join(this.keyDir, 'id_ed25519');
    this.pubKeyPath = path.join(this.keyDir, 'id_ed25519.pub');
  }

  /**
   * Initialize without probing the OS. SSH capability checks are lazy because
   * Windows service/where probes can be slow on cold boot.
   */
  async initialize(): Promise<void> {
    logger.info('[SSH Tunnel] Initializing...');

    logger.info(`[SSH Tunnel] Key exists: ${this.isKeyGenerated()}`);
    logger.info('[SSH Tunnel] Initialization complete');
  }

  private async hydrateCapabilities(): Promise<void> {
    if (this.capabilitiesHydrated) return;
    if (this.capabilitiesProbePromise) return this.capabilitiesProbePromise;

    this.capabilitiesProbePromise = (async () => {
      logger.info('[SSH Tunnel] Probing SSH capabilities...');
      const [sshExePath, sshServerAvailable] = await Promise.all([
        this.findSshExe(),
        this.checkSshServer(),
      ]);

      this.sshExePath = sshExePath;
      this.sshServerAvailable = sshServerAvailable;
      this.capabilitiesHydrated = true;

      if (this.sshExePath) {
        logger.info(`[SSH Tunnel] SSH client found: ${this.sshExePath}`);
      } else {
        logger.warn('[SSH Tunnel] SSH client NOT found (OpenSSH not installed)');
      }
      logger.info(`[SSH Tunnel] OpenSSH Server (sshd) ${this.sshServerAvailable ? 'is available' : 'not detected'}`);
      this.emit('statusChanged', this.getStatus({ refreshCapabilities: false }));
    })();

    try {
      await this.capabilitiesProbePromise;
    } finally {
      this.capabilitiesProbePromise = null;
    }
  }

  /**
   * Find ssh.exe on the system
   */
  private async findSshExe(): Promise<string | null> {
    // Windows standard path
    const winSshPath = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
    if (fs.existsSync(winSshPath)) {
      return winSshPath;
    }

    return this.findExecutable('ssh');
  }

  /**
   * Check if OpenSSH Server (sshd) is available on this machine
   */
  private async checkSshServer(): Promise<boolean> {
    if (process.platform === 'win32') {
      try {
        const result = await execFileText('sc', ['query', 'sshd'], 5000);
        return result.includes('SERVICE_NAME: sshd');
      } catch {
        return false;
      }
    }

    // Linux/macOS - check if sshd is running or available
    try {
      await execFileText('which', ['sshd'], 5000);
      return true;
    } catch {
      return false;
    }
  }

  private async findExecutable(name: string, windowsKnownPath?: string): Promise<string | null> {
    if (windowsKnownPath && fs.existsSync(windowsKnownPath)) {
      return windowsKnownPath;
    }

    try {
      const result = await execFileText(process.platform === 'win32' ? 'where' : 'which', [name], 5000);
      return result.trim().split(/\r?\n/)[0]?.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Check if SSH key pair has been generated
   */
  isKeyGenerated(): boolean {
    return fs.existsSync(this.keyPath) && fs.existsSync(this.pubKeyPath);
  }

  /**
   * Get public key contents
   */
  getPublicKey(): string | null {
    if (!this.isKeyGenerated()) return null;
    try {
      return fs.readFileSync(this.pubKeyPath, 'utf8').trim();
    } catch {
      return null;
    }
  }

  /**
   * Generate SSH key pair (ed25519)
   */
  async generateKeyPair(): Promise<{ success: boolean; publicKey?: string; error?: string }> {
    await this.hydrateCapabilities();
    if (!this.sshExePath) {
      return { success: false, error: 'SSH client not installed' };
    }

    // Ensure key directory exists
    if (!fs.existsSync(this.keyDir)) {
      fs.mkdirSync(this.keyDir, { recursive: true });
    }

    // Don't regenerate if key already exists
    if (this.isKeyGenerated()) {
      const pubKey = this.getPublicKey();
      logger.info('[SSH Tunnel] Key pair already exists, skipping generation');
      return { success: true, publicKey: pubKey || undefined };
    }

    // Find ssh-keygen
    const keygenPath = await this.findExecutable(
      'ssh-keygen',
      process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe' : undefined,
    );

    if (!keygenPath) {
      return { success: false, error: 'ssh-keygen not found' };
    }

    return new Promise((resolve) => {
      const args = [
        '-t', 'ed25519',
        '-f', this.keyPath,
        '-N', '',  // No passphrase
        '-C', `zira-print-agent@${os.hostname()}`,
      ];

      logger.info(`[SSH Tunnel] Generating key pair: ${keygenPath} ${args.join(' ')}`);

      const proc = spawn(keygenPath!, args, { stdio: 'pipe' });
      let stderr = '';

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0 && this.isKeyGenerated()) {
          const pubKey = this.getPublicKey();
          logger.info('[SSH Tunnel] Key pair generated successfully');
          resolve({ success: true, publicKey: pubKey || undefined });
        } else {
          logger.error(`[SSH Tunnel] Key generation failed (code ${code}): ${stderr}`);
          resolve({ success: false, error: `ssh-keygen failed: ${stderr}` });
        }
      });

      proc.on('error', (err) => {
        logger.error('[SSH Tunnel] ssh-keygen error:', err);
        resolve({ success: false, error: err.message });
      });
    });
  }

  /**
   * Setup SSH server (start sshd on Windows)
   * Non-fatal: logs warnings if it fails (no admin rights, etc.)
   */
  async setupSshServer(): Promise<void> {
    if (process.platform !== 'win32') {
      logger.info('[SSH Tunnel] Non-Windows OS, skipping sshd setup');
      return;
    }

    try {
      // Check if sshd service exists
      const queryResult = await execFileText('sc', ['query', 'sshd'], 5000);

      if (queryResult.includes('RUNNING')) {
        logger.info('[SSH Tunnel] sshd already running');
        this.sshServerAvailable = true;
        return;
      }

      // Try to start sshd
      logger.info('[SSH Tunnel] Starting sshd service...');
      await execFileText('powershell', ['-NoProfile', '-Command', 'Start-Service sshd'], 15000);
      logger.info('[SSH Tunnel] sshd started successfully');

      // Set auto-start
      try {
        await execFileText('powershell', ['-NoProfile', '-Command', 'Set-Service sshd -StartupType Automatic'], 10000);
        logger.info('[SSH Tunnel] sshd set to auto-start');
      } catch (e) {
        logger.warn('[SSH Tunnel] Failed to set sshd auto-start (may need admin rights)');
      }

      this.sshServerAvailable = true;
    } catch (error: any) {
      logger.warn(`[SSH Tunnel] Failed to setup sshd: ${error.message} (may need admin rights or OpenSSH Server not installed)`);
    }
  }

  /**
   * Setup authorized_keys for admin SSH access
   * Adds the admin public key so they can SSH in without password
   */
  async setupAuthorizedKeys(adminPubKey: string): Promise<void> {
    if (!adminPubKey) return;

    try {
      const homeDir = os.homedir();
      const sshDir = path.join(homeDir, '.ssh');
      const authorizedKeysPath = path.join(sshDir, 'authorized_keys');

      // Create .ssh directory if needed
      if (!fs.existsSync(sshDir)) {
        fs.mkdirSync(sshDir, { recursive: true });
        logger.info(`[SSH Tunnel] Created ${sshDir}`);
      }

      // Read existing authorized_keys
      let existingKeys = '';
      if (fs.existsSync(authorizedKeysPath)) {
        existingKeys = fs.readFileSync(authorizedKeysPath, 'utf8');
      }

      // Check if key already present
      const keyFingerprint = adminPubKey.trim().split(' ').slice(0, 2).join(' ');
      if (existingKeys.includes(keyFingerprint)) {
        logger.info('[SSH Tunnel] Admin key already in authorized_keys');
        return;
      }

      // Append key
      const keyLine = adminPubKey.trim() + '\n';
      fs.appendFileSync(authorizedKeysPath, keyLine, 'utf8');
      logger.info('[SSH Tunnel] Admin key added to authorized_keys');

      // Fix Windows permissions (required for OpenSSH server)
      if (process.platform === 'win32') {
        try {
          const username = os.userInfo().username;
          await execFileText('icacls', [
            authorizedKeysPath,
            '/inheritance:r',
            '/grant',
            `${username}:F`,
            '/grant',
            'SYSTEM:F',
          ], 10000);
          logger.info('[SSH Tunnel] Fixed authorized_keys permissions');
        } catch (e) {
          logger.warn('[SSH Tunnel] Failed to fix authorized_keys permissions (may need admin rights)');
        }
      }
    } catch (error: any) {
      logger.warn(`[SSH Tunnel] Failed to setup authorized_keys: ${error.message}`);
    }
  }

  /**
   * Auto-start tunnel without user dialog
   * Called when sshTunnelEnabled=true and app connects to backend
   */
  async autoStart(port: number, adminPubKey?: string): Promise<{ port: number; username: string; publicKey?: string } | null> {
    logger.info(`[SSH Tunnel] Auto-starting tunnel on port ${port}...`);

    await this.hydrateCapabilities();

    // Try to setup sshd (non-fatal)
    await this.setupSshServer();

    // Setup admin key if provided
    if (adminPubKey) {
      await this.setupAuthorizedKeys(adminPubKey);
    }

    // Generate key pair if needed
    if (!this.isKeyGenerated()) {
      const keyResult = await this.generateKeyPair();
      if (!keyResult.success) {
        logger.error(`[SSH Tunnel] Auto-start failed: key generation error: ${keyResult.error}`);
        return null;
      }
    }

    // Set tunnel params
    this.assignedPort = port;
    this.autoReconnect = true;
    this.requestedBy = 'auto';
    this.username = os.userInfo().username;

    // Connect
    const connected = await this.connect();

    if (connected) {
      return {
        port: this.assignedPort,
        username: this.username,
        publicKey: this.getPublicKey() || undefined,
      };
    }

    logger.error(`[SSH Tunnel] Auto-start failed: ${this.lastError}`);
    return null;
  }

  /**
   * Show consent dialog to user (like TeamViewer)
   */
  async showConsentDialog(
    request: SshTunnelRequest,
    parentWindow?: BrowserWindow
  ): Promise<boolean> {
    const detail = [
      `${request.userName} wants SSH access to this computer.`,
      request.reason ? `\nReason: ${request.reason}` : '',
      '\nDo you want to allow this?',
    ].join('');

    const win = parentWindow || BrowserWindow.getFocusedWindow();

    const options: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: ['Allow', 'Deny'],
      defaultId: 1,      // Default = Deny (safe)
      cancelId: 1,
      title: 'SSH Access Request',
      message: 'SSH Access Request',
      detail,
    };

    const result = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);

    return result.response === 0; // 0 = Allow
  }

  /**
   * Handle incoming tunnel request from backend
   * Shows consent dialog, generates key if needed, starts tunnel
   */
  async handleTunnelRequest(
    request: SshTunnelRequest,
    parentWindow?: BrowserWindow
  ): Promise<SshTunnelResponse> {
    logger.info(`[SSH Tunnel] Request from ${request.userName} (${request.userId})`);

    await this.hydrateCapabilities();

    // Check prerequisites
    if (!this.sshExePath) {
      logger.warn('[SSH Tunnel] Rejecting: SSH client not available');
      return {
        requestId: request.requestId,
        accepted: false,
        reason: 'SSH client not installed on this machine',
      };
    }

    if (!this.sshServerAvailable) {
      logger.warn('[SSH Tunnel] Rejecting: SSH server not available');
      return {
        requestId: request.requestId,
        accepted: false,
        reason: 'OpenSSH Server not installed on this machine',
      };
    }

    // Already connected from a previous request
    if (this.state === 'connected' || this.state === 'connecting') {
      logger.info('[SSH Tunnel] Already connected/connecting, returning current port');
      return {
        requestId: request.requestId,
        accepted: true,
        port: this.assignedPort || undefined,
        publicKey: this.getPublicKey() || undefined,
      };
    }

    // If sshTunnelEnabled, auto-accept without dialog
    const sshTunnelEnabled = getConfigValue('sshTunnelEnabled');
    let accepted: boolean;

    if (sshTunnelEnabled) {
      logger.info('[SSH Tunnel] Auto-accepting request (sshTunnelEnabled=true)');
      accepted = true;
    } else {
      // Show consent dialog
      accepted = await this.showConsentDialog(request, parentWindow);
    }

    if (!accepted) {
      logger.info('[SSH Tunnel] User denied SSH access');
      return {
        requestId: request.requestId,
        accepted: false,
        reason: 'User denied access',
      };
    }

    // Generate key if needed
    if (!this.isKeyGenerated()) {
      logger.info('[SSH Tunnel] Generating SSH key pair...');
      const keyResult = await this.generateKeyPair();
      if (!keyResult.success) {
        return {
          requestId: request.requestId,
          accepted: false,
          reason: `Key generation failed: ${keyResult.error}`,
        };
      }
    }

    // Start tunnel
    this.currentRequestId = request.requestId;
    this.requestedBy = request.userName;
    this.username = os.userInfo().username;
    this.assignedPort = 10000 + Math.floor(Math.random() * 999) + 1; // 10001-10999
    this.autoReconnect = true;

    const connected = await this.connect();

    if (connected) {
      return {
        requestId: request.requestId,
        accepted: true,
        port: this.assignedPort,
        publicKey: this.getPublicKey() || undefined,
      };
    } else {
      return {
        requestId: request.requestId,
        accepted: false,
        reason: `Tunnel connection failed: ${this.lastError}`,
      };
    }
  }

  /**
   * Start the reverse SSH tunnel
   */
  async connect(): Promise<boolean> {
    if (!this.sshExePath || !this.assignedPort) {
      this.updateState('error');
      this.lastError = 'SSH not available or no port assigned';
      return false;
    }

    if (this.sshProcess) {
      // Kill existing process before reconnecting
      this.killSshProcess();
    }

    this.updateState('connecting');

    const args = [
      '-N',                                     // No remote command
      '-o', 'StrictHostKeyChecking=accept-new',  // Auto-accept new host keys
      '-o', 'ServerAliveInterval=30',            // Keep-alive every 30s
      '-o', 'ServerAliveCountMax=3',             // Disconnect after 3 missed
      '-o', 'ExitOnForwardFailure=yes',          // Fail if port forward fails
      '-o', 'ConnectTimeout=15',                 // Connection timeout
      '-i', this.keyPath,                        // Identity file
      '-R', `${this.assignedPort}:localhost:22`, // Reverse tunnel
      '-p', String(SSH_SERVER_PORT),             // Server SSH port
      `${SSH_SERVER_USER}@${SSH_SERVER_HOST}`,   // Destination
    ];

    logger.info(`[SSH Tunnel] Starting: ssh ${args.join(' ')}`);

    return new Promise((resolve) => {
      this.sshProcess = spawn(this.sshExePath!, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stderr = '';
      let resolved = false;

      // If the process stays alive for 3 seconds, consider it connected
      const connectTimeout = setTimeout(() => {
        if (!resolved && this.sshProcess && !this.sshProcess.killed) {
          resolved = true;
          this.retryCount = 0;
          this.connectedSince = new Date().toISOString();
          this.lastError = null;
          this.updateState('connected');
          logger.info(`[SSH Tunnel] Connected! Port ${this.assignedPort} → localhost:22`);
          resolve(true);
        }
      }, 3000);

      this.sshProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
        logger.debug(`[SSH Tunnel] stderr: ${data.toString().trim()}`);
      });

      this.sshProcess.on('close', (code, signal) => {
        clearTimeout(connectTimeout);
        logger.info(`[SSH Tunnel] Process exited (code=${code}, signal=${signal})`);

        this.sshProcess = null;

        if (!resolved) {
          resolved = true;
          this.lastError = stderr || `SSH exited with code ${code}`;
          this.updateState('error');
          resolve(false);
        } else {
          // Was connected, now disconnected unexpectedly
          this.connectedSince = null;

          if (this.autoReconnect && code !== 0) {
            this.scheduleReconnect();
          } else {
            this.updateState('disconnected');
          }
        }
      });

      this.sshProcess.on('error', (err) => {
        clearTimeout(connectTimeout);
        logger.error('[SSH Tunnel] Process error:', err);

        if (!resolved) {
          resolved = true;
          this.lastError = err.message;
          this.updateState('error');
          resolve(false);
        }
      });
    });
  }

  /**
   * Disconnect the tunnel
   */
  disconnect(): void {
    logger.info('[SSH Tunnel] Disconnecting...');
    this.autoReconnect = false;
    this.clearReconnectTimer();
    this.killSshProcess();
    this.connectedSince = null;
    this.requestedBy = null;
    this.currentRequestId = null;
    this.assignedPort = null;
    this.retryCount = 0;
    this.lastError = null;
    this.username = null;
    this.updateState('disconnected');
  }

  /**
   * Schedule a reconnect with exponential backoff
   */
  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.retryCount++;

    const delay = Math.min(
      MIN_RECONNECT_DELAY * Math.pow(2, this.retryCount - 1),
      MAX_RECONNECT_DELAY
    );

    logger.info(`[SSH Tunnel] Scheduling reconnect in ${delay}ms (attempt ${this.retryCount})`);
    this.updateState('reconnecting');

    this.reconnectTimer = setTimeout(async () => {
      if (!this.autoReconnect) return;

      logger.info(`[SSH Tunnel] Reconnecting (attempt ${this.retryCount})...`);
      const success = await this.connect();

      if (!success && this.autoReconnect) {
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Kill the SSH process
   */
  private killSshProcess(): void {
    if (this.sshProcess) {
      try {
        this.sshProcess.kill('SIGTERM');
        // Force kill after 2 seconds if still alive
        const proc = this.sshProcess;
        setTimeout(() => {
          try {
            if (proc && !proc.killed) {
              proc.kill('SIGKILL');
            }
          } catch {
            // Already dead
          }
        }, 2000);
      } catch {
        // Already dead
      }
      this.sshProcess = null;
    }
  }

  /**
   * Clear reconnect timer
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Update state and emit status
   */
  private updateState(newState: SshTunnelState): void {
    this.state = newState;
    this.emit('statusChanged', this.getStatus());
  }

  /**
   * Get current status
   */
  getStatus(options: { refreshCapabilities?: boolean } = {}): SshTunnelStatus {
    if (options.refreshCapabilities !== false) {
      void this.hydrateCapabilities().catch((err: any) => {
        logger.warn('[SSH Tunnel] Capability probe failed:', err?.message || err);
      });
    }

    return {
      state: this.state,
      sshAvailable: !!this.sshExePath,
      sshServerAvailable: this.sshServerAvailable,
      keyGenerated: this.isKeyGenerated(),
      publicKey: this.getPublicKey() || undefined,
      assignedPort: this.assignedPort || undefined,
      lastError: this.lastError || undefined,
      retryCount: this.retryCount || undefined,
      connectedSince: this.connectedSince || undefined,
      requestedBy: this.requestedBy || undefined,
      username: this.username || undefined,
    };
  }

  /**
   * Full cleanup
   */
  destroy(): void {
    logger.info('[SSH Tunnel] Destroying...');
    this.disconnect();
    this.removeAllListeners();
  }
}
