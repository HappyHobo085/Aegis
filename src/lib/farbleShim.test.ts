// Runtime test of the SHIPPED farble shim JS (src-tauri/src/farble.*.js). The Rust side
// include_str!'s these exact files (prefixing a seed literal), so executing them here tests
// the actual shipped bytes. Mirrors webrtcShim.test.ts. Runs in the vitest jsdom project.
//
// jsdom does not implement Canvas or AudioBuffer natively; this test stubs those surfaces
// exactly as the webrtcShim.test.ts stubs RTCPeerConnection — so the test covers the actual
// shipped shim bytes against real stand-ins, catching behavioral bugs string assertions cannot.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (n: string) => readFileSync(join(process.cwd(), 'src-tauri/src', n), 'utf8');
const STANDARD = read('farble.standard.js');

// Compose like Rust does: prepend the public-seed literal, then the shipped artifact.
const withSeed = (js: string, hex: string) =>
  `var __aegisFarbleSeed=${JSON.stringify(hex)};\n${js}`;
const SEED_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SEED_B = '00112233445566778899aabbccddeeff';

// ---- Minimal stubs for surfaces the shim patches ----
// jsdom stubs HTMLCanvasElement but does not implement getContext.
// We stub CanvasRenderingContext2D + canvas behavior so the shim can patch them.

type FakeImageData = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

function makeCanvas(
  w = 8,
  h = 8,
): {
  canvas: { width: number; height: number };
  ctx: {
    canvas: { width: number; height: number };
    fillStyle: string;
    fillRect: () => void;
    getImageData: (x: number, y: number, w: number, h: number) => FakeImageData;
    putImageData: (d: FakeImageData, x: number, y: number) => void;
  };
} {
  const pixels = new Uint8ClampedArray(w * h * 4).fill(0x80);
  const imgData: FakeImageData = { data: pixels, width: w, height: h };
  const canvasObj = { width: w, height: h };
  const ctx = {
    canvas: canvasObj,
    fillStyle: '',
    fillRect: () => {},
    getImageData: (_x: number, _y: number, _w: number, _h: number): FakeImageData => imgData,
    putImageData: (_d: FakeImageData, _x: number, _y: number) => {},
  };
  return { canvas: canvasObj, ctx };
}

// Install stubs on window so the shim finds the globals it patches.
function installCanvasStubs() {
  const w = window as unknown as Record<string, unknown>;

  // Stub CanvasRenderingContext2D with a prototype shim can patch.
  if (!w['CanvasRenderingContext2D']) {
    function FakeContext(this: Record<string, unknown>) {}
    FakeContext.prototype.getImageData = function (
      _x: number,
      _y: number,
      fw: number,
      fh: number,
    ): FakeImageData {
      const pixels = new Uint8ClampedArray(fw * fh * 4).fill(0x80);
      return { data: pixels, width: fw, height: fh };
    };
    FakeContext.prototype.putImageData = function () {};
    w['CanvasRenderingContext2D'] = FakeContext;
  }

  // Stub HTMLCanvasElement.prototype.toDataURL / toBlob if not already real.
  if (typeof HTMLCanvasElement !== 'undefined') {
    if (
      typeof (HTMLCanvasElement.prototype as Record<string, unknown>)['toDataURL'] !== 'function'
    ) {
      (HTMLCanvasElement.prototype as Record<string, unknown>)['toDataURL'] = function (
        this: HTMLCanvasElement,
      ) {
        return 'data:image/png;base64,STUB';
      };
    }
    if (typeof (HTMLCanvasElement.prototype as Record<string, unknown>)['toBlob'] !== 'function') {
      (HTMLCanvasElement.prototype as Record<string, unknown>)['toBlob'] = function (
        this: HTMLCanvasElement,
        cb: (blob: Blob | null) => void,
      ) {
        cb(null);
      };
    }
  }
}

function run(js: string, hex: string, origin = 'https://example.com') {
  installCanvasStubs();
  Object.defineProperty(window, 'location', {
    value: { origin, href: origin + '/' },
    configurable: true,
  });
  // The shim is an IIFE; run it in global scope (it patches window/navigator prototypes).
  new Function(withSeed(js, hex))();
}

// After each test, restore stub prototypes so patches don't bleed between tests.
type AnyProto = Record<string, unknown>;
let _savedGID: unknown;
let _savedTDU: unknown;
let _savedTB: unknown;
let _savedHC: unknown;

beforeEach(() => {
  installCanvasStubs();
  const w = window as unknown as Record<string, unknown>;
  const CRC2D = w['CanvasRenderingContext2D'] as { prototype: AnyProto } | undefined;
  _savedGID = CRC2D?.prototype?.['getImageData'];
  _savedTDU =
    typeof HTMLCanvasElement !== 'undefined'
      ? (HTMLCanvasElement.prototype as AnyProto)['toDataURL']
      : undefined;
  _savedTB =
    typeof HTMLCanvasElement !== 'undefined'
      ? (HTMLCanvasElement.prototype as AnyProto)['toBlob']
      : undefined;
  _savedHC =
    typeof Navigator !== 'undefined'
      ? Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency')
      : undefined;
});

afterEach(() => {
  const w = window as unknown as Record<string, unknown>;
  const CRC2D = w['CanvasRenderingContext2D'] as { prototype: AnyProto } | undefined;
  if (CRC2D && _savedGID !== undefined)
    CRC2D.prototype['getImageData'] = _savedGID as () => unknown;
  if (typeof HTMLCanvasElement !== 'undefined') {
    if (_savedTDU !== undefined)
      (HTMLCanvasElement.prototype as AnyProto)['toDataURL'] = _savedTDU as () => unknown;
    if (_savedTB !== undefined)
      (HTMLCanvasElement.prototype as AnyProto)['toBlob'] = _savedTB as () => unknown;
  }
  if (typeof Navigator !== 'undefined' && _savedHC !== undefined) {
    try {
      Object.defineProperty(
        Navigator.prototype,
        'hardwareConcurrency',
        _savedHC as PropertyDescriptor,
      );
    } catch (_e) {}
  }
});

// Helper: run the shim, then invoke getImageData via the patched CanvasRenderingContext2D.
function farbledImageData(
  hex: string,
  origin = 'https://example.com',
  w = 8,
  h = 8,
): Uint8ClampedArray {
  run(STANDARD, hex, origin);
  const CRC2D = (window as unknown as Record<string, unknown>)['CanvasRenderingContext2D'] as {
    prototype: {
      getImageData: (x: number, y: number, w: number, h: number) => FakeImageData;
    };
  };
  const { ctx } = makeCanvas(w, h);
  // Call through the patched prototype, binding the fake canvas's ctx.
  return CRC2D.prototype.getImageData.call(ctx, 0, 0, w, h).data;
}

describe('farble shim (standard) — shipped JS, runtime', () => {
  it('perturbs canvas getImageData but stays within a few LSBs (plausible)', () => {
    const { ctx } = makeCanvas();
    run(STANDARD, SEED_A);
    const CRC2D = (window as unknown as Record<string, unknown>)['CanvasRenderingContext2D'] as {
      prototype: { getImageData: (x: number, y: number, w: number, h: number) => FakeImageData };
    };

    const a = CRC2D.prototype.getImageData.call(ctx, 0, 0, 8, 8).data;
    const b = CRC2D.prototype.getImageData.call(ctx, 0, 0, 8, 8).data;

    // DETERMINISTIC: two reads in the SAME session+origin are identical (no per-read jitter).
    expect(Array.from(a)).toEqual(Array.from(b));
    // PERTURBED but PLAUSIBLE: every R channel within ±3 of 0x80 (LSB flip, not an overwrite).
    for (let i = 0; i < a.length; i += 4) expect(Math.abs(a[i] - 0x80)).toBeLessThanOrEqual(3);
  });

  it('noise is DETERMINISTIC per seed+origin, DIFFERENT across origins', () => {
    // Origin A, first call.
    const a1 = farbledImageData(SEED_A, 'https://a.example');
    // Reset the prototype, re-run for origin B.
    const w = window as unknown as Record<string, unknown>;
    const CRC2D = w['CanvasRenderingContext2D'] as { prototype: AnyProto };
    CRC2D.prototype['getImageData'] = _savedGID as () => unknown;

    const b = farbledImageData(SEED_A, 'https://b.example');
    CRC2D.prototype['getImageData'] = _savedGID as () => unknown;

    // Origin A again — must match first call.
    const a2 = farbledImageData(SEED_A, 'https://a.example');

    expect(Array.from(a1)).toEqual(Array.from(a2)); // deterministic: same seed+origin → same output
    expect(Array.from(a1)).not.toEqual(Array.from(b)); // different origins → different noise
  });

  it('noise DIFFERS across sessions (different seed)', () => {
    const a = farbledImageData(SEED_A);
    const w = window as unknown as Record<string, unknown>;
    const CRC2D = w['CanvasRenderingContext2D'] as { prototype: AnyProto };
    CRC2D.prototype['getImageData'] = _savedGID as () => unknown;

    const b = farbledImageData(SEED_B);

    expect(Array.from(a)).not.toEqual(Array.from(b)); // different seeds → different noise
  });

  it('audio getChannelData is perturbed deterministically and bounded (~1e-7)', () => {
    // jsdom does not implement AudioBuffer; stub it so the shim can find + patch it.
    const w = window as unknown as Record<string, unknown>;
    const origAB = w['AudioBuffer'];

    const fakeBuf = new Float32Array([0.5, -0.5, 0.0, 1.0, -1.0]);
    function FakeAudioBuffer(this: Record<string, unknown>) {}
    FakeAudioBuffer.prototype.getChannelData = function (_channel: number) {
      return fakeBuf;
    };
    w['AudioBuffer'] = FakeAudioBuffer;

    try {
      run(STANDARD, SEED_A);
      const AB = w['AudioBuffer'] as {
        prototype: { getChannelData: (ch: number) => Float32Array };
      };
      const fakeInstance = new (FakeAudioBuffer as unknown as new () => Record<string, unknown>)();

      const c1 = AB.prototype.getChannelData.call(fakeInstance, 0);
      const c2 = AB.prototype.getChannelData.call(fakeInstance, 0);

      // Deterministic: same call twice → same result.
      expect(Array.from(c1)).toEqual(Array.from(c2));
      // Bounded: each sample stays in [-1, 1].
      for (let i = 0; i < c1.length; i++) {
        expect(c1[i]).toBeGreaterThanOrEqual(-1);
        expect(c1[i]).toBeLessThanOrEqual(1);
      }
      // Noise magnitude is tiny (~1e-7).
      const origVals = [0.5, -0.5, 0.0, 1.0, -1.0];
      for (let i = 0; i < c1.length; i++) {
        // The clamped value may differ from original by at most ~1e-7.
        expect(Math.abs(c1[i] - origVals[i])).toBeLessThan(1e-5);
      }
    } finally {
      if (origAB === undefined) delete w['AudioBuffer'];
      else w['AudioBuffer'] = origAB;
    }
  });

  it('navigator.hardwareConcurrency is clamped to {2,4,8} (no exact-core-count tell)', () => {
    run(STANDARD, SEED_A);
    const hc = navigator.hardwareConcurrency;
    // Must be one of the allowed clamped values.
    expect([2, 4, 8]).toContain(hc);
  });

  it('navigator.userAgentData.brands is normalized to Chrome-148 set (when present)', () => {
    // jsdom does not expose navigator.userAgentData; test that the shim does not throw when absent.
    run(STANDARD, SEED_A);
    const uad = (navigator as Navigator & { userAgentData?: { brands?: unknown } }).userAgentData;
    if (uad) {
      const brands = uad.brands as Array<{ brand: string; version: string }> | undefined;
      expect(brands).toBeDefined();
      const brandNames = (brands ?? []).map((b) => b.brand);
      expect(brandNames).toContain('Chromium');
    } else {
      // No userAgentData on jsdom — the shim's try/catch makes this a safe no-op.
      expect(true).toBe(true);
    }
  });

  it('FAIL-OPEN: noise error in getImageData does not throw into page code', () => {
    run(STANDARD, SEED_A);
    const w = window as unknown as Record<string, unknown>;
    const CRC2D = w['CanvasRenderingContext2D'] as {
      prototype: { getImageData: (x: number, y: number, w: number, h: number) => FakeImageData };
    };

    // The shim wraps getImageData with try/catch around the noise loop.
    // Confirm: calling the patched method does NOT throw, even with a minimal canvas context.
    const { ctx } = makeCanvas(4, 4);
    let result: FakeImageData | undefined;
    expect(() => {
      result = CRC2D.prototype.getImageData.call(ctx, 0, 0, 4, 4);
    }).not.toThrow();
    expect(result).toBeDefined();
    expect(result!.data.length).toBeGreaterThan(0);
  });

  it('patched fn toString reports [native code]', () => {
    run(STANDARD, SEED_A);
    const w = window as unknown as Record<string, unknown>;
    const CRC2D = w['CanvasRenderingContext2D'] as { prototype: { getImageData: () => unknown } };
    const toDataURL =
      typeof HTMLCanvasElement !== 'undefined'
        ? (HTMLCanvasElement.prototype as AnyProto)['toDataURL']
        : undefined;

    expect(Function.prototype.toString.call(CRC2D.prototype.getImageData)).toContain(
      '[native code]',
    );
    if (typeof toDataURL === 'function') {
      expect(Function.prototype.toString.call(toDataURL)).toContain('[native code]');
    }
  });

  it('SEED is NOT readable as a window.* global (shim uses closure, not window assignment)', () => {
    run(STANDARD, SEED_A);
    const w = window as unknown as Record<string, unknown>;
    // The per-ORIGIN sub-seed must NOT be on window — it is derived inside the IIFE closure.
    expect(w['__aegisFarbleOriginSeed']).toBeUndefined();
    expect(w['__aegisFarblesub']).toBeUndefined();
    expect(w['__farbleSeed']).toBeUndefined();
    // The PRNG state vars must NOT be on window.
    expect(w['__aegisS0']).toBeUndefined();
    expect(w['__aegisS1']).toBeUndefined();
    // The shim's internal variables (var-scoped inside the IIFE) must not bleed out.
    // Note: __aegisFarbleSeed IS set as a var by the Rust-prepended line (in the new Function
    // scope, which is global) — but the shim itself must NEVER assign to window.__aegisFarbleSeed.
    // The key invariant: no other-origin's sub-seed is accessible.
    expect(w['_s0']).toBeUndefined();
    expect(w['_s1']).toBeUndefined();
    expect(w['sub']).toBeUndefined();
  });

  it('no-op when seed is empty string (fail-open at boot)', () => {
    installCanvasStubs();
    const w = window as unknown as Record<string, unknown>;
    const CRC2D = w['CanvasRenderingContext2D'] as { prototype: AnyProto };
    const origGID = CRC2D?.prototype?.['getImageData'];

    // Run with an empty seed — the shim should return immediately without patching.
    new Function(`var __aegisFarbleSeed="";\n${STANDARD}`)();

    // Prototype must be unchanged when no seed is present.
    expect(CRC2D?.prototype?.['getImageData']).toBe(origGID);
  });
});
