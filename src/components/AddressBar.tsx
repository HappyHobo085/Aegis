// src/components/AddressBar.tsx
import { useEffect, useState } from 'react';

export interface AddressBarProps {
  url: string;
  onSubmit(raw: string): void;
}

export function AddressBar({ url, onSubmit }: AddressBarProps) {
  const [value, setValue] = useState(url);

  useEffect(() => {
    setValue(url);
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
        onChange={(e) => setValue(e.target.value)}
      />
    </form>
  );
}
