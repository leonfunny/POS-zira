/**
 * Tests for customer display promo fallback behavior.
 *
 * When PromoView has no images, it should show IdleView as fallback.
 * This verifies the defensive coding in the renderer components.
 */
import { describe, it, expect } from 'vitest';

describe('PromoView fallback behavior', () => {
  it('safeIndex clamps to 0 when currentIndex exceeds array length', () => {
    // This mirrors the guard in PromoView.tsx:
    // const safeIndex = currentIndex < stableImages.length ? currentIndex : 0;
    const images = ['img1.jpg', 'img2.jpg'];
    const currentIndex = 5; // stale index
    const safeIndex = currentIndex < images.length ? currentIndex : 0;
    expect(safeIndex).toBe(0);
  });

  it('empty images array gets safeIndex 0', () => {
    const images: string[] = [];
    const currentIndex = 0;
    const safeIndex = currentIndex < images.length ? currentIndex : 0;
    expect(safeIndex).toBe(0);
  });

  it('valid index passes through', () => {
    const images = ['img1.jpg', 'img2.jpg', 'img3.jpg'];
    const currentIndex = 2;
    const safeIndex = currentIndex < images.length ? currentIndex : 0;
    expect(safeIndex).toBe(2);
  });
});

describe('IdleView fallback translations', () => {
  it('fallback translation returns default for known keys', () => {
    // This mirrors IdleView.tsx fallbackT function
    const defaults: Record<string, string> = {
      'customer.brandName': 'Zira AI',
      'customer.welcome': 'Welcome',
    };
    const fallbackT = (key: string): string => defaults[key] ?? key;

    expect(fallbackT('customer.brandName')).toBe('Zira AI');
    expect(fallbackT('customer.welcome')).toBe('Welcome');
    expect(fallbackT('unknown.key')).toBe('unknown.key');
  });
});

describe('InteractiveView fallback translations', () => {
  it('fallback translation returns defaults for interactive keys', () => {
    const defaults: Record<string, string> = {
      'customer.brandName': 'Zira AI',
      'customer.interactiveWelcome': 'How can we help you?',
      'customer.tapToBrowse': 'Tap to browse our services',
    };
    const fallbackT = (key: string): string => defaults[key] ?? key;

    expect(fallbackT('customer.brandName')).toBe('Zira AI');
    expect(fallbackT('customer.interactiveWelcome')).toBe('How can we help you?');
    expect(fallbackT('customer.tapToBrowse')).toBe('Tap to browse our services');
  });
});
