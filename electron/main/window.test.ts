// electron/main/window.test.ts
import { describe, it, expect, vi } from 'vitest';
import { layout, FULLSCREEN_CORNER } from './window';
import { CHROME_TOP_HEIGHT } from './constants';

/** A fake BaseWindow exposing only getContentBounds. */
function makeWin(width: number, height: number) {
  return { getContentBounds: () => ({ x: 0, y: 0, width, height }) } as any;
}

/** A fake WebContentsView capturing the last setBounds call. */
function makeView() {
  const calls: Array<{ x: number; y: number; width: number; height: number }> = [];
  return {
    calls,
    setBounds: vi.fn((b: { x: number; y: number; width: number; height: number }) => {
      calls.push(b);
    }),
  } as any;
}

describe('layout', () => {
  it('sets chrome to the full window bounds', () => {
    const win = makeWin(1000, 800);
    const chrome = makeView();
    layout(win, chrome);
    expect(chrome.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1000, height: 800 });
  });

  it('defaults the content inset to { top: CHROME_TOP_HEIGHT, left: 0 } when none is given', () => {
    const win = makeWin(1000, 800);
    const chrome = makeView();
    const content = makeView();
    layout(win, chrome, content);
    expect(content.setBounds).toHaveBeenCalledWith({
      x: 0,
      y: CHROME_TOP_HEIGHT,
      width: 1000,
      height: 800 - CHROME_TOP_HEIGHT,
    });
  });

  it('positions content using a provided inset (top + left)', () => {
    const win = makeWin(1000, 800);
    const chrome = makeView();
    const content = makeView();
    layout(win, chrome, content, { inset: { top: 96, left: 280 } });
    expect(content.setBounds).toHaveBeenCalledWith({
      x: 280,
      y: 96,
      width: 1000 - 280,
      height: 800 - 96,
    });
    // Chrome stays full-window regardless of the inset.
    expect(chrome.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1000, height: 800 });
  });

  it('fullscreen: content fills the window and chrome shrinks to the top-right corner', () => {
    const win = makeWin(1000, 800);
    const chrome = makeView();
    const content = makeView();
    layout(win, chrome, content, { fullscreen: true });
    // Content fills the whole window.
    expect(content.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1000, height: 800 });
    // Chrome is a small top-right corner that holds the exit button.
    expect(chrome.setBounds).toHaveBeenCalledWith({
      x: 1000 - FULLSCREEN_CORNER,
      y: 0,
      width: FULLSCREEN_CORNER,
      height: FULLSCREEN_CORNER,
    });
  });

  it('does not touch the content view when none is given', () => {
    const win = makeWin(640, 480);
    const chrome = makeView();
    expect(() => layout(win, chrome)).not.toThrow();
    expect(chrome.setBounds).toHaveBeenCalledTimes(1);
  });
});
