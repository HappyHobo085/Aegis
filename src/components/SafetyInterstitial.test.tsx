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
});
