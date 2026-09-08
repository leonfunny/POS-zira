// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFeedbackDialog } from '../src/renderer/hooks/useFeedbackDialog';

describe('in-app feedback dialogs', () => {
  let host: HTMLDivElement;
  let root: Root;
  let feedback: ReturnType<typeof useFeedbackDialog>;
  function Harness() { feedback = useFeedbackDialog(); return <>{feedback.dialog}</>; }
  beforeEach(async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root.render(<Harness />));
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
  const click = async (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent === label)!;
    await act(async () => button.click());
  };
  it('only an explicit confirmation accepts the action', async () => {
    let decision!: Promise<boolean>;
    await act(async () => { decision = feedback.confirm('Delete the table?', true); });
    await click('Cancel'); expect(await decision).toBe(false);
    await act(async () => { decision = feedback.confirm('Delete the table?', true); });
    await click('Confirm'); expect(await decision).toBe(true);
  });
  it('Escape cancels and does not reach an older window shortcut', async () => {
    const parentClose = vi.fn(); window.addEventListener('keydown', parentClose);
    let decision!: Promise<boolean>;
    await act(async () => { decision = feedback.confirm('Check in?'); });
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(await decision).toBe(false); expect(parentClose).not.toHaveBeenCalled();
    window.removeEventListener('keydown', parentClose);
  });
  it('queues messages without replacing an unresolved confirmation', async () => {
    let first!: Promise<boolean>; let second!: Promise<boolean>;
    await act(async () => { first = feedback.confirm('First'); second = feedback.message('Second'); });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('First');
    await click('Cancel'); expect(await first).toBe(false);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Second');
    await click('Close'); expect(await second).toBe(true);
  });
  it('unmount cancels pending decisions', async () => {
    let decision!: Promise<boolean>;
    await act(async () => { decision = feedback.confirm('Delete?'); });
    await act(async () => root.render(null));
    expect(await decision).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
