// src/components/SettingsModal.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsModal } from './SettingsModal';

const panels = () => ({
  appearance: <div data-testid="panel-appearance">APPEARANCE</div>,
  search: <div data-testid="panel-search">SEARCH</div>,
  home: <div data-testid="panel-home">HOME</div>,
  filterLists: <div data-testid="panel-filterLists">FILTER LISTS</div>,
  myFilters: <div data-testid="panel-myFilters">MY FILTERS</div>,
  allowlist: <div data-testid="panel-allowlist">ALLOWLIST</div>,
  downloads: <div data-testid="panel-downloads">DOWNLOADS</div>,
  sitePermissions: <div data-testid="panel-sitePermissions">SITE PERMISSIONS</div>,
  data: <div data-testid="panel-data">DATA</div>,
});

const props = (over: Partial<React.ComponentProps<typeof SettingsModal>> = {}) => ({
  onClose: vi.fn(),
  ...panels(),
  ...over,
});

describe('SettingsModal', () => {
  it('renders as a modal dialog named Settings', () => {
    render(<SettingsModal {...props()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName(/settings/i);
  });

  it('renders a tablist with all nine tabs', () => {
    render(<SettingsModal {...props()} />);
    const tablist = screen.getByRole('tablist', { name: /settings sections/i });
    expect(tablist).toBeInTheDocument();
    for (const name of [
      /appearance/i,
      /search/i,
      /^home$/i,
      /filter lists/i,
      /my filters/i,
      /allowlist/i,
      /^downloads$/i,
      /site permissions/i,
      /^data$/i,
    ]) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    }
  });

  it('shows the Appearance panel by default and marks its tab selected', () => {
    render(<SettingsModal {...props()} />);
    expect(screen.getByRole('tab', { name: /appearance/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('panel-appearance')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-search')).not.toBeInTheDocument();
  });

  it('switches to another tab on click', async () => {
    render(<SettingsModal {...props()} />);
    await userEvent.click(screen.getByRole('tab', { name: /filter lists/i }));
    expect(screen.getByRole('tab', { name: /filter lists/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('panel-filterLists')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-appearance')).not.toBeInTheDocument();
  });

  it('the active tabpanel is labelled by its tab', async () => {
    render(<SettingsModal {...props()} />);
    await userEvent.click(screen.getByRole('tab', { name: /my filters/i }));
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAccessibleName(/my filters/i);
  });

  it('closes on the Close button and on Escape', async () => {
    const p = props();
    render(<SettingsModal {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^close$/i }));
    expect(p.onClose).toHaveBeenCalledTimes(1);
    p.onClose.mockClear();
    await userEvent.keyboard('{Escape}');
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });
});
