import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SafetyInterstitial } from './SafetyInterstitial';

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

  it('renders the malware variant with a danger heading + Continue anyway', async () => {
    const onProceed = vi.fn();
    render(
      <SafetyInterstitial
        interstitial={{ url: 'http://evil.example/', reason: 'malware' }}
        onProceed={onProceed}
      />,
    );
    expect(screen.getByText(/dangerous|malicious|deceptive/i)).toBeInTheDocument();
    expect(screen.getByText(/evil\.example/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /continue anyway/i }));
    expect(onProceed).toHaveBeenCalledWith('http://evil.example/');
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
});
