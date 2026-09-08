// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import ImageWithFallback from '../src/renderer/components/shared/ImageWithFallback';
vi.mock('../src/renderer/windows/customer/components/CustomerDisplayShell', () => ({ default: ({ children }: any) => <>{children}</> }));
import CustomerCatalogView from '../src/renderer/windows/customer/views/CustomerCatalogView';

it('falls back on failure and retries changed, removed and returning sources', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const render = async (src?: string) => { await act(async () => root.render(<ImageWithFallback src={src} alt="Category" fallback={<span>Placeholder</span>} />)); };
  try {
    await render('broken.jpg');
    await act(async () => host.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(host.textContent).toBe('Placeholder'); expect(host.querySelector('img')).toBeNull();
    await render('replacement.jpg'); expect(host.querySelector('img')?.getAttribute('src')).toBe('replacement.jpg');
    await render('broken.jpg'); expect(host.querySelector('img')?.getAttribute('src')).toBe('broken.jpg');
    await render(); expect(host.textContent).toBe('Placeholder');
    await render('broken.jpg'); expect(host.querySelector('img')).not.toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('retains the customer catalog name and price when its photo fails', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    const categories: any = [{ id: 'category', name: 'Drinks', section: 'food', services: [{ id: 'tea', name: 'Tea', price: 10, imageUrl: 'bad.jpg' }] }];
    await act(async () => root.render(<CustomerCatalogView categories={categories} language="en" t={key => key} onBack={() => {}} onLanguageChange={() => {}} />));
    const before = host.textContent;
    await act(async () => host.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(host.querySelector('img')).toBeNull(); expect(host.querySelector('svg')).not.toBeNull();
    expect(host.textContent).toBe(before); expect(host.textContent).toContain('Tea');
  } finally { await act(async () => root.unmount()); host.remove(); }
});
