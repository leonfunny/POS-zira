// Unit tests for the self-checkout amount announcer. Pure-function logic:
// we verify the sequence of clip filenames produced for representative
// amounts, especially the Polish noun-declension edge cases that switch
// between "złoty / złote / złotych" and "grosz / grosze / groszy".
//
// We deliberately do NOT test the audio playback or Web Speech fallback —
// those require a real Audio/SpeechSynthesis runtime. The sequence logic
// is what determines whether the staff hears the right phrase.

import { describe, expect, it } from 'vitest';
import { buildAnnouncementSequence } from '../src/renderer/windows/self-checkout/polish-amount-tts';

describe('buildAnnouncementSequence — Polish amount TTS', () => {
  describe('prefix selection', () => {
    it('uses prefix_card.mp3 for CARD', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 100 });
      expect(seq[0]).toBe('prefix_card.mp3');
    });

    it('uses prefix_cash.mp3 for CASH', () => {
      const seq = buildAnnouncementSequence({ method: 'CASH', totalGrosze: 100 });
      expect(seq[0]).toBe('prefix_cash.mp3');
    });

    it('always inserts do_zaplaty.mp3 after the prefix', () => {
      const card = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 100 });
      const cash = buildAnnouncementSequence({ method: 'CASH', totalGrosze: 100 });
      expect(card[1]).toBe('do_zaplaty.mp3');
      expect(cash[1]).toBe('do_zaplaty.mp3');
    });
  });

  describe('whole złoty amounts (no grosze)', () => {
    it('1 zł → "jeden złoty" (singular)', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 100 });
      expect(seq).toEqual(['prefix_card.mp3', 'do_zaplaty.mp3', '1.mp3', 'zloty_1.mp3']);
    });

    it('2 zł → "dwa złote" (few form)', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 200 });
      expect(seq).toEqual(['prefix_card.mp3', 'do_zaplaty.mp3', '2.mp3', 'zloty_few.mp3']);
    });

    it('4 zł → "cztery złote" (few form, last unit 2-4)', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 400 });
      expect(seq).toEqual(['prefix_card.mp3', 'do_zaplaty.mp3', '4.mp3', 'zloty_few.mp3']);
    });

    it('5 zł → "pięć złotych" (many/genitive plural)', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 500 });
      expect(seq).toEqual(['prefix_card.mp3', 'do_zaplaty.mp3', '5.mp3', 'zloty_many.mp3']);
    });

    it('12 zł → "dwanaście złotych" (12-14 forced to many, not few)', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 1200 });
      expect(seq).toEqual(['prefix_card.mp3', 'do_zaplaty.mp3', '12.mp3', 'zloty_many.mp3']);
    });

    it('13 zł → "trzynaście złotych" (12-14 forced to many)', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 1300 });
      expect(seq).toEqual(['prefix_card.mp3', 'do_zaplaty.mp3', '13.mp3', 'zloty_many.mp3']);
    });

    it('14 zł → "czternaście złotych" (12-14 forced to many)', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 1400 });
      expect(seq).toEqual(['prefix_card.mp3', 'do_zaplaty.mp3', '14.mp3', 'zloty_many.mp3']);
    });

    it('22 zł → "dwadzieścia dwa złote" (last unit 2 → few)', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 2200 });
      expect(seq).toEqual(['prefix_card.mp3', 'do_zaplaty.mp3', '22.mp3', 'zloty_few.mp3']);
    });

    it('21 zł → "dwadzieścia jeden złotych" (compound with 1 → many, NOT singular)', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 2100 });
      expect(seq).toEqual(['prefix_card.mp3', 'do_zaplaty.mp3', '21.mp3', 'zloty_many.mp3']);
    });

    it('100 zł → "sto złotych" (many)', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 10000 });
      expect(seq).toEqual(['prefix_card.mp3', 'do_zaplaty.mp3', '100.mp3', 'zloty_many.mp3']);
    });

    it('999 zł → "dziewięćset dziewięćdziesiąt dziewięć złotych"', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 99900 });
      expect(seq).toEqual(['prefix_card.mp3', 'do_zaplaty.mp3', '999.mp3', 'zloty_many.mp3']);
    });
  });

  describe('thousands', () => {
    it('1000 zł → "tysiąc złotych" (tysiąc alone, no jeden prefix)', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 100_000 });
      expect(seq).toEqual(['prefix_card.mp3', 'do_zaplaty.mp3', 'thousand_1.mp3', 'zloty_many.mp3']);
    });

    it('1234 zł → "tysiąc dwieście trzydzieści cztery złote"', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 123_400 });
      expect(seq).toEqual([
        'prefix_card.mp3', 'do_zaplaty.mp3',
        'thousand_1.mp3', '234.mp3',
        'zloty_few.mp3',
      ]);
    });

    it('2000 zł → "dwa tysiące złotych"', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 200_000 });
      expect(seq).toEqual([
        'prefix_card.mp3', 'do_zaplaty.mp3',
        '2.mp3', 'thousand_few.mp3',
        'zloty_many.mp3',
      ]);
    });

    it('5000 zł → "pięć tysięcy złotych"', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 500_000 });
      expect(seq).toEqual([
        'prefix_card.mp3', 'do_zaplaty.mp3',
        '5.mp3', 'thousand_many.mp3',
        'zloty_many.mp3',
      ]);
    });

    it('1001 zł → "tysiąc jeden złotych" (compound 1 → many)', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 100_100 });
      expect(seq).toEqual([
        'prefix_card.mp3', 'do_zaplaty.mp3',
        'thousand_1.mp3', '1.mp3',
        'zloty_many.mp3',
      ]);
    });
  });

  describe('grosze (sub-1 zł)', () => {
    it('1 gr → "jeden grosz" (singular)', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 1 });
      expect(seq).toEqual(['prefix_card.mp3', 'do_zaplaty.mp3', '1.mp3', 'grosz_1.mp3']);
    });

    it('2 gr → "dwa grosze" (few)', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 2 });
      expect(seq).toEqual(['prefix_card.mp3', 'do_zaplaty.mp3', '2.mp3', 'grosz_few.mp3']);
    });

    it('5 gr → "pięć groszy" (many)', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 5 });
      expect(seq).toEqual(['prefix_card.mp3', 'do_zaplaty.mp3', '5.mp3', 'grosz_many.mp3']);
    });

    it('12 gr → "dwanaście groszy" (12-14 → many)', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 12 });
      expect(seq).toEqual(['prefix_card.mp3', 'do_zaplaty.mp3', '12.mp3', 'grosz_many.mp3']);
    });

    it('50 gr → "pięćdziesiąt groszy"', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 50 });
      expect(seq).toEqual(['prefix_card.mp3', 'do_zaplaty.mp3', '50.mp3', 'grosz_many.mp3']);
    });

    it('99 gr → "dziewięćdziesiąt dziewięć groszy"', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 99 });
      expect(seq).toEqual(['prefix_card.mp3', 'do_zaplaty.mp3', '99.mp3', 'grosz_many.mp3']);
    });
  });

  describe('compound zł + gr amounts', () => {
    it('1.50 zł → "jeden złoty pięćdziesiąt groszy"', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 150 });
      expect(seq).toEqual([
        'prefix_card.mp3', 'do_zaplaty.mp3',
        '1.mp3', 'zloty_1.mp3',
        '50.mp3', 'grosz_many.mp3',
      ]);
    });

    it('12.34 zł → "dwanaście złotych trzydzieści cztery grosze"', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 1234 });
      expect(seq).toEqual([
        'prefix_card.mp3', 'do_zaplaty.mp3',
        '12.mp3', 'zloty_many.mp3',
        '34.mp3', 'grosz_few.mp3',
      ]);
    });

    it('1234.56 zł → "tysiąc dwieście trzydzieści cztery złote pięćdziesiąt sześć groszy"', () => {
      const seq = buildAnnouncementSequence({ method: 'CASH', totalGrosze: 123_456 });
      expect(seq).toEqual([
        'prefix_cash.mp3', 'do_zaplaty.mp3',
        'thousand_1.mp3', '234.mp3',
        'zloty_few.mp3',
        '56.mp3', 'grosz_many.mp3',
      ]);
    });
  });

  describe('edge cases', () => {
    it('0 grosze → defensive "zero złotych"', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 0 });
      expect(seq).toEqual(['prefix_card.mp3', 'do_zaplaty.mp3', '0.mp3', 'zloty_many.mp3']);
    });

    it('negative grosze → clamped to 0', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: -100 });
      expect(seq).toEqual(['prefix_card.mp3', 'do_zaplaty.mp3', '0.mp3', 'zloty_many.mp3']);
    });

    it('whole 1000 zł — no rest, no grosze', () => {
      const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: 100_000 });
      // No spurious '0.mp3' or empty number clip after thousand_1.mp3.
      expect(seq).not.toContain('0.mp3');
      expect(seq.filter((f) => f.endsWith('.mp3')).length).toBeGreaterThan(0);
    });

    it('sequence is always non-empty and starts with a prefix clip', () => {
      const samples = [0, 1, 99, 100, 999, 1000, 12345, 99999, 100000, 123456];
      for (const grosze of samples) {
        const seq = buildAnnouncementSequence({ method: 'CARD', totalGrosze: grosze });
        expect(seq.length).toBeGreaterThanOrEqual(3); // prefix + do_zaplaty + at least one part
        expect(seq[0]).toMatch(/^prefix_/);
        expect(seq[1]).toBe('do_zaplaty.mp3');
      }
    });

    it('every clip filename is a string ending with .mp3', () => {
      const seq = buildAnnouncementSequence({ method: 'CASH', totalGrosze: 987_654 });
      for (const clip of seq) {
        expect(typeof clip).toBe('string');
        expect(clip).toMatch(/\.mp3$/);
      }
    });
  });
});
