// src/components/SkipLink.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SkipLink } from './SkipLink';

describe('SkipLink', () => {
  it('renders a link to the target fragment', () => {
    render(<SkipLink targetId="content" />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '#content');
  });

  it('defaults its label to "Skip to content"', () => {
    render(<SkipLink targetId="content" />);
    expect(screen.getByRole('link', { name: 'Skip to content' })).toBeInTheDocument();
  });

  it('accepts a custom label', () => {
    render(<SkipLink targetId="main">Skip to the page</SkipLink>);
    expect(screen.getByRole('link', { name: 'Skip to the page' })).toBeInTheDocument();
  });

  it('carries the skip-link class the CSS visually hides until focused', () => {
    render(<SkipLink targetId="content" />);
    expect(screen.getByRole('link')).toHaveClass('skip-link');
  });

  // The href must be the exact target id, or the browser jumps nowhere and the link is
  // worse than useless (it looks like the keyboard path works and silently does not).
  it('preserves a target id that needs no escaping', () => {
    render(<SkipLink targetId="main-content" />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('#main-content');
  });

  it('is a real anchor, so it is keyboard-activatable', () => {
    render(<SkipLink targetId="content" />);
    expect(screen.getByRole('link').tagName).toBe('A');
  });
});
