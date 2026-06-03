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
