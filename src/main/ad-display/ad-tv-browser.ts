import Bonjour from 'bonjour-service';
import logger from '../logger';
import type { TvDiscoveredDevice } from '../../shared/types';

const TV_STALE_MS = 5 * 60 * 1000;

type Browser = ReturnType<Bonjour['find']>;
interface MdnsService {
  name?: string;
  host?: string;
  fqdn?: string;
  txt?: Record<string, unknown>;
  addresses?: string[];
  referer?: { address?: string };
}

export class AdTvBrowser {
  private bonjour: Bonjour | null = null;
  private browser: Browser | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private devices = new Map<string, TvDiscoveredDevice>();

  start(): void {
    if (this.browser) return;
    try {
      this.bonjour = new Bonjour();
      this.browser = this.bonjour.find({ type: 'zira-tv', protocol: 'tcp' });
      this.browser.on('up', (service) => this.upsert(service));
      this.browser.on('txt-update', (service) => this.upsert(service));
      this.browser.on('srv-update', (service) => this.upsert(service));
      this.browser.on('down', (service) => this.remove(service));
      this.cleanupTimer = setInterval(() => this.expire(), 30_000);
      this.cleanupTimer.unref?.();
      logger.info('[AdDisplay] browsing _zira-tv._tcp for online TV screens');
    } catch (e: any) {
      logger.error('[AdDisplay] TV browser failed:', e?.message || e);
      this.stop();
    }
  }

  stop(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    try { this.browser?.stop?.(); } catch { /* ignore */ }
    try { this.bonjour?.destroy(); } catch { /* ignore */ }
    this.browser = null;
    this.bonjour = null;
    this.devices.clear();
  }

  getDevices(): TvDiscoveredDevice[] {
    this.expire();
    return [...this.devices.values()].sort((a, b) => b.seenAt - a.seenAt);
  }

  private upsert(service: MdnsService): void {
    const now = Date.now();
    const txt = (service.txt || {}) as Record<string, unknown>;
    const ip = this.pickIp(service);
    const name = String(service.name || 'Zira TV');
    const id = String(txt.deviceId || `${name}-${ip || service.host || service.fqdn}`);
    this.devices.set(id, {
      id,
      name,
      ip,
      model: this.cleanTxt(txt.model) || name,
      manufacturer: this.cleanTxt(txt.manufacturer),
      posHost: this.cleanTxt(txt.posHost),
      seenAt: now,
    });
  }

  private remove(service: MdnsService): void {
    const txt = (service.txt || {}) as Record<string, unknown>;
    const ip = this.pickIp(service);
    const name = String(service.name || 'Zira TV');
    const id = String(txt.deviceId || `${name}-${ip || service.host || service.fqdn}`);
    this.devices.delete(id);
  }

  private expire(): void {
    const cutoff = Date.now() - TV_STALE_MS;
    for (const [id, device] of this.devices.entries()) {
      if (device.seenAt < cutoff) this.devices.delete(id);
    }
  }

  private pickIp(service: MdnsService): string | undefined {
    const addresses = (service.addresses || []).filter(Boolean);
    return addresses.find((ip: string) => /^\d+\.\d+\.\d+\.\d+$/.test(ip))
      || service.referer?.address
      || addresses[0];
  }

  private cleanTxt(value: unknown): string | undefined {
    if (typeof value === 'string') return value || undefined;
    if (Buffer.isBuffer(value)) return value.toString('utf8') || undefined;
    return undefined;
  }
}
