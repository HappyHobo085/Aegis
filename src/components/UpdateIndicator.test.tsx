// src/components/UpdateIndicator.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdateIndicator } from './UpdateIndicator';
import type { UpdateState } from '../../shared/types';

const st = (over: Partial<UpdateState> = {}): UpdateState => ({
  status: 'idle', version: null, percent: 0, error: null, ...over,
});

describe('UpdateIndicator', () => {
  it('renders nothing until an update is downloaded', () => {
    render(<UpdateIndicator state={st({ status: 'available', version: '0.2.0' })} onRestart={vi.fn()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a restart button once an update is downloaded', () => {
    render(<UpdateIndicator state={st({ status: 'downloaded', version: '0.2.0' })} onRestart={vi.fn()} />);
    expect(screen.getByRole('button', { name: /restart to update to 0\.2\.0/i })).toBeInTheDocument();
  });

  it('calls onRestart when clicked', async () => {
    const onRestart = vi.fn();
    render(<UpdateIndicator state={st({ status: 'downloaded', version: '0.2.0' })} onRestart={onRestart} />);
    await userEvent.click(screen.getByRole('button', { name: /restart to update/i }));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});
