// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import DateField from '../src/renderer/components/label/DateField';

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('DateField — the order date in the app language', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let onChange: Mock<(iso: string) => void>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    onChange = vi.fn();
  });

  afterEach(async () => {
    if (root) {
      const current = root;
      await act(async () => current.unmount());
      root = null;
    }
    container.remove();
  });

  async function render(language: string, value = '2026-09-04') {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <DateField value={value} onChange={onChange} language={language} testId="order-date" label="Date" />,
      );
    });
    await settle();
  }

  const field = () => container.querySelector<HTMLButtonElement>('[data-testid="order-date"]')!;
  const calendar = () => container.querySelector('[data-testid="order-date-calendar"]');
  const month = () => container.querySelector('[data-testid="order-date-month"]')?.textContent ?? '';
  const click = async (selector: string) => {
    await act(async () => container.querySelector<HTMLButtonElement>(selector)!.click());
  };

  it.each([
    ['vi', '04/09/2026', 'tháng 9'],
    ['pl', '04.09.2026', 'wrzesień'],
    ['en', '04/09/2026', 'September'],
  ])('in %s reads %s and opens on %s', async (language, text, monthName) => {
    await render(language);
    expect(field().textContent).toContain(text);
    expect(field().dataset.value).toBe('2026-09-04');
    expect(calendar()).toBeNull();

    await click('[data-testid="order-date"]');
    expect(month().toLowerCase()).toContain(monthName.toLowerCase());
  });

  it('starts the week on Monday and marks the sheet date', async () => {
    await render('vi');
    await click('[data-testid="order-date"]');
    const days = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="order-date-day"]'));
    expect(days[0].dataset.iso).toBe('2026-08-31');
    expect(days.find((day) => day.dataset.iso === '2026-09-04')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('hands back the picked day as ISO and closes', async () => {
    await render('vi');
    await click('[data-testid="order-date"]');
    await click('[data-testid="order-date-day"][data-iso="2026-09-15"]');
    expect(onChange).toHaveBeenCalledWith('2026-09-15');
    expect(calendar()).toBeNull();
  });

  it('steps through the months without losing the year', async () => {
    await render('en', '2026-12-20');
    await click('[data-testid="order-date"]');
    await click('[data-testid="order-date-next"]');
    expect(month()).toBe('January 2027');
    await click('[data-testid="order-date-prev"]');
    await click('[data-testid="order-date-prev"]');
    expect(month()).toBe('November 2026');
  });

  it('reopens on the month of the sheet date, not the one last browsed', async () => {
    await render('en');
    await click('[data-testid="order-date"]');
    await click('[data-testid="order-date-next"]');
    await click('[data-testid="order-date-next"]');
    expect(month()).toBe('November 2026');
    await click('[data-testid="order-date"]');
    expect(calendar()).toBeNull();
    await click('[data-testid="order-date"]');
    expect(month()).toBe('September 2026');
  });

  it('offers today, and closes on Escape', async () => {
    await render('pl', '2020-01-01');
    await click('[data-testid="order-date"]');
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(calendar()).toBeNull();

    await click('[data-testid="order-date"]');
    await click('[data-testid="order-date-today"]');
    const today = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    expect(onChange).toHaveBeenCalledWith(
      `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
    );
  });

  it('shows a prompt rather than a broken date when the sheet has none', async () => {
    await render('vi', '');
    expect(field().textContent).toContain('Chọn ngày');
    expect(field().dataset.value).toBe('');
  });
});
