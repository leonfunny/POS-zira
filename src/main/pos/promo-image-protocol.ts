import { net, protocol } from 'electron';
import { statSync } from 'fs';
import { pathToFileURL } from 'url';
import logger from '../logger';
import { getConfigValue } from '../config/store';
import {
  isPathInsideDirectory,
  isSupportedPromoImagePath,
  PROMO_IMAGE_PROTOCOL,
  promoImageUrlToPath,
} from './promo-image-url';

let schemeRegistered = false;
let handlerRegistered = false;

export function registerPromoImageProtocolScheme(): void {
  if (schemeRegistered) return;

  protocol.registerSchemesAsPrivileged([
    {
      scheme: PROMO_IMAGE_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);

  schemeRegistered = true;
}

export function registerPromoImageProtocolHandler(): void {
  if (handlerRegistered) return;

  protocol.handle(PROMO_IMAGE_PROTOCOL, async (request) => {
    const filePath = promoImageUrlToPath(request.url);
    const folder = getConfigValue('customerDisplayPromoFolder') as string | undefined;

    if (!filePath || !folder) {
      return new Response('Promo image not found', { status: 404 });
    }

    if (!isSupportedPromoImagePath(filePath) || !isPathInsideDirectory(filePath, folder)) {
      logger.warn(`[PromoProtocol] Blocked promo image outside configured folder: ${filePath}`);
      return new Response('Promo image blocked', { status: 403 });
    }

    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) {
        return new Response('Promo image not found', { status: 404 });
      }

      return net.fetch(pathToFileURL(filePath).toString());
    } catch (err) {
      logger.debug(`[PromoProtocol] Failed to serve promo image: ${err}`);
      return new Response('Promo image not found', { status: 404 });
    }
  });

  handlerRegistered = true;
}
