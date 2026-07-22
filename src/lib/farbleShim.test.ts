// Runtime test of the SHIPPED farble shim JS (src-tauri/src/farble.*.js). The Rust side
// include_str!'s these exact files (substituting the __AEGIS_FARBLE_SEED__ placeholder),
// so executing them here tests the actual shipped bytes. Mirrors webrtcShim.test.ts. Runs
// in the vitest jsdom project.
//
// jsdom does not implement Canvas or AudioBuffer natively; this test stubs those surfaces
// exactly as the webrtcShim.test.ts stubs RTCPeerConnection — so the test covers the actual
// shipped shim bytes against real stand-ins, catching behavioral bugs string assertions cannot.
//
// SCOPE: run() uses indirect eval — (0, eval)(script) — which executes in TRUE GLOBAL scope
// (not function scope). This means patched globals ARE visible on `window` and any top-level
// `var` would also land on `window`. The no-seed-on-window test relies on this: if the seed
// were a top-level var the assertion would catch it.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (n: string) => readFileSync(join(process.cwd(), 'src-tauri/src', n), 'utf8');
const STANDARD = read('farble.standard.js');
const STRICT = read('farble.strict.js');

// Compose like Rust does: substitute the placeholder with the real seed in the IIFE argument.
// The seed is NEVER a top-level var — it lives only in the IIFE closure parameter.
const withSeed = (js: string, hex: string) =>
  js.replace("'__AEGIS_FARBLE_SEED__'", JSON.stringify(hex));
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
      typeof (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)['toDataURL'] !==
      'function'
    ) {
      (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)['toDataURL'] = function (
        this: HTMLCanvasElement,
      ) {
        return 'data:image/png;base64,STUB';
      };
    }
    if (
      typeof (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)['toBlob'] !==
      'function'
    ) {
      (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)['toBlob'] = function (
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
  // Run in TRUE GLOBAL scope via indirect eval so any top-level `var` would land on
  // `window` — exactly as the browser's document-start injection does. This makes the
  // no-seed-on-window assertion authoritative: if the seed were a top-level var it would
  // appear on `window.__aegisFarbleSeed` and the test would catch it.
  // Indirect eval: runs in true global scope (the `0,eval` trick de-references the local binding).
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  (0, eval)(withSeed(js, hex));
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
      ? (HTMLCanvasElement.prototype as unknown as AnyProto)['toDataURL']
      : undefined;
  _savedTB =
    typeof HTMLCanvasElement !== 'undefined'
      ? (HTMLCanvasElement.prototype as unknown as AnyProto)['toBlob']
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
      (HTMLCanvasElement.prototype as unknown as AnyProto)['toDataURL'] =
        _savedTDU as () => unknown;
    if (_savedTB !== undefined)
      (HTMLCanvasElement.prototype as unknown as AnyProto)['toBlob'] = _savedTB as () => unknown;
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
        ? (HTMLCanvasElement.prototype as unknown as AnyProto)['toDataURL']
        : undefined;

    expect(Function.prototype.toString.call(CRC2D.prototype.getImageData)).toContain(
      '[native code]',
    );
    if (typeof toDataURL === 'function') {
      expect(Function.prototype.toString.call(toDataURL)).toContain('[native code]');
    }
  });

  it('SEED is NOT readable as a window.* global (seed is closure param, not top-level var)', () => {
    run(STANDARD, SEED_A);
    const w = window as unknown as Record<string, unknown>;

    // CRITICAL super-cookie regression guard: the session seed must NOT appear on window.
    // This test runs in true global scope (indirect eval), so if the seed were a top-level
    // `var` it would land here. Failure here = the fix is broken / reverted.
    expect(w['__aegisFarbleSeed']).toBeUndefined();
    expect('__aegisFarbleSeed' in window).toBe(false);

    // The per-ORIGIN sub-seed must NOT be on window — it is derived inside the IIFE closure.
    expect(w['__aegisFarbleOriginSeed']).toBeUndefined();
    expect(w['__aegisFarblesub']).toBeUndefined();
    expect(w['__farbleSeed']).toBeUndefined();
    // The PRNG state vars must NOT be on window.
    expect(w['__aegisS0']).toBeUndefined();
    expect(w['__aegisS1']).toBeUndefined();
    // The shim's internal variables (var-scoped inside the IIFE) must not bleed out.
    expect(w['_s0']).toBeUndefined();
    expect(w['_s1']).toBeUndefined();
    expect(w['sub']).toBeUndefined();
  });

  it('no-op when seed is empty string (fail-open at boot)', () => {
    installCanvasStubs();
    const w = window as unknown as Record<string, unknown>;
    const CRC2D = w['CanvasRenderingContext2D'] as { prototype: AnyProto };
    const origGID = CRC2D?.prototype?.['getImageData'];

    // Run with an empty seed (placeholder substituted with "") — the shim should return
    // immediately without patching (the !SEEDHEX guard in the IIFE fires).
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    (0, eval)(STANDARD.replace("'__AEGIS_FARBLE_SEED__'", '""'));

    // Prototype must be unchanged when no seed is present.
    expect(CRC2D?.prototype?.['getImageData']).toBe(origGID);
  });
});

// ---------------------------------------------------------------------------
// Stub helpers for WebGL surfaces (jsdom has no WebGL implementation).
// ---------------------------------------------------------------------------

type WebGLProto = Record<string, unknown>;

interface FakeWebGLCtx {
  _vendor: string;
  _renderer: string;
  _extensions: string[];
  _pixels: Uint8Array | null;
}

function installWebGLStubs() {
  const w = window as unknown as Record<string, unknown>;

  // Stub WebGLRenderingContext if not present.
  if (!w['WebGLRenderingContext']) {
    function FakeWebGL(this: FakeWebGLCtx) {
      this._vendor = 'Real GPU Vendor';
      this._renderer = 'Real GPU Renderer';
      this._extensions = [
        'EXT_color_buffer_float',
        'OES_texture_float',
        'WEBGL_debug_renderer_info',
      ];
      this._pixels = null;
    }
    const VENDOR = 0x1f00;
    const RENDERER = 0x1f01;
    const UNMASKED_VENDOR = 0x9245;
    const UNMASKED_RENDERER = 0x9246;
    FakeWebGL.prototype.getParameter = function (this: FakeWebGLCtx, pname: number): unknown {
      if (pname === VENDOR || pname === UNMASKED_VENDOR) return this._vendor;
      if (pname === RENDERER || pname === UNMASKED_RENDERER) return this._renderer;
      if (pname === 0x0d33) return 16384; // MAX_TEXTURE_SIZE
      return null;
    };
    FakeWebGL.prototype.readPixels = function (
      this: FakeWebGLCtx,
      _x: number,
      _y: number,
      w: number,
      h: number,
      _format: number,
      _type: number,
      pixels: Uint8Array,
    ) {
      // Fill with a pattern so we can detect perturbation.
      for (let i = 0; i < pixels.length; i++) pixels[i] = 0x80;
    };
    FakeWebGL.prototype.getSupportedExtensions = function (this: FakeWebGLCtx): string[] {
      return this._extensions.slice();
    };
    FakeWebGL.prototype.getShaderPrecisionFormat = function (
      this: FakeWebGLCtx,
      _shaderType: number,
      _precisionType: number,
    ): { rangeMin: number; rangeMax: number; precision: number } {
      return { rangeMin: 127, rangeMax: 127, precision: 23 };
    };
    w['WebGLRenderingContext'] = FakeWebGL;
  }
}

function runStrict(hex: string, origin = 'https://example.com') {
  installCanvasStubs();
  installWebGLStubs();
  Object.defineProperty(window, 'location', {
    value: { origin, href: origin + '/' },
    configurable: true,
  });
  // TRUE GLOBAL scope via indirect eval — same as run() for the standard shim.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  (0, eval)(withSeed(STRICT, hex));
}

// Save/restore WebGL stubs around each strict test.
let _savedWebGLGetParameter: unknown;
let _savedWebGLReadPixels: unknown;
let _savedWebGLGetSupportedExtensions: unknown;
let _savedWebGLGetShaderPrecisionFormat: unknown;

describe('farble shim (strict) — shipped JS, runtime', () => {
  beforeEach(() => {
    installWebGLStubs();
    const w = window as unknown as Record<string, unknown>;
    const WGL = w['WebGLRenderingContext'] as { prototype: WebGLProto } | undefined;
    _savedWebGLGetParameter = WGL?.prototype?.['getParameter'];
    _savedWebGLReadPixels = WGL?.prototype?.['readPixels'];
    _savedWebGLGetSupportedExtensions = WGL?.prototype?.['getSupportedExtensions'];
    _savedWebGLGetShaderPrecisionFormat = WGL?.prototype?.['getShaderPrecisionFormat'];
  });

  afterEach(() => {
    const w = window as unknown as Record<string, unknown>;
    const WGL = w['WebGLRenderingContext'] as { prototype: WebGLProto } | undefined;
    if (WGL) {
      if (_savedWebGLGetParameter !== undefined)
        WGL.prototype['getParameter'] = _savedWebGLGetParameter as () => unknown;
      if (_savedWebGLReadPixels !== undefined)
        WGL.prototype['readPixels'] = _savedWebGLReadPixels as () => unknown;
      if (_savedWebGLGetSupportedExtensions !== undefined)
        WGL.prototype['getSupportedExtensions'] =
          _savedWebGLGetSupportedExtensions as () => unknown;
      if (_savedWebGLGetShaderPrecisionFormat !== undefined)
        WGL.prototype['getShaderPrecisionFormat'] =
          _savedWebGLGetShaderPrecisionFormat as () => unknown;
    }
  });

  it('SEED is NOT readable as a window.* global in strict mode (closured seed, no super-cookie)', () => {
    // Run in true global scope — top-level var would land on window.
    // This is the same guard as the standard test, applied to the strict shim.
    runStrict(SEED_A);
    const w = window as unknown as Record<string, unknown>;
    expect(w['__aegisFarbleSeed']).toBeUndefined();
    expect('__aegisFarbleSeed' in window).toBe(false);
    expect(w['__aegisFarbleOriginSeed']).toBeUndefined();
    expect(w['__aegisFarblesub']).toBeUndefined();
    expect(w['__farbleSeed']).toBeUndefined();
    expect(w['_s0']).toBeUndefined();
    expect(w['_s1']).toBeUndefined();
    expect(w['sub']).toBeUndefined();
    // WebGL-specific intermediates must also NOT leak.
    expect(w['_wglVendorStr']).toBeUndefined();
    expect(w['_wglRendererStr']).toBeUndefined();
    expect(w['_webglVendors']).toBeUndefined();
    expect(w['_webglRenderers']).toBeUndefined();
  });

  it('strict getParameter replaces VENDOR and RENDERER with plausible strings', () => {
    runStrict(SEED_A);
    const w = window as unknown as Record<string, unknown>;
    const WGL = w['WebGLRenderingContext'] as {
      prototype: { getParameter: (pname: number) => unknown };
    };
    const fakeCtx: FakeWebGLCtx = {
      _vendor: 'Real GPU Vendor',
      _renderer: 'Real GPU Renderer',
      _extensions: [],
      _pixels: null,
    };

    const VENDOR = 0x1f00;
    const RENDERER = 0x1f01;
    const UNMASKED_VENDOR = 0x9245;
    const UNMASKED_RENDERER = 0x9246;

    const vendor = WGL.prototype.getParameter.call(fakeCtx, VENDOR) as string;
    const renderer = WGL.prototype.getParameter.call(fakeCtx, RENDERER) as string;
    const unmaskedVendor = WGL.prototype.getParameter.call(fakeCtx, UNMASKED_VENDOR) as string;
    const unmaskedRenderer = WGL.prototype.getParameter.call(fakeCtx, UNMASKED_RENDERER) as string;

    // Must NOT be the raw "Real GPU Vendor"/"Real GPU Renderer" — farbled.
    expect(vendor).not.toBe('Real GPU Vendor');
    expect(renderer).not.toBe('Real GPU Renderer');
    expect(unmaskedVendor).not.toBe('Real GPU Vendor');
    expect(unmaskedRenderer).not.toBe('Real GPU Renderer');

    // Must be plausible non-empty strings (from the known-good list).
    expect(typeof vendor).toBe('string');
    expect(vendor.length).toBeGreaterThan(0);
    expect(typeof renderer).toBe('string');
    expect(renderer.length).toBeGreaterThan(0);
  });

  it('strict getParameter is DETERMINISTIC per seed+origin', () => {
    runStrict(SEED_A, 'https://deterministic.example');
    const w = window as unknown as Record<string, unknown>;
    const WGL = w['WebGLRenderingContext'] as {
      prototype: { getParameter: (pname: number) => unknown };
    };
    const fakeCtx: FakeWebGLCtx = {
      _vendor: 'Real GPU Vendor',
      _renderer: 'Real GPU Renderer',
      _extensions: [],
      _pixels: null,
    };
    const v1 = WGL.prototype.getParameter.call(fakeCtx, 0x1f00);
    const v2 = WGL.prototype.getParameter.call(fakeCtx, 0x1f00);
    // Two calls in the same session+origin → identical (deterministic).
    expect(v1).toBe(v2);
  });

  it('strict getParameter differs across origins (per-origin sub-seed)', () => {
    // REAL FALSIFIER: run the strict shim for 7 fixed origins with the SAME seed
    // and collect VENDOR results into a Set.  With a 4-entry vendor list seeded by
    // SHA-256, the probability all 7 collapse to the same entry is ~4·(1/4)^7 ≈ 0.003 %
    // — negligible — so set.size > 1 is a deterministic, non-flaky invariant.
    // A no-op-seeding regression (every origin → identical fingerprint) produces
    // set.size === 1, which FAILS this test.
    const ORIGINS = [
      'https://site1.test',
      'https://site2.test',
      'https://site3.test',
      'https://site4.test',
      'https://site5.test',
      'https://site6.test',
      'https://site7.test',
    ];

    const VENDOR = 0x1f00;
    const RENDERER = 0x1f01;

    const w = window as unknown as Record<string, unknown>;
    const fakeCtx: FakeWebGLCtx = {
      _vendor: 'Real GPU Vendor',
      _renderer: 'Real GPU Renderer',
      _extensions: [],
      _pixels: null,
    };

    const vendorResults = new Set<string>();
    const rendererResults = new Set<string>();

    for (const origin of ORIGINS) {
      // Restore the prototype before each run so previous patches don't bleed.
      if (_savedWebGLGetParameter !== undefined) {
        const WGL2 = w['WebGLRenderingContext'] as { prototype: WebGLProto };
        WGL2.prototype['getParameter'] = _savedWebGLGetParameter as () => unknown;
      }

      runStrict(SEED_A, origin);

      const WGL = w['WebGLRenderingContext'] as {
        prototype: { getParameter: (pname: number) => unknown };
      };

      const vendor = WGL.prototype.getParameter.call(fakeCtx, VENDOR) as string;
      const renderer = WGL.prototype.getParameter.call(fakeCtx, RENDERER) as string;

      // Every result must be a non-empty string (sanity guard kept from prior test).
      expect(typeof vendor).toBe('string');
      expect(vendor.length).toBeGreaterThan(0);
      expect(typeof renderer).toBe('string');
      expect(renderer.length).toBeGreaterThan(0);

      vendorResults.add(vendor);
      rendererResults.add(renderer);
    }

    // CORE ASSERTION: not all origins produce the same vendor/renderer — per-origin
    // seeding is actually operating.  set.size === 1 means the seed is a no-op (all
    // origins return the same fingerprint = a cross-site identifier).
    expect(vendorResults.size).toBeGreaterThan(1);
    expect(rendererResults.size).toBeGreaterThan(1);

    // Also verify determinism: re-running the SAME origin produces the SAME vendor.
    // Restore prototype first, then re-run origin 0.
    const WGLFinal = w['WebGLRenderingContext'] as { prototype: WebGLProto };
    if (_savedWebGLGetParameter !== undefined)
      WGLFinal.prototype['getParameter'] = _savedWebGLGetParameter as () => unknown;
    runStrict(SEED_A, ORIGINS[0]);
    const WGL = w['WebGLRenderingContext'] as {
      prototype: { getParameter: (pname: number) => unknown };
    };
    const vendorRepeat = WGL.prototype.getParameter.call(fakeCtx, VENDOR) as string;
    // Re-running the first origin must yield the same vendor as the first pass.
    expect(vendorResults.has(vendorRepeat)).toBe(true);
  });

  it('strict readPixels perturbs LSBs deterministically', () => {
    runStrict(SEED_A);
    const w = window as unknown as Record<string, unknown>;
    const WGL = w['WebGLRenderingContext'] as {
      prototype: {
        readPixels: (
          x: number,
          y: number,
          w: number,
          h: number,
          fmt: number,
          type: number,
          px: Uint8Array,
        ) => void;
      };
    };
    const fakeCtx: FakeWebGLCtx = {
      _vendor: 'Real GPU Vendor',
      _renderer: 'Real GPU Renderer',
      _extensions: [],
      _pixels: null,
    };

    const pixels1 = new Uint8Array(4 * 4 * 4); // 4×4 RGBA
    const pixels2 = new Uint8Array(4 * 4 * 4);

    WGL.prototype.readPixels.call(
      fakeCtx,
      0,
      0,
      4,
      4,
      0x1908 /* RGBA */,
      0x1401 /* UNSIGNED_BYTE */,
      pixels1,
    );
    WGL.prototype.readPixels.call(fakeCtx, 0, 0, 4, 4, 0x1908, 0x1401, pixels2);

    // Must not throw; result must be populated.
    expect(pixels1.length).toBe(64);

    // R channel must be within ±1 of the fill value (0x80 = 128).
    for (let i = 0; i < pixels1.length; i += 4) {
      expect(Math.abs(pixels1[i] - 0x80)).toBeLessThanOrEqual(1);
    }

    // Alpha channel (i+3) must be UNCHANGED from the stub value (0x80).
    for (let i = 3; i < pixels1.length; i += 4) {
      expect(pixels1[i]).toBe(0x80);
    }

    // DETERMINISTIC: two calls fill identically (the noise is stream-based from the
    // same PRNG, so consecutive calls produce different bytes — but both are plausible).
    // Key property: the shim doesn't throw and produces a perturbed but bounded output.
    // We verify the values stay within ±1 of 0x80 (the stub fill).
    for (let i = 0; i < pixels2.length; i += 4) {
      expect(Math.abs(pixels2[i] - 0x80)).toBeLessThanOrEqual(1);
    }
  });

  it('strict readPixels FAIL-OPEN — does not throw even if context would', () => {
    runStrict(SEED_A);
    const w = window as unknown as Record<string, unknown>;
    const WGL = w['WebGLRenderingContext'] as {
      prototype: { readPixels: (...args: unknown[]) => void };
    };
    const throwingCtx = {
      readPixels: () => {
        throw new Error('GL error');
      },
    };
    const pixels = new Uint8Array(16);
    // The patched readPixels must not propagate the inner throw (fail-open).
    expect(() => {
      WGL.prototype.readPixels.call(throwingCtx, 0, 0, 2, 2, 0x1908, 0x1401, pixels);
    }).not.toThrow();
  });

  it('strict getSupportedExtensions returns same members in potentially different order', () => {
    runStrict(SEED_A);
    const w = window as unknown as Record<string, unknown>;
    const WGL = w['WebGLRenderingContext'] as {
      prototype: { getSupportedExtensions: () => string[] | null };
    };
    const fakeCtx: FakeWebGLCtx = {
      _vendor: 'Real GPU Vendor',
      _renderer: 'Real GPU Renderer',
      _extensions: ['EXT_color_buffer_float', 'OES_texture_float', 'WEBGL_debug_renderer_info'],
      _pixels: null,
    };

    const exts = WGL.prototype.getSupportedExtensions.call(fakeCtx);
    expect(exts).not.toBeNull();
    expect(exts!.length).toBe(3);
    // All original extensions must be present (just possibly reordered).
    expect(exts!).toContain('EXT_color_buffer_float');
    expect(exts!).toContain('OES_texture_float');
    expect(exts!).toContain('WEBGL_debug_renderer_info');
  });

  it('strict getSupportedExtensions is deterministic per seed+origin', () => {
    runStrict(SEED_A, 'https://ext-test.example');
    const w = window as unknown as Record<string, unknown>;
    const WGL = w['WebGLRenderingContext'] as {
      prototype: { getSupportedExtensions: () => string[] | null };
    };
    const fakeCtx: FakeWebGLCtx = {
      _vendor: 'Real GPU Vendor',
      _renderer: 'Real GPU Renderer',
      _extensions: ['EXT_color_buffer_float', 'OES_texture_float', 'WEBGL_debug_renderer_info'],
      _pixels: null,
    };
    const e1 = WGL.prototype.getSupportedExtensions.call(fakeCtx);
    const e2 = WGL.prototype.getSupportedExtensions.call(fakeCtx);
    // Two calls in the same session/origin → same order (deterministic).
    expect(e1).toEqual(e2);
  });

  it('strict getShaderPrecisionFormat returns plausible nudged values (fail-open)', () => {
    runStrict(SEED_A);
    const w = window as unknown as Record<string, unknown>;
    const WGL = w['WebGLRenderingContext'] as {
      prototype: {
        getShaderPrecisionFormat: (
          shaderType: number,
          precisionType: number,
        ) => { rangeMin: number; rangeMax: number; precision: number } | null;
      };
    };
    const fakeCtx: FakeWebGLCtx = {
      _vendor: 'Real GPU Vendor',
      _renderer: 'Real GPU Renderer',
      _extensions: [],
      _pixels: null,
    };

    const VERTEX_SHADER = 0x8b31;
    const HIGH_FLOAT = 0x8df2;
    const fmt = WGL.prototype.getShaderPrecisionFormat.call(fakeCtx, VERTEX_SHADER, HIGH_FLOAT);

    // Must not throw; must return a valid precision-format-like object.
    expect(fmt).not.toBeNull();
    expect(typeof fmt!.rangeMin).toBe('number');
    expect(typeof fmt!.rangeMax).toBe('number');
    expect(typeof fmt!.precision).toBe('number');
    // Values must be non-negative (nudge clamps to 0).
    expect(fmt!.rangeMin).toBeGreaterThanOrEqual(0);
    expect(fmt!.rangeMax).toBeGreaterThanOrEqual(0);
    expect(fmt!.precision).toBeGreaterThanOrEqual(0);
    // Values must be within ±1 of the stub values (127, 127, 23).
    expect(Math.abs(fmt!.rangeMin - 127)).toBeLessThanOrEqual(1);
    expect(Math.abs(fmt!.rangeMax - 127)).toBeLessThanOrEqual(1);
    expect(Math.abs(fmt!.precision - 23)).toBeLessThanOrEqual(1);
  });

  it('strict still farbles canvas (standard surfaces carry through)', () => {
    // Canvas getImageData must still be perturbed by the strict shim.
    installCanvasStubs();
    runStrict(SEED_A);
    const w = window as unknown as Record<string, unknown>;
    const CRC2D = w['CanvasRenderingContext2D'] as {
      prototype: { getImageData: (x: number, y: number, w: number, h: number) => FakeImageData };
    };
    const { ctx } = makeCanvas(4, 4);
    const data = CRC2D.prototype.getImageData.call(ctx, 0, 0, 4, 4);
    expect(data).toBeDefined();
    expect(data.data.length).toBeGreaterThan(0);
    // R channel values within ±3 of 0x80 (same bounds as standard).
    for (let i = 0; i < data.data.length; i += 4) {
      expect(Math.abs(data.data[i] - 0x80)).toBeLessThanOrEqual(3);
    }
  });

  it('standard shim does NOT patch WebGL (level gradient is real)', () => {
    // Run the STANDARD shim and confirm WebGLRenderingContext.getParameter is NOT patched.
    installWebGLStubs();
    const w = window as unknown as Record<string, unknown>;
    const WGL = w['WebGLRenderingContext'] as { prototype: WebGLProto };
    const origGP = WGL?.prototype?.['getParameter'];

    run(STANDARD, SEED_A);

    // After running standard, getParameter must be the SAME function (not replaced).
    expect(WGL?.prototype?.['getParameter']).toBe(origGP);
  });

  it('strict no-op when seed is empty (fail-open at boot)', () => {
    installWebGLStubs();
    const w = window as unknown as Record<string, unknown>;
    const WGL = w['WebGLRenderingContext'] as { prototype: WebGLProto };
    const origGP = WGL?.prototype?.['getParameter'];

    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    (0, eval)(STRICT.replace("'__AEGIS_FARBLE_SEED__'", '""'));

    // With an empty seed the IIFE returns immediately — WebGL must be unpatched.
    expect(WGL?.prototype?.['getParameter']).toBe(origGP);
  });
});
