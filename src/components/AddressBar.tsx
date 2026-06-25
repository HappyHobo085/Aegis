// src/components/AddressBar.tsx
import { useEffect, useRef, useState } from 'react';

export interface AddressBarProps {
  url: string;
  onSubmit(raw: string): void;
}

// The blank home page has no meaningful URL to show — present an empty address
// bar (just the placeholder) so the first tap-and-type starts a clean query.
const display = (u: string) => (u === 'about:blank' ? '' : u);

export function AddressBar({ url, onSubmit }: AddressBarProps) {
  const [value, setValue] = useState(display(url));
  // While the user is typing, a background nav event (page self-redirect, SPA URL change)
  // must NOT clobber their in-progress text. Guard the sync on focus; on blur, revert any
  // unsubmitted edit to the live URL (real-browser behavior).
  const focusedRef = useRef(false);
  const urlRef = useRef(url);
  urlRef.current = url;

  useEffect(() => {
    if (!focusedRef.current) setValue(display(url));
  }, [url]);

  return (
    <form
      className="address-bar"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
    >
      <input
        type="text"
        aria-label="Address"
        placeholder="Search or enter a website  ·  e.g. example.com"
        value={value}
        spellCheck={false}
        autoComplete="off"
        // Select all on focus, like a real browser address bar, so tapping it and
        // typing replaces the URL instead of appending (critical on touch, where
        // there's no Ctrl+A).
        onFocus={(e) => {
          focusedRef.current = true;
          e.currentTarget.select();
        }}
        onBlur={() => {
          focusedRef.current = false;
          setValue(display(urlRef.current));
        }}
        onChange={(e) => setValue(e.target.value)}
      />
    </form>
  );
}
