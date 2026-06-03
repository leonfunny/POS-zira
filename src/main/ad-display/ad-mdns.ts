import { Bonjour, type Service } from 'bonjour-service';
import logger from '../logger';

export class AdMdnsAdvertiser {
  private bonjour: Bonjour | null = null;
  private service: Service | null = null;

  start(port: number, name: string): void {
    this.stop();
    try {
      this.bonjour = new Bonjour();
      this.service = this.bonjour.publish({
        name: `Zira Ads – ${name}`.slice(0, 60),
        type: 'zira-ads',
        protocol: 'tcp',
        port,
        txt: { name },
      });
      logger.info(`[AdDisplay] mDNS advertising _zira-ads._tcp on ${port}`);
    } catch (e: any) {
      logger.error('[AdDisplay] mDNS publish failed:', e?.message || e);
      this.stop();
    }
  }

  isRunning(): boolean {
    return !!this.service;
  }

  stop(): void {
    try { this.service?.stop?.(); } catch { /* ignore */ }
    try { this.bonjour?.destroy(); } catch { /* ignore */ }
    this.service = null;
    this.bonjour = null;
  }
}
