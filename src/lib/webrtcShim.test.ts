// Runtime test of the SHIPPED WebRTC shim JS (src-tauri/src/webrtc_shim.*.js). The Rust
// side include_str!'s these exact files, so executing them here against a fake
// RTCPeerConnection tests the actual shipped bytes — catching behavioral bugs that a
// string-assertion (the Rust marker test) cannot. Runs in the vitest jsdom project.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The vitest suite runs from the repo root, so anchor on cwd (import.meta.url resolves
// root-relative under vitest's transform).
const read = (name: string) => readFileSync(join(process.cwd(), 'src-tauri/src', name), 'utf8');
const PUBLIC_ONLY_JS = read('webrtc_shim.public-only.js');
const DISABLE_JS = read('webrtc_shim.disable.js');

const PRIVATE_HOST = 'candidate:1 1 udp 1 192.168.1.5 5000 typ host';
const PUBLIC_SRFLX = 'candidate:2 1 udp 1 203.0.113.7 5000 typ srflx';
const RELAY = 'candidate:3 1 udp 1 198.51.100.9 6000 typ relay';

/** A minimal stand-in for RTCPeerConnection covering every surface the shim wraps. */
function makeFakePC() {
  class FakePC {
    _listeners: Record<string, Array<(ev: unknown) => void>> = {};
    static generateCertificate = vi.fn(async () => ({ expires: 0 }));
    addEventListener(type: string, fn: (ev: unknown) => void) {
      (this._listeners[type] ||= []).push(fn);
    }
    removeEventListener(type: string, fn: (ev: unknown) => void) {
      const arr = this._listeners[type];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    }
    /** Test helper: fire an icecandidate event through whatever listeners are registered. */
    _emitIce(candidate: string | null) {
      const ev = { candidate: candidate == null ? null : { candidate } };
      (this._listeners['icecandidate'] || []).slice().forEach((fn) => fn.call(this, ev));
    }
    createOffer() {
      return Promise.resolve({
        type: 'offer',
        sdp:
          'v=0\r\no=- 1 2 IN IP4 192.168.1.5\r\nc=IN IP4 192.168.1.5\r\n' +
          `a=${PRIVATE_HOST}\r\na=${PUBLIC_SRFLX}\r\na=${RELAY}\r\n`,
      });
    }
    getStats() {
      return Promise.resolve(
        new Map<string, Record<string, unknown>>([
          [
            'host',
            {
              type: 'local-candidate',
              candidateType: 'host',
              address: '192.168.1.5',
              ip: '192.168.1.5',
            },
          ],
          [
            'relay',
            {
              type: 'local-candidate',
              candidateType: 'relay',
              address: '198.51.100.9',
              ip: '198.51.100.9',
            },
          ],
        ]),
      );
    }
  }
  Object.defineProperty(FakePC.prototype, 'localDescription', {
    configurable: true,
    get() {
      return { type: 'offer', sdp: 'v=0\r\nc=IN IP4 10.0.0.4\r\n' };
    },
  });
  return FakePC;
}

/** Install a shim over a fresh fake and return the (possibly patched) constructor. */
function install(js: string) {
  const w = window as unknown as Record<string, unknown>;
  w.RTCPeerConnection = makeFakePC();
  delete w.webkitRTCPeerConnection;
  // The shim is an IIFE that reads/replaces window.RTCPeerConnection; run it in global scope.
  new Function(js)();
  return w.RTCPeerConnection as new () => any;
}

afterEach(() => {
  const w = window as unknown as Record<string, unknown>;
  delete w.RTCPeerConnection;
  delete w.webkitRTCPeerConnection;
});

describe('webrtc shim (public-only) — shipped JS, runtime', () => {
  it('drops private host candidates, keeps public srflx + relay (onicecandidate)', () => {
    const PC = install(PUBLIC_ONLY_JS);
    const pc = new PC();
    const got: (string | null)[] = [];
    pc.onicecandidate = (ev: any) => got.push(ev.candidate ? ev.candidate.candidate : null);
    pc._emitIce(PRIVATE_HOST);
    pc._emitIce(PUBLIC_SRFLX);
    pc._emitIce(RELAY);
    expect(got).toEqual([PUBLIC_SRFLX, RELAY]);
  });

  it('drops IPv4-mapped IPv6 private host candidates (::ffff:192.168.x.x)', () => {
    const PC = install(PUBLIC_ONLY_JS);
    const pc = new PC();
    const MAPPED_PRIVATE = 'candidate:4 1 udp 1 ::ffff:192.168.1.5 5000 typ host';
    const got: (string | null)[] = [];
    pc.onicecandidate = (ev: any) => got.push(ev.candidate ? ev.candidate.candidate : null);
    pc._emitIce(MAPPED_PRIVATE);
    pc._emitIce(PUBLIC_SRFLX);
    // The mapped private host must be dropped (it would leak the LAN IP otherwise).
    expect(got).toEqual([PUBLIC_SRFLX]);
  });

  it('onicecandidate REPLACES (no listener accumulation)', () => {
    const PC = install(PUBLIC_ONLY_JS);
    const pc = new PC();
    const a: unknown[] = [];
    const b: unknown[] = [];
    pc.onicecandidate = (ev: unknown) => a.push(ev);
    pc.onicecandidate = (ev: unknown) => b.push(ev);
    pc._emitIce(PUBLIC_SRFLX);
    expect(a).toHaveLength(0); // the first handler was detached
    expect(b).toHaveLength(1);
  });

  it('onicecandidate = null detaches the handler', () => {
    const PC = install(PUBLIC_ONLY_JS);
    const pc = new PC();
    const seen: unknown[] = [];
    pc.onicecandidate = (ev: unknown) => seen.push(ev);
    pc.onicecandidate = null;
    pc._emitIce(PUBLIC_SRFLX);
    expect(seen).toHaveLength(0);
  });

  it('addEventListener filters, removeEventListener detaches the wrapped listener', () => {
    const PC = install(PUBLIC_ONLY_JS);
    const pc = new PC();
    const got: unknown[] = [];
    const handler = (ev: unknown) => got.push(ev);
    pc.addEventListener('icecandidate', handler);
    pc._emitIce(PUBLIC_SRFLX);
    expect(got).toHaveLength(1);
    pc.removeEventListener('icecandidate', handler);
    pc._emitIce(PUBLIC_SRFLX);
    expect(got).toHaveLength(1); // nothing after removal
  });

  it('getStats() nulls private host/srflx addresses but keeps relay', async () => {
    const PC = install(PUBLIC_ONLY_JS);
    const report = await new PC().getStats();
    expect(report.get('host').address).toBeNull();
    expect(report.get('host').ip).toBeNull();
    expect(report.get('relay').address).toBe('198.51.100.9'); // relay untouched
  });

  it('createOffer() rewrites private SDP addresses, keeps the public candidate', async () => {
    const PC = install(PUBLIC_ONLY_JS);
    const offer = await new PC().createOffer();
    expect(offer.sdp).not.toContain('192.168.1.5');
    expect(offer.sdp).toContain('c=IN IP4 0.0.0.0');
    expect(offer.sdp).toContain('203.0.113.7'); // public srflx kept
    expect(offer.sdp).toContain('typ relay');
  });

  it('localDescription getter filters the private SDP on read', () => {
    const PC = install(PUBLIC_ONLY_JS);
    expect(new PC().localDescription.sdp).not.toContain('10.0.0.4');
  });

  it('preserves the constructor static methods (generateCertificate)', () => {
    const PC = install(PUBLIC_ONLY_JS) as unknown as { generateCertificate?: unknown };
    expect(typeof PC.generateCertificate).toBe('function');
  });
});

describe('webrtc shim (disable) — shipped JS, runtime', () => {
  it('makes RTCPeerConnection construction throw', () => {
    const PC = install(DISABLE_JS);
    expect(() => new PC()).toThrow();
  });
});
