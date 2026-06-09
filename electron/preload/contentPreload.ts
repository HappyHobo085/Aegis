// electron/preload/contentPreload.ts
// Phase 0 no-op content-view preload entry.
//
// Under contextIsolation:true this preload runs in an isolated world and CANNOT
// alter the page main-world `window.open`. The authoritative popup gate is the
// main-process setWindowOpenHandler (ViewController). This file exists only as
// the content-view preload entry for Phase 1's engine wiring.
export {};
