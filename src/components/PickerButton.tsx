// src/components/PickerButton.tsx
import { useState } from 'react';
import { SquareMousePointer } from 'lucide-react';
import { aegis } from '../lib/ipcClient';
import { toast } from '../lib/toast';

export function PickerButton() {
  const [busy, setBusy] = useState(false);

  const handlePick = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await aegis.picker.start();
      if (res.ok && res.rule) {
        toast.success(`Hiding rule added: ${res.rule}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className="toolbar__picker"
      aria-label="Pick element to hide"
      disabled={busy}
      onClick={() => void handlePick()}
    >
      <SquareMousePointer size={18} aria-hidden="true" />
    </button>
  );
}
