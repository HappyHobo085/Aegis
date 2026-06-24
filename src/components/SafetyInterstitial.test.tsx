import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SafetyInterstitial } from './SafetyInterstitial';
import { registerConfirmHandler } from '../lib/toast';

beforeEach(() => {
  // Default: no registered confirm host → confirm() falls back to window.confirm,
  // which jsdom stubs to return false unless a test overrides it.
  registerConfirmHandler(null);
});

describe('SafetyInterstitial', () => {
  it('renders nothing when inactive', () => {
    const { container } = render(<SafetyInterstitial interstitial={null} onProceed={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the host and calls onProceed with the url', async () => {
    const onProceed = vi.fn();
    render(
      <SafetyInterstitial
        interstitial={{ url: 'http://example.com/x', reason: 'https-failed' }}
        onProceed={onProceed}
      />,
    );
    expect(screen.getByText(/example\.com/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /continue to http/i }));
    expect(onProceed).toHaveBeenCalledWith('http://example.com/x');
  });

  it('renders the malware variant with a danger heading + Continue anyway', () => {
    render(
      <SafetyInterstitial
        interstitial={{ url: 'http://evil.example/', reason: 'malware' }}
        onProceed={() => {}}
      />,
    );
    expect(screen.getByText(/dangerous|malicious|deceptive/i)).toBeInTheDocument();
    expect(screen.getByText(/evil\.example/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue anyway/i })).toBeInTheDocument();
  });

  it('malware: Continue anyway requires an explicit confirm before proceeding', async () => {
    const onProceed = vi.fn();
    const confirmHandler = vi.fn().mockResolvedValue(false);
    registerConfirmHandler(confirmHandler);
    render(
      <SafetyInterstitial
        interstitial={{ url: 'http://evil.example/', reason: 'malware' }}
        onProceed={onProceed}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /continue anyway/i }));
    // Confirm was asked with a dangerous-site message, flagged destructive...
    expect(confirmHandler).toHaveBeenCalledWith(
      expect.stringMatching(/flagged as dangerous.*continue anyway/i),
      true,
    );
    // ...and because it returned false, we did NOT proceed.
    expect(onProceed).not.toHaveBeenCalled();
  });

  it('malware: proceeds only when the confirm resolves true', async () => {
    const onProceed = vi.fn();
    registerConfirmHandler(vi.fn().mockResolvedValue(true));
    render(
      <SafetyInterstitial
        interstitial={{ url: 'http://evil.example/', reason: 'malware' }}
        onProceed={onProceed}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /continue anyway/i }));
    await waitFor(() => expect(onProceed).toHaveBeenCalledWith('http://evil.example/'));
  });

  it('https-downgrade: Continue does NOT require a confirm (single click)', async () => {
    const onProceed = vi.fn();
    const confirmHandler = vi.fn().mockResolvedValue(true);
    registerConfirmHandler(confirmHandler);
    render(
      <SafetyInterstitial
        interstitial={{ url: 'http://example.com/x', reason: 'https-failed' }}
        onProceed={onProceed}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /continue to http/i }));
    expect(confirmHandler).not.toHaveBeenCalled();
    expect(onProceed).toHaveBeenCalledWith('http://example.com/x');
  });

  it('renders a Go back button when onBack is provided and clicking it calls the handler', async () => {
    const onBack = vi.fn();
    render(
      <SafetyInterstitial
        interstitial={{ url: 'http://example.com/', reason: 'https-failed' }}
        onProceed={() => {}}
        onBack={onBack}
      />,
    );
    const backBtn = screen.getByRole('button', { name: /go back/i });
    expect(backBtn).toBeInTheDocument();
    await userEvent.click(backBtn);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('does NOT render a Go back button when onBack is omitted', () => {
    render(
      <SafetyInterstitial
        interstitial={{ url: 'http://example.com/', reason: 'https-failed' }}
        onProceed={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /go back/i })).not.toBeInTheDocument();
  });

  it('lands initial focus on the SAFE action (Go back) when onBack is provided', () => {
    render(
      <SafetyInterstitial
        interstitial={{ url: 'http://example.com/', reason: 'malware' }}
        onProceed={() => {}}
        onBack={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /go back/i })).toHaveFocus();
  });

  it('Escape calls onBack (the safe action) when onBack is provided', async () => {
    const onBack = vi.fn();
    render(
      <SafetyInterstitial
        interstitial={{ url: 'http://example.com/', reason: 'malware' }}
        onProceed={() => {}}
        onBack={onBack}
      />,
    );
    await userEvent.keyboard('{Escape}');
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('Escape is a no-op when onBack is undefined (no safe action to take)', async () => {
    const onProceed = vi.fn();
    render(
      <SafetyInterstitial
        interstitial={{ url: 'http://example.com/', reason: 'malware' }}
        onProceed={onProceed}
      />,
    );
    // Should not throw and should not proceed.
    await userEvent.keyboard('{Escape}');
    expect(onProceed).not.toHaveBeenCalled();
  });
});
