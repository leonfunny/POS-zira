import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { AuthUser } from '../../shared/types';
import { detectSystemLanguage, getAuthTranslation } from '../i18n/auth-translations';
import { Language, languageNames } from '../i18n/translations';

/**
 * Minimal QR Code generator - pure JS, no canvas dependency.
 * Generates an SVG string from text input.
 * Uses numeric/alphanumeric/byte encoding, error correction level M, version auto-selected.
 */
function generateQRSvg(text: string, size: number = 200): string {
  // Use a canvas-free approach: create QR matrix then render as SVG rects
  const matrix = generateQRMatrix(text);
  const cellSize = size / (matrix.length + 2); // +2 for quiet zone
  const qz = cellSize; // quiet zone

  let rects = '';
  for (let y = 0; y < matrix.length; y++) {
    for (let x = 0; x < matrix[y].length; x++) {
      if (matrix[y][x]) {
        rects += `<rect x="${(qz + x * cellSize).toFixed(2)}" y="${(qz + y * cellSize).toFixed(2)}" width="${cellSize.toFixed(2)}" height="${cellSize.toFixed(2)}" fill="#1a1915"/>`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
    <rect width="${size}" height="${size}" fill="#ffffff" rx="8"/>
    ${rects}
  </svg>`;
}

// ---- Minimal QR Code matrix generation (byte mode, ECC M) ----

function generateQRMatrix(text: string): boolean[][] {
  const data = new TextEncoder().encode(text);
  const version = getMinVersion(data.length);
  const size = version * 4 + 17;

  // Create modules grid
  const modules: (boolean | null)[][] = Array.from({ length: size }, () => Array(size).fill(null));
  const isFunction: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));

  // Place function patterns
  placeFinders(modules, isFunction, size);
  placeAlignments(modules, isFunction, version, size);
  placeTimingPatterns(modules, isFunction, size);
  modules[8][version * 4 + 9] = true; // Dark module
  isFunction[8][version * 4 + 9] = true;
  reserveFormatBits(isFunction, size, version);

  // Encode data
  const ecInfo = getECInfo(version);
  const codewords = encodeData(data, version, ecInfo);
  const allCodewords = addErrorCorrection(codewords, ecInfo);

  // Place data
  placeData(modules, isFunction, allCodewords, size);

  // Apply best mask
  const bestMask = findBestMask(modules, isFunction, size);
  applyMask(modules, isFunction, bestMask, size);
  placeFormatBits(modules, bestMask, size, version);

  return modules.map(row => row.map(cell => cell === true));
}

function getMinVersion(dataLen: number): number {
  // Byte mode capacity for ECC level M
  const caps = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666];
  for (let v = 1; v < caps.length; v++) {
    // 4 bits mode + char count bits + data
    const charCountBits = v <= 9 ? 8 : 16;
    const availBits = caps[v] * 8;
    const neededBits = 4 + charCountBits + dataLen * 8;
    if (neededBits <= availBits) return v;
  }
  return 20; // fallback
}

interface ECInfo {
  totalCodewords: number;
  ecCodewordsPerBlock: number;
  numBlocks: number;
  dataCodewordsPerBlock: number;
}

function getECInfo(version: number): ECInfo {
  // ECC level M parameters per version (simplified table)
  const table: Record<number, [number, number, number]> = {
    1: [10, 7, 1], 2: [16, 10, 1], 3: [26, 15, 1], 4: [36, 20, 1],
    5: [46, 26, 1], 6: [60, 18, 2], 7: [66, 20, 2], 8: [86, 24, 2],
    9: [100, 30, 2], 10: [122, 18, 4], 11: [140, 20, 4], 12: [158, 24, 4],
    13: [180, 26, 4], 14: [197, 28, 4], 15: [223, 24, 6], 16: [253, 28, 6],
    17: [283, 28, 6], 18: [313, 26, 8], 19: [341, 26, 8], 20: [385, 28, 8],
  };
  const [totalData, ecPerBlock, numBlocks] = table[version] || table[1];
  const totalCodewords = getVersionTotalCodewords(version);
  const totalEC = ecPerBlock * numBlocks;
  return {
    totalCodewords,
    ecCodewordsPerBlock: ecPerBlock,
    numBlocks,
    dataCodewordsPerBlock: Math.floor((totalCodewords - totalEC) / numBlocks),
  };
}

function getVersionTotalCodewords(version: number): number {
  const size = version * 4 + 17;
  let total = size * size;
  // Subtract function pattern modules
  total -= 3 * 64; // 3 finder patterns (8x8 each)
  total -= 2 * (size - 16); // timing patterns
  total -= 1; // dark module
  // Alignment patterns
  const positions = getAlignmentPositions(version);
  if (positions.length > 0) {
    let alignCount = positions.length * positions.length;
    // Subtract alignments overlapping finders
    alignCount -= (version >= 2 ? 3 : 0);
    total -= alignCount * 25;
  }
  // Format + version info
  total -= 31; // format info bits
  if (version >= 7) total -= 36; // version info
  return Math.floor(total / 8);
}

function encodeData(data: Uint8Array, version: number, ecInfo: ECInfo): number[] {
  const bits: number[] = [];
  const charCountBits = version <= 9 ? 8 : 16;

  // Mode indicator: byte mode = 0100
  pushBits(bits, 0b0100, 4);
  // Character count
  pushBits(bits, data.length, charCountBits);
  // Data
  for (const byte of data) {
    pushBits(bits, byte, 8);
  }

  const totalDataBits = ecInfo.dataCodewordsPerBlock * ecInfo.numBlocks * 8;

  // Terminator
  const remaining = totalDataBits - bits.length;
  pushBits(bits, 0, Math.min(4, remaining));

  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  // Pad codewords
  const padWords = [0xEC, 0x11];
  let padIdx = 0;
  while (bits.length < totalDataBits) {
    pushBits(bits, padWords[padIdx % 2], 8);
    padIdx++;
  }

  // Convert to bytes
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] || 0);
    codewords.push(byte);
  }

  return codewords;
}

function pushBits(arr: number[], value: number, count: number): void {
  for (let i = count - 1; i >= 0; i--) {
    arr.push((value >> i) & 1);
  }
}

function addErrorCorrection(dataCodewords: number[], ecInfo: ECInfo): number[] {
  const { ecCodewordsPerBlock, numBlocks, dataCodewordsPerBlock } = ecInfo;
  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];

  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    // Some blocks may have one extra data codeword
    const blockSize = dataCodewordsPerBlock + (b >= numBlocks - (dataCodewords.length % numBlocks === 0 ? 0 : dataCodewords.length % numBlocks) ? 0 : 0);
    const block = dataCodewords.slice(offset, offset + dataCodewordsPerBlock);
    // Pad if needed
    while (block.length < dataCodewordsPerBlock) block.push(0);
    blocks.push(block);
    offset += dataCodewordsPerBlock;

    // Generate EC codewords using Reed-Solomon
    const ec = reedSolomonEncode(block, ecCodewordsPerBlock);
    ecBlocks.push(ec);
  }

  // Interleave data blocks
  const result: number[] = [];
  const maxDataLen = Math.max(...blocks.map(b => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of blocks) {
      if (i < block.length) result.push(block[i]);
    }
  }

  // Interleave EC blocks
  for (let i = 0; i < ecCodewordsPerBlock; i++) {
    for (const ec of ecBlocks) {
      if (i < ec.length) result.push(ec[i]);
    }
  }

  return result;
}

// GF(256) with polynomial 0x11d
const GF_EXP: number[] = new Array(512);
const GF_LOG: number[] = new Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x = x << 1;
    if (x >= 256) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function reedSolomonEncode(data: number[], ecLen: number): number[] {
  // Generate polynomial
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const newGen = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      newGen[j] ^= gen[j];
      newGen[j + 1] ^= gfMul(gen[j], GF_EXP[i]);
    }
    gen = newGen;
  }

  const result = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.shift();
    result.push(0);
    for (let i = 0; i < gen.length - 1; i++) {
      result[i] ^= gfMul(factor, gen[i + 1]);
    }
  }
  return result;
}

function placeFinders(modules: (boolean | null)[][], isFunc: boolean[][], size: number): void {
  const positions = [[0, 0], [size - 7, 0], [0, size - 7]];
  for (const [row, col] of positions) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const y = row + dy, x = col + dx;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const inOuter = dy === 0 || dy === 6 || dx === 0 || dx === 6;
        const inInner = dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4;
        const inBorder = dy === -1 || dy === 7 || dx === -1 || dx === 7;
        modules[y][x] = (inOuter || inInner) && !inBorder;
        isFunc[y][x] = true;
      }
    }
  }
}

function getAlignmentPositions(version: number): number[] {
  if (version <= 1) return [];
  const positions: number[][] = [
    [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54],
    [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
    [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86],
    [6, 34, 62, 90],
  ];
  return positions[version] || [];
}

function placeAlignments(modules: (boolean | null)[][], isFunc: boolean[][], version: number, size: number): void {
  const positions = getAlignmentPositions(version);
  for (const row of positions) {
    for (const col of positions) {
      // Skip if overlaps with finder
      if ((row <= 8 && col <= 8) || (row <= 8 && col >= size - 8) || (row >= size - 8 && col <= 8)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const y = row + dy, x = col + dx;
          modules[y][x] = Math.abs(dy) === 2 || Math.abs(dx) === 2 || (dy === 0 && dx === 0);
          isFunc[y][x] = true;
        }
      }
    }
  }
}

function placeTimingPatterns(modules: (boolean | null)[][], isFunc: boolean[][], size: number): void {
  for (let i = 8; i < size - 8; i++) {
    modules[6][i] = i % 2 === 0;
    isFunc[6][i] = true;
    modules[i][6] = i % 2 === 0;
    isFunc[i][6] = true;
  }
}

function reserveFormatBits(isFunc: boolean[][], size: number, version: number): void {
  // Around top-left finder
  for (let i = 0; i <= 8; i++) {
    if (i < size) isFunc[8][i] = true;
    if (i < size) isFunc[i][8] = true;
  }
  // Around top-right finder
  for (let i = 0; i < 8; i++) {
    isFunc[8][size - 1 - i] = true;
  }
  // Around bottom-left finder
  for (let i = 0; i < 7; i++) {
    isFunc[size - 1 - i][8] = true;
  }
  // Version info
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        isFunc[i][size - 11 + j] = true;
        isFunc[size - 11 + j][i] = true;
      }
    }
  }
}

function placeData(modules: (boolean | null)[][], isFunc: boolean[][], codewords: number[], size: number): void {
  let bitIdx = 0;
  const totalBits = codewords.length * 8;

  // Traverse right to left, in columns of 2
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // Skip timing column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        if (isFunc[y][x]) continue;
        if (bitIdx < totalBits) {
          const byteIdx = Math.floor(bitIdx / 8);
          const bitPos = 7 - (bitIdx % 8);
          modules[y][x] = ((codewords[byteIdx] >> bitPos) & 1) === 1;
          bitIdx++;
        } else {
          modules[y][x] = false;
        }
      }
    }
  }
}

function applyMask(modules: (boolean | null)[][], isFunc: boolean[][], mask: number, size: number): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isFunc[y][x]) continue;
      let invert = false;
      switch (mask) {
        case 0: invert = (y + x) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (y + x) % 3 === 0; break;
        case 4: invert = (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; break;
        case 5: invert = (y * x) % 2 + (y * x) % 3 === 0; break;
        case 6: invert = ((y * x) % 2 + (y * x) % 3) % 2 === 0; break;
        case 7: invert = ((y + x) % 2 + (y * x) % 3) % 2 === 0; break;
      }
      if (invert) modules[y][x] = !modules[y][x];
    }
  }
}

function findBestMask(modules: (boolean | null)[][], isFunc: boolean[][], size: number): number {
  // Simplified: just use mask 0 for speed. Full QR spec evaluates all 8.
  return 0;
}

function placeFormatBits(modules: (boolean | null)[][], mask: number, size: number, version: number): void {
  // Format info: ECC level M (00) + mask pattern
  const formatData = (0b01 << 3) | mask; // ECC M = 0, mask

  // BCH(15,5) encoding for format info
  let bits = formatData;
  for (let i = 0; i < 10; i++) {
    if (bits & (1 << (14 - i))) continue;
    // Actually we need proper BCH encoding
  }

  // Use lookup table for ECC M format strings
  const formatStrings: number[] = [
    0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0,
  ];
  const formatBits = formatStrings[mask] || formatStrings[0];

  // Place format bits
  const formatPositions1: [number, number][] = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  const formatPositions2: [number, number][] = [];
  for (let i = 0; i < 7; i++) formatPositions2.push([size - 1 - i, 8]);
  for (let i = 7; i < 15; i++) formatPositions2.push([8, size - 15 + i]);

  for (let i = 0; i < 15; i++) {
    const bit = ((formatBits >> (14 - i)) & 1) === 1;
    if (i < formatPositions1.length) {
      const [y, x] = formatPositions1[i];
      modules[y][x] = bit;
    }
    if (i < formatPositions2.length) {
      const [y, x] = formatPositions2[i];
      modules[y][x] = bit;
    }
  }

  // Version info for version >= 7
  if (version >= 7) {
    const versionBits = getVersionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((versionBits >> i) & 1) === 1;
      const row = Math.floor(i / 3);
      const col = i % 3;
      modules[row][size - 11 + col] = bit;
      modules[size - 11 + col][row] = bit;
    }
  }
}

function getVersionBits(version: number): number {
  // BCH(18,6) for version info
  const versionTable: Record<number, number> = {
    7: 0x07C94, 8: 0x085BC, 9: 0x09A99, 10: 0x0A4D3, 11: 0x0BBF6,
    12: 0x0C762, 13: 0x0D847, 14: 0x0E60D, 15: 0x0F928, 16: 0x10B78,
    17: 0x1145D, 18: 0x12A17, 19: 0x13532, 20: 0x149A6,
  };
  return versionTable[version] || 0;
}

interface AuthScreenProps {
  onLoginSuccess: (user: AuthUser) => void;
  onOfflineMode?: () => void;
}

type AuthTab = 'telegram' | 'email';
type QRStatus = 'loading' | 'ready' | 'polling' | 'verified' | 'expired' | 'error';

export default function AuthScreen({ onLoginSuccess, onOfflineMode }: AuthScreenProps) {
  // Language - auto-detect from system
  const [language, setLanguage] = useState<Language>(() => detectSystemLanguage());
  const t = useMemo(() => getAuthTranslation(language), [language]);

  const [activeTab, setActiveTab] = useState<AuthTab>('telegram');

  // Telegram QR state
  const [qrSvg, setQrSvg] = useState<string>('');
  const [qrStatus, setQrStatus] = useState<QRStatus>('loading');
  const [loginToken, setLoginToken] = useState<string>('');
  const [deepLink, setDeepLink] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Email login state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailError, setEmailError] = useState('');

  // Register state
  const [registerLink, setRegisterLink] = useState('');

  // Server status
  const [serverStatus, setServerStatus] = useState<'checking' | 'online' | 'offline' | null>(null);

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  const generateQR = useCallback(async () => {
    setQrStatus('loading');
    setErrorMessage('');
    stopPolling();

    try {
      const result = await window.electronAPI.auth.generateLoginToken();
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to generate QR code');
      }

      const { token, deepLink: link } = result.data;
      setLoginToken(token);
      setDeepLink(link);

      // Generate QR code as SVG (pure JS, no canvas dependency)
      const svg = generateQRSvg(link, 200);
      setQrSvg(svg);
      setQrStatus('ready');

      // Start polling
      startPolling(token);
    } catch (err: any) {
      console.error('[AuthScreen] Failed to generate QR:', err);
      setErrorMessage(err.message || 'QR generation error');
      setQrStatus('error');
    }
  }, [stopPolling]);

  const startPolling = useCallback((token: string) => {
    setQrStatus('polling');

    pollIntervalRef.current = setInterval(async () => {
      try {
        const result = await window.electronAPI.auth.checkToken(token);
        if (!result.success) return;

        const data = result.data;
        if (!data) return;

        if (data.status === 'VERIFIED' && data.user) {
          stopPolling();
          setQrStatus('verified');

          const user: AuthUser = {
            id: data.user.id,
            email: data.user.email,
            firstName: data.user.firstName,
            lastName: data.user.lastName,
            role: data.user.role,
            salonId: data.user.salonId || data.salon?.id || '',
            salonName: data.salon?.name,
          };

          // Small delay for visual feedback
          setTimeout(() => onLoginSuccess(user), 500);
        } else if (data.status === 'EXPIRED') {
          stopPolling();
          setQrStatus('expired');
        }
      } catch (err) {
        console.error('[AuthScreen] Poll error:', err);
      }
    }, 2000);
  }, [stopPolling, onLoginSuccess]);

  // Generate QR on mount
  useEffect(() => {
    generateQR();
    return () => stopPolling();
  }, [generateQR, stopPolling]);

  const handleOpenTelegram = () => {
    if (deepLink) {
      window.open(deepLink, '_blank');
    }
  };

  const handleRegister = async () => {
    try {
      const result = await window.electronAPI.auth.generateRegisterToken();
      if (result.success && result.data) {
        setRegisterLink(result.data.deepLink);
        window.open(result.data.deepLink, '_blank');
      }
    } catch (err: any) {
      console.error('[AuthScreen] Register error:', err);
    }
  };

  const checkServerStatus = async () => {
    setServerStatus('checking');
    try {
      const result = await window.electronAPI.auth.generateLoginToken();
      if (result.success) {
        setServerStatus('online');
        // Server is back online, regenerate QR
        generateQR();
      } else {
        setServerStatus('offline');
      }
    } catch (err) {
      setServerStatus('offline');
    }
  };

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;

    setEmailLoading(true);
    setEmailError('');

    try {
      const result = await window.electronAPI.auth.loginWithEmail(email, password);
      if (result.success && result.data) {
        onLoginSuccess(result.data.user);
      } else {
        setEmailError(result.error || 'Invalid email or password');
      }
    } catch (err: any) {
      setEmailError(err.message || 'Login error');
    } finally {
      setEmailLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-slate-50 text-slate-900">
      <div className="min-h-screen grid grid-cols-1 lg:grid-cols-[1.2fr_0.8fr]">
        <section className="relative hero-bg overflow-hidden px-8 py-10 sm:px-10 lg:px-14 lg:py-16">
          <div className="absolute inset-0 pointer-events-none">
            <div className="hero-orb orb-1"></div>
            <div className="hero-orb orb-2"></div>
            <div className="hero-orb orb-3"></div>
          </div>

          {/* Language selector - fixed position top right */}
          <div className="absolute top-4 right-4 z-20">
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as Language)}
              className="text-xs bg-white/90 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-700 cursor-pointer hover:bg-white focus:outline-none focus:ring-2 focus:ring-brand-300 shadow-sm"
            >
              {(Object.keys(languageNames) as Language[]).map((lang) => (
                <option key={lang} value={lang}>{languageNames[lang]}</option>
              ))}
            </select>
          </div>

          <div className="relative z-10 max-w-xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-200/70 bg-white/70 px-3 py-1 text-xs font-medium text-slate-600 shadow-sm backdrop-blur">
              <span className="h-2 w-2 rounded-full bg-brand-500 shadow-[0_0_0_3px_rgba(218,119,86,0.18)]" />
              {t('auth.badge')}
            </div>

            <div className="mt-10">
              <p className="text-xs uppercase tracking-[0.6em] text-slate-500">Zira</p>
              <h1 className="mt-3 font-display text-4xl sm:text-5xl lg:text-6xl tracking-[0.18em] text-slate-900">
                {t('auth.brand')} <span className="text-brand-600">{t('auth.brandAccent')}</span> {t('auth.brandSuffix')}
              </h1>
              <p className="mt-4 text-lg text-slate-600">{t('auth.tagline')}</p>
            </div>

            <div className="mt-10 grid gap-4">
              <div className="flex items-start gap-3 rounded-2xl border border-slate-200/70 bg-white/75 p-4 shadow-sm backdrop-blur">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-100 text-brand-700 text-xs font-semibold">
                  01
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-800">{t('auth.feature1.title')}</p>
                  <p className="text-xs text-slate-500">{t('auth.feature1.desc')}</p>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-2xl border border-slate-200/70 bg-white/75 p-4 shadow-sm backdrop-blur">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-100 text-brand-700 text-xs font-semibold">
                  02
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-800">{t('auth.feature2.title')}</p>
                  <p className="text-xs text-slate-500">{t('auth.feature2.desc')}</p>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-2xl border border-slate-200/70 bg-white/75 p-4 shadow-sm backdrop-blur">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-100 text-brand-700 text-xs font-semibold">
                  03
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-800">{t('auth.feature3.title')}</p>
                  <p className="text-xs text-slate-500">{t('auth.feature3.desc')}</p>
                </div>
              </div>
            </div>

            <div className="mt-10 flex flex-wrap items-center gap-3 text-xs text-slate-500">
              <div className="rounded-full border border-slate-200 bg-white/70 px-3 py-1">{t('auth.tag1')}</div>
              <div className="rounded-full border border-slate-200 bg-white/70 px-3 py-1">{t('auth.tag2')}</div>
              <div className="rounded-full border border-slate-200 bg-white/70 px-3 py-1">{t('auth.tag3')}</div>
            </div>
          </div>
        </section>

        <section className="relative flex items-center justify-center px-6 py-10 sm:px-10 lg:px-12 bg-slate-50">
          <div className="w-full max-w-md">
            <div className="mb-6">
              <p className="text-xs uppercase tracking-[0.35em] text-slate-400">{t('auth.signIn')}</p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-900">{t('auth.welcome')}</h2>
              <p className="mt-2 text-sm text-slate-600">{t('auth.welcomeDesc')}</p>
            </div>

            {/* Telegram QR Section */}
            <div className="rounded-2xl border border-slate-200 bg-white/90 p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-4">
                <svg className="w-5 h-5 text-[#0088cc]" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
                </svg>
                <h3 className="text-sm font-semibold text-slate-800">{t('auth.telegram.title')}</h3>
              </div>

              <div className="flex flex-col items-center">
                {qrStatus === 'loading' && (
                  <div className="w-[210px] h-[210px] flex items-center justify-center bg-slate-100 rounded-xl">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600"></div>
                  </div>
                )}

                {(qrStatus === 'ready' || qrStatus === 'polling') && qrSvg && (
                  <div className="relative">
                    <div
                      className="w-[210px] h-[210px] rounded-xl overflow-hidden border border-slate-200 bg-white"
                      dangerouslySetInnerHTML={{ __html: qrSvg }}
                    />
                    {qrStatus === 'polling' && (
                      <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-green-500 border-2 border-white flex items-center justify-center">
                        <div className="w-2 h-2 rounded-full bg-white animate-pulse"></div>
                      </div>
                    )}
                  </div>
                )}

                {qrStatus === 'verified' && (
                  <div className="w-[210px] h-[210px] flex flex-col items-center justify-center bg-green-50 rounded-xl">
                    <svg className="w-16 h-16 text-green-500 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <p className="text-sm font-medium text-green-700">{t('auth.telegram.verified')}</p>
                  </div>
                )}

                {qrStatus === 'expired' && (
                  <div className="w-[210px] h-[210px] flex flex-col items-center justify-center bg-amber-50 rounded-xl">
                    <svg className="w-12 h-12 text-amber-500 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <p className="text-sm text-amber-700 mb-2">{t('auth.telegram.expired')}</p>
                    <button
                      onClick={generateQR}
                      className="px-3 py-1.5 text-xs font-medium bg-amber-600 text-white rounded-md hover:bg-amber-700 transition-colors"
                    >
                      {t('auth.telegram.tryAgain')}
                    </button>
                  </div>
                )}

                {qrStatus === 'error' && (
                  <div className="w-[210px] h-[210px] flex flex-col items-center justify-center bg-red-50 rounded-xl p-3">
                    <svg className="w-10 h-10 text-red-400 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                    </svg>
                    <p className="text-xs text-red-600 text-center mb-2">{errorMessage}</p>
                    <div className="flex gap-2">
                      <button
                        onClick={generateQR}
                        className="px-3 py-1.5 text-xs font-medium bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors"
                      >
                        {t('auth.telegram.tryAgain')}
                      </button>
                    </div>
                    <div className="mt-2 flex items-center gap-1.5">
                      <span className={`w-2 h-2 rounded-full ${
                        serverStatus === 'checking' ? 'bg-yellow-400 animate-pulse' :
                        serverStatus === 'online' ? 'bg-green-500' :
                        serverStatus === 'offline' ? 'bg-red-500' :
                        'bg-slate-300'
                      }`} />
                      <span className="text-[10px] text-slate-500">
                        {serverStatus === 'checking' ? t('auth.serverChecking') :
                         serverStatus === 'online' ? t('auth.serverOnline') :
                         serverStatus === 'offline' ? t('auth.serverOffline') :
                         t('auth.serverUnknown')}
                      </span>
                      <button
                        onClick={checkServerStatus}
                        disabled={serverStatus === 'checking'}
                        className="text-[10px] text-brand-600 hover:text-brand-700 underline disabled:opacity-50"
                      >
                        {t('auth.check')}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {(qrStatus === 'ready' || qrStatus === 'polling') && (
                <>
                  <p className="text-xs text-slate-500 text-center mt-3">
                    {t('auth.telegram.scan')}
                  </p>

                  <button
                    onClick={handleOpenTelegram}
                    className="w-full mt-3 px-3 py-2 text-sm font-medium text-[#0088cc] bg-[#0088cc]/10 rounded-lg hover:bg-[#0088cc]/20 transition-colors flex items-center justify-center gap-2"
                  >
                    {t('auth.telegram.open')}
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </button>

                  <div className="flex items-center justify-center gap-2 mt-3">
                    <div className="flex items-center gap-1">
                      <div className="w-1 h-1 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '0ms' }}></div>
                      <div className="w-1 h-1 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '150ms' }}></div>
                      <div className="w-1 h-1 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '300ms' }}></div>
                    </div>
                    <span className="text-xs text-slate-400">{t('auth.telegram.waiting')}</span>
                  </div>
                </>
              )}
            </div>

            <div className="flex items-center gap-3 my-5">
              <div className="flex-1 h-px bg-slate-200"></div>
              <span className="text-xs text-slate-400 font-medium">{t('auth.or')}</span>
              <div className="flex-1 h-px bg-slate-200"></div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white/90 p-5 shadow-sm">
              <form onSubmit={handleEmailLogin} className="space-y-3">
                <div>
                  <label htmlFor="auth-email" className="block text-xs font-medium text-slate-600 mb-1">{t('auth.email.label')}</label>
                  <input
                    id="auth-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t('auth.email.placeholder')}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                    disabled={emailLoading}
                  />
                </div>
                <div>
                  <label htmlFor="auth-password" className="block text-xs font-medium text-slate-600 mb-1">{t('auth.password.label')}</label>
                  <input
                    id="auth-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('auth.password.placeholder')}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                    disabled={emailLoading}
                  />
                </div>

                {emailError && (
                  <p className="text-xs text-red-600">{emailError}</p>
                )}

                <button
                  type="submit"
                  disabled={emailLoading || !email.trim() || !password.trim()}
                  className="w-full px-3 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {emailLoading ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                      {t('auth.signingIn')}
                    </>
                  ) : (
                    t('auth.signInButton')
                  )}
                </button>
              </form>
            </div>

            <div className="text-center mt-4">
              <p className="text-xs text-slate-500">
                {t('auth.noAccount')}{' '}
                <button
                  onClick={handleRegister}
                  className="text-brand-600 hover:text-brand-700 font-medium hover:underline"
                >
                  {t('auth.register')}
                </button>
              </p>
            </div>

            {onOfflineMode && (
              <div className="mt-4">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex-1 h-px bg-slate-200"></div>
                  <span className="text-xs text-slate-400 font-medium">{t('auth.or')}</span>
                  <div className="flex-1 h-px bg-slate-200"></div>
                </div>
                <button
                  onClick={onOfflineMode}
                  className="w-full px-3 py-2.5 text-sm font-medium text-slate-600 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 transition-colors flex items-center justify-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3m8.293 8.293l1.414 1.414" />
                  </svg>
                  {t('auth.offlineMode')}
                </button>
                <p className="text-[10px] text-slate-400 text-center mt-2">
                  {t('auth.offlineDesc')}
                </p>
              </div>
            )}

            <p className="text-center text-[10px] text-slate-300 mt-4">v1.0.1</p>
          </div>
        </section>
      </div>
    </div>
  );
}
