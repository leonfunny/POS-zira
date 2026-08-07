// @vitest-environment happy-dom
/**
 * The Android staff login field must accept a bare username, not only an email.
 *
 * Same defect the desktop AuthScreen carried: the field was `type="email"`, so
 * the WebView failed constraint validation and never submitted — the request
 * never left the tablet. The backend accepts an email, a phone number or a
 * plain username alike; LoginDto validates none of those shapes.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LoginScreen from '../src/renderer/android-pos/LoginScreen';

const loginWithEmail = vi.fn();

let container: HTMLDivElement;
let root: Root;
const previousElectronAPI = (globalThis as any).electronAPI;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  loginWithEmail.mockReset();
  loginWithEmail.mockResolvedValue({ success: true });
  (globalThis as any).electronAPI = { auth: { loginWithEmail } };

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  (globalThis as any).electronAPI = previousElectronAPI;
});

async function renderScreen(onLoggedIn = vi.fn()) {
  await act(async () => {
    root.render(<LoginScreen onLoggedIn={onLoggedIn} />);
  });
  return onLoggedIn;
}

function query<T extends Element>(selector: string): T {
  const element = container.querySelector<T>(selector);
  if (!element) throw new Error(`${selector} was not rendered`);
  return element;
}

const identifier = () => query<HTMLInputElement>('input[autocomplete="username"]');

/** Drive a React-controlled input the way a keystroke would. */
async function type(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  await act(async () => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('android staff login identifier field', () => {
  it('is not constrained to an email address', async () => {
    await renderScreen();

    expect(identifier().getAttribute('type')).toBe('text');
  });

  it('passes a bare username through to the login call', async () => {
    const onLoggedIn = await renderScreen();

    await type(identifier(), 'baohan');
    await type(query<HTMLInputElement>('input[type="password"]'), 'Baohan1234!');

    // The heart of the bug: a username has to be a *valid* value for the field,
    // or the WebView blocks submission before any handler runs.
    expect(identifier().checkValidity()).toBe(true);

    // requestSubmit(), unlike dispatching a bare submit event, runs constraint
    // validation first — so this exercises the path the user actually hits.
    await act(async () => {
      query<HTMLFormElement>('form').requestSubmit();
    });

    expect(loginWithEmail).toHaveBeenCalledWith('baohan', 'Baohan1234!');
    expect(onLoggedIn).toHaveBeenCalled();
  });

  it('still rejects an empty identifier', async () => {
    await renderScreen();

    // `required` must survive the type change, or the form would submit blanks.
    expect(identifier().checkValidity()).toBe(false);
  });
});
