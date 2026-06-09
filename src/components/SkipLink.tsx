// src/components/SkipLink.tsx
import type React from 'react';

export interface SkipLinkProps {
  targetId: string;
  children?: React.ReactNode;
}

export function SkipLink({ targetId, children = 'Skip to content' }: SkipLinkProps) {
  return (
    <a className="skip-link" href={`#${targetId}`}>
      {children}
    </a>
  );
}
