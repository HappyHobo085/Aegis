import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  ChromePopoverProvider,
  useChromePopoverInset,
  useChromePopoverRegistry,
} from './useChromePopover';

function InsetProbe() {
  const { inset } = useChromePopoverRegistry();
  return <span data-testid="inset">{inset}</span>;
}

function Popover({ id, height }: { id: string; height: number }) {
  useChromePopoverInset(id, height);
  return null;
}

function wrap(ui: ReactNode) {
  return render(<ChromePopoverProvider>{ui}</ChromePopoverProvider>);
}

describe('chrome popover registry', () => {
  it('reserves the measured height of a single open popover', () => {
    wrap(
      <>
        <InsetProbe />
        <Popover id="address-omnibox" height={280} />
      </>,
    );
    expect(screen.getByTestId('inset').textContent).toBe('280');
  });

  it('reserves the TALLEST height, not the sum or the last one', () => {
    // The omnibox and the site-info popover share the same anchor and are
    // mutually exclusive, but the shield and the omnibox can both be open-ish;
    // the content inset must clear whichever hangs lowest.
    wrap(
      <>
        <InsetProbe />
        <Popover id="address-omnibox" height={280} />
        <Popover id="adblock-shield" height={412} />
        <Popover id="zoom-indicator" height={96} />
      </>,
    );
    expect(screen.getByTestId('inset').textContent).toBe('412');
  });

  it('releases the reservation when the popover unmounts', () => {
    const { rerender } = wrap(
      <>
        <InsetProbe />
        <Popover id="address-omnibox" height={280} />
      </>,
    );
    expect(screen.getByTestId('inset').textContent).toBe('280');

    act(() => {
      rerender(
        <ChromePopoverProvider>
          <InsetProbe />
        </ChromePopoverProvider>,
      );
    });
    expect(screen.getByTestId('inset').textContent).toBe('0');
  });

  it('treats a zero height as closed (no reservation)', () => {
    // useMeasuredHeight reports 0 for a closed popover, so 0 must not reserve.
    wrap(
      <>
        <InsetProbe />
        <Popover id="address-site" height={0} />
      </>,
    );
    expect(screen.getByTestId('inset').textContent).toBe('0');
  });

  it('useChromePopoverRegistry throws outside the provider', () => {
    expect(() => render(<InsetProbe />)).toThrow(/ChromePopoverProvider/);
  });

  it('useChromePopoverInset is a no-op (does not throw) with no provider', () => {
    // Unit tests and the mobile shell render popovers with no registry around them.
    expect(() => render(<Popover id="x" height={100} />)).not.toThrow();
  });
});
