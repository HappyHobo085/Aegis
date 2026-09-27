// src/components/PickerButton.tsx
import { useEffect, useState } from 'react';
import { SquareMousePointer } from 'lucide-react';
import { aegis } from '../lib/ipcClient';
import { toast } from '../lib/toast';

export function PickerButton() {
  const [busy, setBusy] = useState(false);

  // The rule arrives as an EVENT, not as `start()`'s return value. `start()` only
  // injects the picking overlay and returns straight away; the pick itself happens
  // later, when the user clicks an element on the page, and the core emits
  // `picker.picked` with the rule it appended. This subscription used to be absent
  // and the button awaited a `res.rule` that no platform arm of `picker.start` ever
  // returns, so the confirmation toast was unreachable on every platform.
  useEffect(
    () =>
      aegis.picker.onPicked(({ rule }) => {
        toast.success(`Hiding rule added: ${rule}`);
      }),
    [],
  );

  // `busy` only covers the round trip that injects the overlay, not the pick
  // itself — the button must be re-clickable while the user is still choosing.
  const handlePick = async (): Promise<void> => {
    setBusy(true);
    try {
      await aegis.picker.start();
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className="toolbar__picker"
      aria-label="Pick element to hide"
      title="Pick element to hide"
      disabled={busy}
      onClick={() => void handlePick()}
    >
      <SquareMousePointer size={18} aria-hidden="true" />
    </button>
  );
}
