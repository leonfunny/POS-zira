// @vitest-environment happy-dom
/**
 * The image-free tile wall (decision D4 of the Dotykačka brief).
 *
 * Dotykačka shows no product photography at all — its display settings have no
 * image option — and colour is the identifier the cashier navigates by. Retail
 * adopts that; salon keeps service photos, so the flag has to actually switch
 * behaviour rather than being decorative.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import React from 'react';

import ProductCard from '../src/renderer/components/pos/ProductCard';

const PRODUCT = {
  id: 'p1', template_id: 't1', name: 'Gel Polish', sku: 'SKU-1', barcode: null,
  retail_price: 4900, category_id: 'c1', image_url: 'https://example.test/p1.jpg',
  thumbnail_url: 'https://example.test/p1-thumb.jpg', in_stock: 10, available_qty: 10,
  vat_rate: 23, is_active: 1, is_on_sale: 0, sale_unit: 'pc', sell_by: 'PIECE',
  updated_at: null, track_inventory: 1,
} as any;

let host: HTMLDivElement;
let root: Root;

function render(props: Record<string, unknown>) {
  act(() => {
    root.render(React.createElement(ProductCard, {
      product: PRODUCT, onAdd: () => {}, t: (k: string) => k, ...props,
    } as any));
  });
  return host;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('product tile wall', () => {
  test('imagesEnabled=false renders no <img> at all', () => {
    const el = render({ imagesEnabled: false });
    expect(el.querySelector('img')).toBeNull();
  });

  test('the colour-block tile still shows the name and the price', () => {
    const text = render({ imagesEnabled: false }).textContent ?? '';
    expect(text).toContain('Gel Polish');
    expect(text).toContain('49.00');
  });

  test('the tile carries the flat geometry class and an inline colour', () => {
    const tile = render({ imagesEnabled: false }).querySelector('.pos-tile') as HTMLElement | null;
    expect(tile, 'tile root should carry .pos-tile').toBeTruthy();
    // Colour is per product, applied inline — that is what makes the wall
    // memorisable by position.
    expect(tile!.style.background).toBeTruthy();
    expect(tile!.style.color).toBeTruthy();
  });

  test('no aspect-* utility on the image-free tile (Chromium 83 ignores it)', () => {
    const html = render({ imagesEnabled: false }).innerHTML;
    expect(html).not.toMatch(/\baspect-/);
  });

  test('salon keeps its photos: the default still renders the image well', () => {
    const el = render({});
    expect(el.querySelector('img')).not.toBeNull();
  });

  test('the tile label flips to dark ink on a light background', () => {
    // Deterministic per name, so assert the contract rather than a fixed hex:
    // whatever colour a product draws, its ink must be one of the two chosen
    // by luminance, never an unreadable mid-tone.
    for (const name of ['Gel Polish', 'Manicure', 'Pedicure', 'Nail Art', 'Cappuccino']) {
      const el = render({ imagesEnabled: false, product: { ...PRODUCT, name } });
      // happy-dom keeps the authored hex; a browser would report rgb().
      const ink = (el.querySelector('.pos-tile') as HTMLElement).style.color.toLowerCase();
      expect(['#1a1915', 'rgb(26, 25, 21)', '#ffffff', 'rgb(255, 255, 255)']).toContain(ink);
    }
  });
});
