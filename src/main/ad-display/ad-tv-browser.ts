import Bonjour from 'bonjour-service';
import logger from '../logger';

export interface TvDiscoveredDevice {
  name: string;
  ip: string;
  posHost: string;
  model: string;
  seenAt: number;
}

/**
 * Browses the LAN for Android TVs running the Zira TV Ads APK.
 * TVs advertise themselves as _zira-tv._tcp once they have successfully
 * connected to this POS's ad server. Call start() when the server starts
 * and stop() when it stops.
 */
export class AdTvBrowser {
  private bonjour: Bonjour | null = null;
  private browser: ReturnType<Bonjour['find']> | null = null;
  private readonly tvs = new Map<string, TvDiscoveredDevice>();

  start(): void {
    this.stop();
    try {
      this.bonjour = new Bonjour();
      this.browser = this.bonjour.find({ type: 'zira-tv', protocol: 'tcp' }, (svc) => {
        const txt = svc.txt as Record<string, string | Buffer> | undefined;
        const decode = (v: string | Buffer | undefined) =>
          v ? (Buffer.isBuffer(v) ? v.toString() : v) : '';
        const ip =
          decode(txt?.ip) ||
          svc.addresses?.[0] ||
          (svc as any).referer?.address ||
          svc.host ||
          '';
        if (!ip) return;
        const key = ip;
        this.tvs.set(key, {
          name: svc.name || ip,
          ip,
          posHost: decode(txt?.pos),
          model: decode(txt?.model),
          seenAt: Date.now(),
        });
        logger.info(`[AdDisplay] TV discovered: ${svc.name} @ ${ip}`);
      });
    } catch (e: any) {
      logger.error('[AdDisplay] TV browser start failed:', e?.message || e);
      this.stop();
    }
  }

  getDevices(): TvDiscoveredDevice[] {
    // Remove TVs not seen for 5 minutes (handles TVs that powered off without goodbye)
    const cutoff = Date.now() - 5 * 60_000;
    for (const [k, v] of this.tvs) {
      if (v.seenAt < cutoff) this.tvs.delete(k);
    }
    return [...this.tvs.values()].sort((a, b) => b.seenAt - a.seenAt);
  }

  stop(): void {
    try { (this.browser as any)?.stop?.(); } catch { /* ignore */ }
    try { this.bonjour?.destroy(); } catch { /* ignore */ }
    this.browser = null;
    this.bonjour = null;
    this.tvs.clear();
  }
}
