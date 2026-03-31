/**
 * EvidenceStore — manages evidence files (snapshots, clips, analytics).
 *
 * Directory structure:
 *   security/YYYY-MM-DD/{cameraName}/alert-{algo}-{trackId}-{ts}.jpg
 *   security/YYYY-MM-DD/{cameraName}/clip-{algo}-{trackId}-{ts}.mp4
 *   security/analytics/YYYY-MM-DD/{cameraId}.json
 */

import { app } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmdirSync, readFileSync, writeFileSync } from 'fs';
import logger from '../logger';
import type { SecurityAlert, SecurityAnalytics } from '../../shared/types';

export class EvidenceStore {
  private basePath: string;
  private alertsInMemory: SecurityAlert[] = [];
  private maxInMemory = 500;

  constructor(customPath?: string) {
    this.basePath = customPath || join(app.getPath('userData'), 'security');
    if (!existsSync(this.basePath)) {
      mkdirSync(this.basePath, { recursive: true });
    }
  }

  private getDateDir(date?: Date): string {
    const d = date || new Date();
    const dateStr = d.toISOString().split('T')[0];
    const dir = join(this.basePath, dateStr);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  private getCameraDir(cameraName: string, date?: Date): string {
    const dateDir = this.getDateDir(date);
    const safe = cameraName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = join(dateDir, safe);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  async saveSnapshot(alert: SecurityAlert): Promise<string> {
    const dir = this.getCameraDir(alert.cameraName);
    const filename = `alert-${alert.algorithm}-${alert.trackId || 0}-${alert.timestamp}.jpg`;
    const filePath = join(dir, filename);

    // The Python engine saves the actual file — we just track the path
    alert.snapshotPath = filePath;
    return filePath;
  }

  async saveClip(alert: SecurityAlert): Promise<string> {
    const dir = this.getCameraDir(alert.cameraName);
    const filename = `clip-${alert.algorithm}-${alert.trackId || 0}-${alert.timestamp}.mp4`;
    const filePath = join(dir, filename);
    alert.clipPath = filePath;
    return filePath;
  }

  async saveAnalytics(data: SecurityAnalytics): Promise<void> {
    const analyticsDir = join(this.basePath, 'analytics', data.date);
    if (!existsSync(analyticsDir)) {
      mkdirSync(analyticsDir, { recursive: true });
    }
    const filePath = join(analyticsDir, `${data.cameraId}.json`);
    try {
      writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      logger.error('[EvidenceStore] Failed to save analytics:', err);
    }
  }

  addAlert(alert: SecurityAlert): void {
    this.alertsInMemory.unshift(alert);
    if (this.alertsInMemory.length > this.maxInMemory) {
      this.alertsInMemory.length = this.maxInMemory;
    }
  }

  getAlerts(limit = 50, cameraId?: string): SecurityAlert[] {
    let alerts = this.alertsInMemory;
    if (cameraId) {
      alerts = alerts.filter(a => a.cameraId === cameraId);
    }
    return alerts.slice(0, limit);
  }

  clearAlerts(): void {
    this.alertsInMemory = [];
  }

  async getAnalytics(cameraId: string, date: string): Promise<SecurityAnalytics | null> {
    // Sanitize inputs to prevent path traversal
    const safeDate = date.replace(/[^0-9-]/g, '');
    const safeCameraId = cameraId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = join(this.basePath, 'analytics', safeDate, `${safeCameraId}.json`);

    // Ensure resolved path stays within basePath
    if (!filePath.startsWith(this.basePath)) return null;

    if (!existsSync(filePath)) return null;
    try {
      const raw = readFileSync(filePath, 'utf8');
      return JSON.parse(raw) as SecurityAnalytics;
    } catch {
      return null;
    }
  }

  async cleanup(retentionDays: number): Promise<void> {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let deletedFiles = 0;

    try {
      const entries = readdirSync(this.basePath);
      for (const entry of entries) {
        if (entry === 'analytics') continue;
        const entryPath = join(this.basePath, entry);
        let stat;
        try {
          stat = statSync(entryPath);
        } catch {
          continue; // File may have been deleted concurrently
        }
        if (stat.isDirectory()) {
          // Parse date from directory name (YYYY-MM-DD)
          const match = entry.match(/^(\d{4}-\d{2}-\d{2})$/);
          if (match) {
            const dirDate = new Date(match[1]).getTime();
            if (dirDate < cutoff) {
              deletedFiles += this.removeDir(entryPath);
            }
          }
        }
      }

      // Clean analytics too
      const analyticsDir = join(this.basePath, 'analytics');
      if (existsSync(analyticsDir)) {
        const analyticsDirs = readdirSync(analyticsDir);
        for (const entry of analyticsDirs) {
          const match = entry.match(/^(\d{4}-\d{2}-\d{2})$/);
          if (match) {
            const dirDate = new Date(match[1]).getTime();
            if (dirDate < cutoff) {
              deletedFiles += this.removeDir(join(analyticsDir, entry));
            }
          }
        }
      }

      if (deletedFiles > 0) {
        logger.info(`[EvidenceStore] Cleaned up ${deletedFiles} old evidence files`);
      }
    } catch (err) {
      logger.error('[EvidenceStore] Cleanup error:', err);
    }
  }

  private removeDir(dirPath: string): number {
    let count = 0;
    try {
      const entries = readdirSync(dirPath);
      for (const entry of entries) {
        const fullPath = join(dirPath, entry);
        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue; // File may have been deleted concurrently
        }
        if (stat.isDirectory()) {
          count += this.removeDir(fullPath);
        } else {
          try {
            unlinkSync(fullPath);
            count++;
          } catch {
            // Ignore — file may already be deleted
          }
        }
      }
      try {
        rmdirSync(dirPath);
      } catch {
        // Ignore — directory may not be empty or already deleted
      }
    } catch (err) {
      logger.error(`[EvidenceStore] Failed to remove ${dirPath}:`, err);
    }
    return count;
  }
}
