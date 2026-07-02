// src/components/AddressBar.tsx
import { Lock, Search, ShieldAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export interface AddressBarProps {
  url: string;
  isLoading?: boolean;
  onSubmit(raw: string): void;
}

// The blank home page has no meaningful URL to show — present an empty address
// bar (just the placeholder) so the first tap-and-type starts a clean query.
const display = (u: string) => (u === 'about:blank' ? '' : u);

function urlStatus(url: string): { label: string; tone: 'secure' | 'warning' | 'search' } {
  if (url === 'about:blank' || url.trim().length === 0) return { label: 'Search', tone: 'search' };
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return { label: 'Secure', tone: 'secure' };
    if (parsed.protocol === 'http:') return { label: 'Not secure', tone: 'warning' };
  } catch {
    return { label: 'Search', tone: 'search' };
  }
  return { label: 'Page', tone: 'search' };
}

export function AddressBar({ url, isLoading = false, onSubmit }: AddressBarProps) {
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

  const status = urlStatus(url);
  const StatusIcon =
    status.tone === 'secure' ? Lock : status.tone === 'warning' ? ShieldAlert : Search;

  return (
    <form
      className="address-bar"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
    >
      <div className={`address-bar__field address-bar__field--${status.tone}`}>
        <span className="address-bar__status" title={status.label} aria-hidden="true">
          <StatusIcon size={14} />
          <span className="address-bar__status-label">{status.label}</span>
        </span>
        <input
          type="text"
          aria-label="Address"
          placeholder="Search or enter a website"
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
        <span className="address-bar__hint" aria-hidden="true">
          Enter
        </span>
        {isLoading && <span className="address-bar__progress" aria-hidden="true" />}
      </div>
    </form>
  );
}
