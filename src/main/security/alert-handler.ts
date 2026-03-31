/**
 * AlertHandler — processes security alerts:
 * - Save evidence (snapshot + clip)
 * - Send Telegram notification
 * - Forward to renderer
 */

import { existsSync } from 'fs';
import logger from '../logger';
import { EvidenceStore } from './evidence-store';
import type { ServiceContainer } from '../core/container';
import type { SecurityAlert, SecurityConfig } from '../../shared/types';
import { SERVICE_TOKENS } from '../core/tokens';

export class AlertHandler {
  constructor(
    private evidenceStore: EvidenceStore,
    private container: ServiceContainer,
    private config: SecurityConfig,
  ) {}

  async handleAlert(alert: SecurityAlert): Promise<void> {
    try {
      // 1. Store in memory
      this.evidenceStore.addAlert(alert);

      // 2. Save snapshot path
      if (this.config.snapshotOnAlert) {
        await this.evidenceStore.saveSnapshot(alert);
      }

      // 3. Save clip path
      if (this.config.clipOnAlert) {
        await this.evidenceStore.saveClip(alert);
      }

      // 4. Send Telegram notification
      if (this.config.telegramAlertEnabled && this.config.telegramChatId) {
        await this.sendTelegramAlert(alert);
      }

      logger.info(
        `[AlertHandler] ${alert.severity.toUpperCase()} alert: ${alert.algorithm} on ${alert.cameraName} - ${alert.message}`,
      );
    } catch (err) {
      logger.error('[AlertHandler] Failed to process alert:', err);
    }
  }

  private async sendTelegramAlert(alert: SecurityAlert): Promise<void> {
    try {
      const bot = this.container.getOptional<any>(SERVICE_TOKENS.TELEGRAM_BOT);
      if (!bot) return;

      const severityIcon =
        alert.severity === 'critical' ? '🔴' :
        alert.severity === 'high' ? '🟠' :
        alert.severity === 'medium' ? '🟡' : '🟢';

      const caption = [
        `${severityIcon} Security Alert`,
        `Camera: ${alert.cameraName}`,
        `Algorithm: ${alert.algorithm}`,
        `Message: ${alert.message}`,
        `Time: ${new Date(alert.timestamp).toLocaleString()}`,
      ].join('\n');

      // Send photo if snapshot exists on disk, otherwise text
      if (alert.snapshotPath && existsSync(alert.snapshotPath)) {
        try {
          await bot.sendPhoto(this.config.telegramChatId, alert.snapshotPath, {
            caption,
          });
          return;
        } catch {
          // Fall through to text message
        }
      }

      await bot.sendMessage(this.config.telegramChatId, caption);
    } catch (err) {
      logger.error('[AlertHandler] Telegram send failed:', err);
    }
  }

  updateConfig(config: SecurityConfig): void {
    this.config = config;
  }
}
