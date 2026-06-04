import { networkInterfaces } from 'os';

export function getLanIpv4List(): string[] {
  const ips: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const e of entries || []) {
      if (e.family === 'IPv4' && !e.internal) ips.push(e.address);
    }
  }
  return ips;
}

/**
 * Pick the address a TV on the local WiFi most likely can reach.
 * Machines often have virtual adapters (WSL 172.x, Tailscale 100.x) that mDNS
 * would otherwise advertise too — prefer classic home/shop LAN ranges first.
 */
export function pickPrimaryLanIp(ips: string[]): string | undefined {
  const score = (ip: string): number => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 2;
    return 3;
  };
  return [...ips].sort((a, b) => score(a) - score(b))[0];
}
