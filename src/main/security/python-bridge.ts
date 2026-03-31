/**
 * PythonBridge — JSON-RPC stdio bridge to Python multi-process engine.
 *
 * Spawns the Python security engine and communicates via
 * newline-delimited JSON over stdin/stdout.
 */

import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { app } from 'electron';
import { join } from 'path';
import { existsSync } from 'fs';
import logger from '../logger';
import type { SecurityConfig, SecurityStatus, SecurityAnalytics, CameraConfig } from '../../shared/types';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: NodeJS.Timeout;
}

export class PythonBridge extends EventEmitter {
  private proc: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private watchdogTimer: NodeJS.Timeout | null = null;
  private lastHeartbeat = 0;
  private lineBuffer = '';

  private getPythonPath(): string {
    if (app.isPackaged) {
      // Bundled Python embedded package
      const resourcesPath = join(process.resourcesPath, 'python', 'python.exe');
      if (existsSync(resourcesPath)) return resourcesPath;
    }
    // Development: system Python
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  private getScriptPath(): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'python', 'security');
    }
    // Development: relative to project root
    return join(app.getAppPath(), 'python', 'security');
  }

  async start(config: SecurityConfig): Promise<void> {
    if (this.proc) {
      await this.stop();
    }

    // Clean up any leftover event listeners from previous runs
    this.removeAllListeners();

    const pythonPath = this.getPythonPath();
    const scriptPath = this.getScriptPath();

    logger.info(`[PythonBridge] Starting: ${pythonPath} -m security from ${scriptPath}`);

    this.proc = spawn(pythonPath, ['-m', 'security'], {
      cwd: join(scriptPath, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    this.proc.stdout?.on('data', (data: Buffer) => {
      this.lineBuffer += data.toString();
      const lines = this.lineBuffer.split('\n');
      this.lineBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) this.handleMessage(line.trim());
      }
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.info(`[PythonBridge:stderr] ${msg}`);
    });

    this.proc.on('exit', (code) => {
      logger.warn(`[PythonBridge] Process exited with code ${code}`);
      this.proc = null;
      this.rejectAllPending('Python process exited');
      this.emit('exit', code);
    });

    this.proc.on('error', (err) => {
      logger.error(`[PythonBridge] Process error:`, err);
      this.emit('error', { message: err.message, code: 'PROCESS_ERROR' });
    });

    // Send start command with camera configs
    const cameras = config.cameras
      .filter(c => c.enabled && c.aiEnabled)
      .map(c => ({
        id: c.id,
        name: c.name,
        zone: c.zone,
        rtspSubstream: c.rtspSubstream,
        rtspMainstream: c.rtspMainstream,
        aiFps: c.aiFps,
        algorithms: c.algorithms,
        confidenceThreshold: c.confidenceThreshold,
        zones: c.zones,
        loiterDwellSeconds: c.loiterDwellSeconds,
        loiterReturnWindow: c.loiterReturnWindow,
        loiterReturnCount: c.loiterReturnCount,
        firePersistSeconds: c.firePersistSeconds,
        theftDwellSeconds: c.theftDwellSeconds,
        enabled: c.enabled,
        aiEnabled: c.aiEnabled,
      }));

    await this.sendCommand('start', {
      cameras,
      model: config.modelSize || 'yolov8n',
      mjpeg_port: config.mjpegPort || 9090,
      cooldownSeconds: config.cooldownSeconds || 300,
      businessHoursStart: config.businessHoursStart,
      businessHoursEnd: config.businessHoursEnd,
      businessDays: config.businessDays,
    });

    this.startWatchdog();
  }

  async stop(): Promise<void> {
    this.stopWatchdog();

    if (this.proc) {
      try {
        await this.sendCommand('stop', {}, 5000);
      } catch {
        // Ignore timeout on stop
      }

      if (this.proc) {
        this.proc.kill('SIGTERM');
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => {
            if (this.proc) {
              this.proc.kill('SIGKILL');
            }
            resolve();
          }, 10000);
          if (this.proc) {
            this.proc.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
          } else {
            clearTimeout(timer);
            resolve();
          }
        });
        this.proc = null;
      }
    }

    this.rejectAllPending('Bridge stopped');
  }

  async updateCamera(cameraId: string, config: Partial<CameraConfig>): Promise<void> {
    await this.sendCommand('update_camera', { camera_id: cameraId, config });
  }

  async addCamera(config: CameraConfig): Promise<void> {
    await this.sendCommand('add_camera', { config });
  }

  async removeCamera(cameraId: string): Promise<void> {
    await this.sendCommand('remove_camera', { camera_id: cameraId });
  }

  async getStatus(): Promise<SecurityStatus> {
    const result = await this.sendCommand('get_status', {});
    return result as SecurityStatus;
  }

  async getAnalytics(cameraId: string, date: string): Promise<SecurityAnalytics | null> {
    const result = await this.sendCommand('get_analytics', { camera_id: cameraId, date });
    return result?.data || null;
  }

  async captureSnapshot(cameraId: string, path: string): Promise<string> {
    const result = await this.sendCommand('capture_snapshot', { camera_id: cameraId, path });
    return result?.path || path;
  }

  private sendCommand(method: string, params: any, timeout = 10000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin?.writable) {
        reject(new Error('Python process not running'));
        return;
      }

      const id = ++this.requestId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Command '${method}' timed out after ${timeout}ms`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });

      const msg = JSON.stringify({ id, method, params }) + '\n';
      try {
        this.proc.stdin.write(msg);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      logger.warn(`[PythonBridge] Invalid JSON: ${raw.substring(0, 200)}`);
      return;
    }

    // RPC response
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Event
    if (msg.event) {
      switch (msg.event) {
        case 'heartbeat':
          this.lastHeartbeat = Date.now();
          this.emit('heartbeat', msg.data);
          break;
        case 'alert':
          this.emit('alert', msg.data);
          break;
        case 'status':
          this.emit('status', msg.data);
          break;
        case 'analytics':
          this.emit('analytics', msg.data);
          break;
        case 'error':
          logger.error(`[PythonBridge] Engine error:`, msg.data);
          this.emit('error', msg.data);
          break;
        default:
          logger.warn(`[PythonBridge] Unknown event: ${msg.event}`);
      }
    }
  }

  private startWatchdog(): void {
    this.lastHeartbeat = Date.now();
    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastHeartbeat > 15000) {
        logger.warn('[PythonBridge] No heartbeat for 15s, restarting...');
        this.emit('error', { message: 'Watchdog timeout', code: 'WATCHDOG_TIMEOUT' });
        // The module will handle restart
      }
    }, 5000);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  get isRunning(): boolean {
    return this.proc !== null && !this.proc.killed;
  }
}
