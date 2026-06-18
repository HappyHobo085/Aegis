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
});
