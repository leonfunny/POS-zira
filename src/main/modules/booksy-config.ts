import type { AgentConfig, BooksySyncConfig } from '../../shared/types';

type BooksyConfigResponse = Partial<BooksySyncConfig>;

function cleanId(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function readClaim(source: unknown, keys: string[]): string | null {
  if (!source || typeof source !== 'object') return null;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = cleanId(record[key]);
    if (value) return value;
  }
  return null;
}

export function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  const raw = (token || '').trim().replace(/^Bearer\s+/i, '');
  const payload = raw.split('.')[1];
  if (!payload) return null;

  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    try {
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
      return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }
}

export function extractJwtSalonId(payload: Record<string, unknown> | null | undefined): string | null {
  if (!payload) return null;

  const direct = readClaim(payload, ['salonId', 'salon_id', 'salonID', 'currentSalonId', 'current_salon_id']);
  if (direct) return direct;

  const nestedCandidates = [
    payload.salon,
    payload.currentSalon,
    payload.user,
    payload.authUser,
    payload.tenant,
  ];
  for (const candidate of nestedCandidates) {
    const nested = cleanId(candidate) || readClaim(candidate, ['id', 'salonId', 'salon_id', 'salonID']);
    if (nested) return nested;
  }

  return null;
}

export function getJwtSalonId(token: string | null | undefined): string | null {
  return extractJwtSalonId(decodeJwtPayload(token));
}

export function getCurrentAppSalonId(config: Pick<AgentConfig, 'salonId' | 'authUser'>): string | null {
  return cleanId(config.salonId) || cleanId(config.authUser?.salonId);
}

function getAppSalonName(config: Pick<AgentConfig, 'salonName' | 'authUser'>): string | null {
  return cleanId(config.salonName) || cleanId(config.authUser?.salonName);
}

function getAppAuthEmail(config: Pick<AgentConfig, 'authUser'>): string | null {
  return cleanId(config.authUser?.email);
}

function mismatchWarning(jwtSalonId: string, appSalonId: string): string {
  return `The eNail JWT belongs to salon ${jwtSalonId}, but this app is logged into salon ${appSalonId}. It will not be used for Booksy push.`;
}

export function getBooksyJwtSalonCheck(
  token: string | null | undefined,
  appConfig: Pick<AgentConfig, 'salonId' | 'authUser'>,
): {
  appSalonId: string | null;
  jwtSalonId: string | null;
  jwtSalonMismatch: boolean;
  jwtSalonWarning?: string;
} {
  const appSalonId = getCurrentAppSalonId(appConfig);
  const jwtSalonId = getJwtSalonId(token);
  const jwtSalonMismatch = !!(jwtSalonId && appSalonId && jwtSalonId !== appSalonId);

  return {
    appSalonId,
    jwtSalonId,
    jwtSalonMismatch,
    jwtSalonWarning: jwtSalonMismatch && jwtSalonId && appSalonId
      ? mismatchWarning(jwtSalonId, appSalonId)
      : undefined,
  };
}

export function sanitizeBooksyConfigForRenderer(
  booksyConfig: Partial<BooksySyncConfig>,
  appConfig: AgentConfig,
  jwtForClaims?: string | null,
  override?: { jwtSalonId?: string | null; jwtSalonMismatch?: boolean },
): BooksyConfigResponse {
  const check = getBooksyJwtSalonCheck(jwtForClaims, appConfig);
  const appSalonId = check.appSalonId;
  const jwtSalonId = override?.jwtSalonId ?? check.jwtSalonId;
  const jwtSalonMismatch = override?.jwtSalonMismatch ?? check.jwtSalonMismatch;

  return {
    ...booksyConfig,
    enailJwt: undefined,
    encryptedEnailJwt: undefined,
    clearJwt: undefined,
    hasJwt: !!(booksyConfig.encryptedEnailJwt || booksyConfig.enailJwt),
    appSalonId,
    appSalonName: getAppSalonName(appConfig),
    appAuthEmail: getAppAuthEmail(appConfig),
    jwtSalonId,
    jwtSalonMismatch,
    jwtSalonWarning: jwtSalonMismatch && jwtSalonId && appSalonId
      ? mismatchWarning(jwtSalonId, appSalonId)
      : undefined,
  };
}

export function applyBooksyConfigUpdate(
  current: Partial<BooksySyncConfig>,
  data: Partial<BooksySyncConfig>,
  appConfig: AgentConfig,
  encryptJwt: (jwt: string) => string | undefined,
  existingJwtForClaims?: string | null,
): { updated: BooksySyncConfig; response: BooksyConfigResponse } {
  const {
    enailJwt,
    encryptedEnailJwt: _encryptedIgnored,
    hasJwt: _hasJwt,
    clearJwt,
    appSalonId: _appSalonId,
    appSalonName: _appSalonName,
    appAuthEmail: _appAuthEmail,
    jwtSalonId: _jwtSalonId,
    jwtSalonMismatch: _jwtSalonMismatch,
    jwtSalonWarning: _jwtSalonWarning,
    ...safeData
  } = data;

  const updated = { ...current, ...safeData } as BooksySyncConfig;
  let responseOverride: { jwtSalonId?: string | null; jwtSalonMismatch?: boolean } | undefined;
  let responseJwtForClaims = existingJwtForClaims;

  if (clearJwt) {
    delete (updated as any).encryptedEnailJwt;
    delete (updated as any).enailJwt;
    responseJwtForClaims = null;
  } else if (typeof enailJwt === 'string' && enailJwt.trim()) {
    const submittedJwt = enailJwt.trim();
    const submittedJwtSalonId = getJwtSalonId(submittedJwt);
    const appSalonId = getCurrentAppSalonId(appConfig);

    if (submittedJwtSalonId && appSalonId && submittedJwtSalonId !== appSalonId) {
      delete (updated as any).enailJwt;
      responseOverride = { jwtSalonId: submittedJwtSalonId, jwtSalonMismatch: true };
    } else {
      const encrypted = encryptJwt(submittedJwt);
      if (encrypted) {
        updated.encryptedEnailJwt = encrypted;
        delete (updated as any).enailJwt;
        responseJwtForClaims = submittedJwt;
      }
    }
  }

  return {
    updated,
    response: sanitizeBooksyConfigForRenderer(updated, appConfig, responseJwtForClaims, responseOverride),
  };
}
