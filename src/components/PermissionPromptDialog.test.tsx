// src/components/PermissionPromptDialog.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PermissionPrompt } from '../../shared/types';
import { PermissionPromptDialog } from './PermissionPromptDialog';

const prompt = (over: Partial<PermissionPrompt> = {}): PermissionPrompt => ({
  requestId: 11,
  origin: 'https://example.com',
  permission: 'geolocation',
  ...over,
});

function props(over: Partial<React.ComponentProps<typeof PermissionPromptDialog>> = {}) {
  return {
    prompt: prompt(),
    onResolve: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PermissionPromptDialog', () => {
  it('renders a modal dialog naming the origin and permission', () => {
    render(<PermissionPromptDialog {...props()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent('https://example.com');
    expect(dialog).toHaveTextContent(/geolocation/i);
  });

  it('Allow resolves the request with allow', async () => {
    const p = props({ prompt: prompt({ requestId: 5 }) });
    render(<PermissionPromptDialog {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^allow$/i }));
    expect(p.onResolve).toHaveBeenCalledWith(5, 'allow');
  });

  it('Block resolves the request with deny', async () => {
    const p = props({ prompt: prompt({ requestId: 6 }) });
    render(<PermissionPromptDialog {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^block$/i }));
    expect(p.onResolve).toHaveBeenCalledWith(6, 'deny');
  });

  it('Escape resolves the request with deny (closing == blocking)', async () => {
    const p = props({ prompt: prompt({ requestId: 7 }) });
    render(<PermissionPromptDialog {...p} />);
    await userEvent.keyboard('{Escape}');
    expect(p.onResolve).toHaveBeenCalledWith(7, 'deny');
  });

  it('lands initial focus on the SAFE choice (Block), not Allow', () => {
    render(<PermissionPromptDialog {...props()} />);
    expect(screen.getByRole('button', { name: /^block$/i })).toHaveFocus();
  });

  it('clicking the scrim/backdrop denies (closing == blocking)', async () => {
    const p = props({ prompt: prompt({ requestId: 8 }) });
    const { container } = render(<PermissionPromptDialog {...p} />);
    const scrim = container.querySelector('.permission-prompt__scrim') as HTMLElement;
    await userEvent.click(scrim);
    expect(p.onResolve).toHaveBeenCalledWith(8, 'deny');
  });

  it('clicking inside the dialog card does NOT deny (no bubble to scrim)', async () => {
    const p = props({ prompt: prompt({ requestId: 9 }) });
    render(<PermissionPromptDialog {...p} />);
    // Click the message text inside the card — must not trigger a scrim-deny.
    await userEvent.click(screen.getByText(/wants to use/i));
    expect(p.onResolve).not.toHaveBeenCalled();
  });
});
