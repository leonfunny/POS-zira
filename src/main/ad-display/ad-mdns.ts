import Bonjour from 'bonjour-service';
import logger from '../logger';

// bonjour-service is an `export =` module: the default export is the Bonjour
// class (usable as both value and type). Derive the published-service type from
// publish()'s return type rather than importing the value-only `Service` name.
type PublishedService = ReturnType<Bonjour['publish']>;

export class AdMdnsAdvertiser {
  private bonjour: Bonjour | null = null;
  private service: PublishedService | null = null;

  start(port: number, name: string, ip?: string): void {
    this.stop();
    try {
      this.bonjour = new Bonjour();
      this.service = this.bonjour.publish({
        name: `Zira Ads – ${name}`.slice(0, 60),
        type: 'zira-ads',
        protocol: 'tcp',
        port,
        txt: ip ? { name, ip } : { name },
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
