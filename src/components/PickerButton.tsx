// src/components/PickerButton.tsx
import { useEffect, useState } from 'react';
import { SquareMousePointer } from 'lucide-react';
import { aegis } from '../lib/ipcClient';
import { toast } from '../lib/toast';

export function PickerButton() {
  const [busy, setBusy] = useState(false);
  // Whether a picking session is armed. This is the CORE's answer, not this component's
  // optimism: a session also ends inside the page (a pick, or Escape), and a button that
  // only tracked its own clicks would sit there pressed after either — leaving the user
  // clicking a `stop` at a picker that is no longer armed, which is the dead button this
  // toggle exists to remove.
  const [picking, setPicking] = useState(false);

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

  // Every transition is announced, including the two that happen in the page. A pick
  // clears the button through this and NOT through the `picker.picked` handler above,
  // which is subscribed for the toast and must not own picker state.
  useEffect(() => aegis.picker.onState(({ active }) => setPicking(active)), []);

  // `busy` only covers the round trip that injects (or tears down) the overlay, not the
  // pick itself — the button must be re-clickable while the user is still choosing.
  const handleClick = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = picking ? await aegis.picker.stop() : await aegis.picker.start();
      // The reply is the authority, not the branch above: `active` reports whether an
      // overlay is armed in the page, which is false whenever the core had nowhere to
      // inject (Android, or no active tab). Adopting it is what stops the button
      // claiming to be armed over a picker that does not exist.
      setPicking(res.active);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className="toolbar__picker"
      aria-label="Pick element to hide"
      title={picking ? 'Stop picking (Esc also cancels)' : 'Pick element to hide'}
      // The toggle's state, exposed the way a toggle button exposes it. The label is
      // deliberately UNCHANGED when pressed: it names the feature, and the pressed state
      // is what says whether it is running.
      aria-pressed={picking}
      disabled={busy}
      onClick={() => void handleClick()}
    >
      <SquareMousePointer size={18} aria-hidden="true" />
    </button>
  );
}
