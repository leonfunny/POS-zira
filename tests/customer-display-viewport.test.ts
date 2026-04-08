import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CustomerDisplayShell from '../src/renderer/windows/customer/components/CustomerDisplayShell';
import IdleView from '../src/renderer/windows/customer/views/IdleView';

const REPO_ROOT = path.resolve(__dirname, '..');

describe('Customer display viewport contract', () => {
  it('renders CustomerDisplayShell with fixed-height viewport wrappers', () => {
    const markup = renderToStaticMarkup(
      React.createElement(CustomerDisplayShell, {
        language: 'en',
        onLanguageChange: () => undefined,
        title: 'Walk-in',
        subtitle: 'Enter your name',
        children: React.createElement('div', null, 'content'),
      }),
    );

    expect(markup).toContain('relative h-screen overflow-hidden');
    expect(markup).toContain('relative z-10 flex h-full flex-col overflow-hidden');
    expect(markup).not.toContain('min-h-screen');
  });

  it('renders IdleView inside a fixed-height viewport shell', () => {
    const markup = renderToStaticMarkup(
      React.createElement(IdleView, {
        salonName: 'Zira AI',
      }),
    );

    expect(markup).toContain('h-screen');
    expect(markup).toContain('bg-gradient-to-br');
    expect(markup).not.toContain('min-h-screen');
  });

  it('scopes fixed-height root rules to the customer renderer entrypoint', () => {
    const entrySource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/windows/customer/main.tsx'),
      'utf8',
    );
    const cssSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/index.css'),
      'utf8',
    );

    expect(entrySource).toContain("document.documentElement.classList.add('customer-display-root')");
    expect(entrySource).toContain("document.body.classList.add('customer-display-root')");
    expect(cssSource).toContain('html.customer-display-root');
    expect(cssSource).toContain('html.customer-display-root body');
    expect(cssSource).toContain('html.customer-display-root body #root');
    expect(cssSource).toContain('overflow: hidden;');
  });

  it('removes min-height fallback wrappers from CustomerApp customer-display modes', () => {
    const appSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/windows/customer/CustomerApp.tsx'),
      'utf8',
    );

    expect(appSource).not.toContain('min-h-screen');
    expect(appSource).toContain('h-screen');
  });
});
