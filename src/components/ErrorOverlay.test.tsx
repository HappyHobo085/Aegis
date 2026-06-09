// src/components/ErrorOverlay.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import type { NavFailed, NavCrashed } from '../../shared/types';
import { ErrorOverlay } from './ErrorOverlay';

const loadFailure: NavFailed = {
  viewId: PRIMARY_VIEW_ID,
  errorCode: -105,
  errorDescription: 'ERR_NAME_NOT_RESOLVED',
  validatedURL: 'https://nope.invalid/',
  kind: 'load',
};

const certFailure: NavFailed = {
  viewId: PRIMARY_VIEW_ID,
  errorCode: -202,
  errorDescription: 'ERR_CERT_AUTHORITY_INVALID',
  validatedURL: 'https://self-signed.example/',
  kind: 'cert',
};

const crash: NavCrashed = {
  viewId: PRIMARY_VIEW_ID,
  reason: 'crashed',
};

describe('ErrorOverlay', () => {
  it('renders the load-failure variant with the error description', () => {
    render(<ErrorOverlay failed={loadFailure} crashed={null} onRetry={vi.fn()} onHome={vi.fn()} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/this page could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByText(/ERR_NAME_NOT_RESOLVED/)).toBeInTheDocument();
  });

  it('renders the certificate-failure variant with a security message', () => {
    render(<ErrorOverlay failed={certFailure} crashed={null} onRetry={vi.fn()} onHome={vi.fn()} />);
    expect(screen.getByText(/security certificate/i)).toBeInTheDocument();
    expect(screen.getByText(/ERR_CERT_AUTHORITY_INVALID/)).toBeInTheDocument();
  });

  it('renders the crash variant', () => {
    render(<ErrorOverlay failed={null} crashed={crash} onRetry={vi.fn()} onHome={vi.fn()} />);
    expect(screen.getByText(/page crashed/i)).toBeInTheDocument();
  });

  it('renders nothing when there is no failure or crash', () => {
    const { container } = render(
      <ErrorOverlay failed={null} crashed={null} onRetry={vi.fn()} onHome={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('calls onRetry and onHome from the buttons', async () => {
    const onRetry = vi.fn();
    const onHome = vi.fn();
    render(<ErrorOverlay failed={loadFailure} crashed={null} onRetry={onRetry} onHome={onHome} />);
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    await userEvent.click(screen.getByRole('button', { name: /home/i }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onHome).toHaveBeenCalledOnce();
  });

  it('prefers the crash variant when both crashed and failed are present', () => {
    render(
      <ErrorOverlay failed={loadFailure} crashed={crash} onRetry={vi.fn()} onHome={vi.fn()} />,
    );
    expect(screen.getByText(/page crashed/i)).toBeInTheDocument();
    expect(screen.queryByText(/this page could not be loaded/i)).not.toBeInTheDocument();
  });
});
