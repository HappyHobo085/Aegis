import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Onboarding, ONBOARDING_STORAGE_KEY } from './Onboarding';
import type { SearchEngine } from '../../shared/types';

const ENGINES: SearchEngine[] = [
  { id: 'ddg', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
  { id: 'google', name: 'Google', template: 'https://www.google.com/search?q=%s' },
];

function setup(overrides: Partial<React.ComponentProps<typeof Onboarding>> = {}) {
  const onChooseSearch = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <Onboarding
      searchEngines={ENGINES}
      defaultSearchTemplate={ENGINES[0].template}
      onChooseSearch={onChooseSearch}
      onOpenSettings={onOpenSettings}
      forceOpen
      {...overrides}
    />,
  );
  return { onChooseSearch, onOpenSettings };
}

describe('Onboarding', () => {
  beforeEach(() => localStorage.removeItem(ONBOARDING_STORAGE_KEY));

  it('renders the welcome, the signature features, and a search picker when forced open', () => {
    setup();
    expect(screen.getByRole('dialog', { name: /welcome to aegis/i })).toBeInTheDocument();
    expect(screen.getByText(/ads blocked by default/i)).toBeInTheDocument();
    expect(screen.getByText(/private tabs/i)).toBeInTheDocument();
    expect(screen.getByText(/fingerprint protection/i)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /duckduckgo/i })).toBeChecked();
  });

  it('does not render when already completed and not forced', () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, '1');
    const { container } = render(
      <Onboarding
        searchEngines={ENGINES}
        defaultSearchTemplate={ENGINES[0].template}
        onChooseSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('"Start fresh" dismisses the modal and records completion', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: /start fresh/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe('1');
  });

  it('"Open settings" dismisses and asks the host to open settings', async () => {
    const { onOpenSettings } = setup();
    await userEvent.click(screen.getByRole('button', { name: /open settings/i }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('choosing a search engine calls onChooseSearch with its template', async () => {
    const { onChooseSearch } = setup();
    await userEvent.click(screen.getByRole('radio', { name: /google/i }));
    expect(onChooseSearch).toHaveBeenCalledWith(ENGINES[1].template);
  });

  it('applies the selected privacy preset when completing onboarding', async () => {
    const onChoosePrivacyPreset = vi.fn();
    setup({ onChoosePrivacyPreset });
    await userEvent.click(screen.getByRole('radio', { name: /strict/i }));
    await userEvent.click(screen.getByRole('button', { name: /start fresh/i }));
    expect(onChoosePrivacyPreset).toHaveBeenCalledWith('strict');
  });

  it('Escape dismisses the modal', async () => {
    setup();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
