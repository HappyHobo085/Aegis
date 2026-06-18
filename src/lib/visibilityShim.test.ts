import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect, vi } from 'vitest';

const shimSrc = readFileSync(
  resolve(__dirname, '../../src-tauri/src/visibility_shim.js'),
  'utf8',
);

function runShim() {
  // Execute the SHIPPED shim bytes against the jsdom globals (authoritative).
  new Function(shimSrc)();
}

describe('visibility shim', () => {
  it('forces document.visibilityState=visible and hidden=false', () => {
    runShim();
    expect(document.visibilityState).toBe('visible');
    expect(document.hidden).toBe(false);
  });

  it('swallows visibilitychange listeners so page handlers never fire', () => {
    runShim();
    const handler = vi.fn();
    document.addEventListener('visibilitychange', handler);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('reports the window as always focused', () => {
    runShim();
    expect(document.hasFocus()).toBe(true);
  });

  it('swallows window-level blur/focus listeners but leaves element focus intact', () => {
    runShim();
    const winBlur = vi.fn();
    const winFocus = vi.fn();
    window.addEventListener('blur', winBlur);
    window.addEventListener('focus', winFocus);
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    expect(winBlur).not.toHaveBeenCalled();
    expect(winFocus).not.toHaveBeenCalled();

    // Element-level blur/focus must still work (forms rely on it).
    const input = document.createElement('input');
    document.body.appendChild(input);
    const elBlur = vi.fn();
    input.addEventListener('blur', elBlur);
    input.dispatchEvent(new Event('blur'));
    expect(elBlur).toHaveBeenCalledTimes(1);
    input.remove();
  });
});
