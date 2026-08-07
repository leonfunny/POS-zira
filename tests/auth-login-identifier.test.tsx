// @vitest-environment happy-dom
/**
 * The desktop login field must accept a bare username, not only an email.
 *
 * Regression guard: the field was `<input type="email">`, so Chromium refused to
 * submit "baohan" with "Please include an '@' in the email address" and the
 * request never left the machine. The backend accepts an email, a phone number
 * or a plain username alike — LoginDto validates none of those shapes — and the
 * web login has always used a text field for exactly that reason.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AuthScreen from '../src/renderer/components/AuthScreen';

const loginWithEmail = vi.fn();
const generateLoginToken = vi.fn();

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  loginWithEmail.mockReset();
  generateLoginToken.mockReset();
  // The Telegram QR half of the screen boots on mount; keep it inert.
  generateLoginToken.mockResolvedValue({ success: false, error: 'offline' });
  loginWithEmail.mockResolvedValue({
    success: true,
    data: { user: { id: 'user-1', email: 'baohan' } },
  });

  (window as any).electronAPI = {
    auth: {
      generateLoginToken,
      generateRegisterToken: vi.fn().mockResolvedValue({ success: false }),
      checkToken: vi.fn().mockResolvedValue({ success: false }),
      loginWithEmail,
    },
  };

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  delete (window as any).electronAPI;
});

async function renderScreen(onLoginSuccess = vi.fn()) {
  await act(async () => {
    root.render(<AuthScreen onLoginSuccess={onLoginSuccess} />);
  });
  return onLoginSuccess;
}

function query<T extends Element>(selector: string): T {
  const element = container.querySelector<T>(selector);
  if (!element) throw new Error(`${selector} was not rendered`);
  return element;
}

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

describe('desktop login identifier field', () => {
  it('is not constrained to an email address', async () => {
    await renderScreen();

    const input = query<HTMLInputElement>('#auth-email');

    // The whole bug in one assertion.
    expect(input.getAttribute('type')).toBe('text');
    expect(input.getAttribute('autocomplete')).toBe('username');
  });

  it('passes a bare username through to the login call', async () => {
    const onLoginSuccess = await renderScreen();

    await type(query<HTMLInputElement>('#auth-email'), 'baohan');
    await type(query<HTMLInputElement>('#auth-password'), 'Baohan1234!');

    const submit = query<HTMLButtonElement>('button[type="submit"]');
    expect(submit.disabled).toBe(false);

    // The heart of the bug: a username has to be a *valid* value for the field,
    // or the browser blocks submission before any handler runs.
    expect(query<HTMLInputElement>('#auth-email').checkValidity()).toBe(true);

    // requestSubmit(), unlike dispatching a bare submit event, runs constraint
    // validation first — so this exercises the path the user actually hits.
    await act(async () => {
      query<HTMLFormElement>('form').requestSubmit();
    });

    expect(loginWithEmail).toHaveBeenCalledWith('baohan', 'Baohan1234!');
    expect(onLoginSuccess).toHaveBeenCalled();
  });
});
