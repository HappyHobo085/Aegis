// src/popover.tsx
//
// The popover surface's React root. Deliberately tiny.
//
// This webview renders ONE popover at a time inside a rect the chrome measured, over the
// page, in a webview that cannot reach the app's IPC. It owns no state beyond "what am I
// showing": every decision (which popover, which rows, which is active, what an action
// means) belongs to the chrome, which sends the whole payload every time. There is no
// incremental patching, so a dropped frame cannot leave stale rows — see
// `src-tauri/src/popover.rs`.
//
// `index.css` is imported from the SAME file the chrome imports it from, not a copy, so the
// two roots cannot drift apart on theming. There is a test for exactly that.
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { start } from './lib/surfaceApi';
import { PopoverPanel } from './popover/PopoverPanel';
import type { PopoverSurfacePayload } from '../shared/types';

function PopoverRoot(): React.JSX.Element | null {
  const [shown, setShown] = useState<PopoverSurfacePayload | null>(null);

  useEffect(() => {
    // The subscription is the surface's ONLY input, and `start` also performs the readiness
    // handshake that makes the FIRST payload land. The effect's lifetime is the webview's, so
    // this is armed once; a StrictMode double-mount in dev releases and re-arms it cleanly,
    // and the second `start` re-announces readiness rather than losing anything.
    return start(setShown);
  }, []);

  if (!shown) return null;
  return <PopoverPanel shown={shown} />;
}

const host = document.getElementById('root');
if (!host) {
  // A missing mount point is a broken build, not a runtime condition: `popover.html` ships
  // `<div id="root">` and this file is its only script. Throwing here surfaces it as a
  // console error instead of a silently blank surface.
  throw new Error('popover: #root is missing from popover.html');
}
createRoot(host).render(
  <StrictMode>
    <PopoverRoot />
  </StrictMode>,
);
