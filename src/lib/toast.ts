// src/lib/toast.ts
type ToastKind = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
  /** Auto-dismiss delay; retained so a hover-pause can reschedule the same duration. */
  durationMs: number;
}

type Listener = (toasts: ToastItem[]) => void;

let toasts: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const dismissTimers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const listener of listeners) {
    listener(toasts);
  }
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}

interface PushOpts {
  action?: ToastAction;
  durationMs?: number;
}

function scheduleDismiss(id: number, durationMs: number): void {
  const handle = setTimeout(() => {
    dismissTimers.delete(id);
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, durationMs);
  dismissTimers.set(id, handle);
}

function push(kind: ToastKind, message: string, opts: PushOpts = {}): void {
  const item: ToastItem = {
    id: nextId++,
    kind,
    message,
    action: opts.action,
    durationMs: opts.durationMs ?? 4000,
  };
  toasts = [...toasts, item];
  emit();
  scheduleDismiss(item.id, item.durationMs);
}

/** Remove a toast immediately (the per-toast close button). */
export function dismissToast(id: number): void {
  const handle = dismissTimers.get(id);
  if (handle) {
    clearTimeout(handle);
    dismissTimers.delete(id);
  }
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** Pause auto-dismiss while the pointer is over a toast. */
export function pauseToast(id: number): void {
  const handle = dismissTimers.get(id);
  if (handle) {
    clearTimeout(handle);
    dismissTimers.delete(id);
  }
}

/** Resume auto-dismiss when the pointer leaves (reschedules the full duration). */
export function resumeToast(id: number): void {
  if (dismissTimers.has(id)) return;
  const item = toasts.find((t) => t.id === id);
  if (item) scheduleDismiss(id, item.durationMs);
}

export const toast = {
  success(m: string): void {
    push('success', m);
  },
  error(m: string): void {
    push('error', m);
  },
  info(m: string, opts?: { action?: ToastAction; durationMs?: number }): void {
    push('info', m, opts);
  },
};

/** Test-only: clear all toasts and listeners state. */
export function __resetToasts(): void {
  for (const handle of dismissTimers.values()) {
    clearTimeout(handle);
  }
  dismissTimers.clear();
  toasts = [];
  nextId = 1;
  emit();
}

let confirmHandler: ((message: string, destructive?: boolean) => Promise<boolean>) | null = null;

/** Registered by the Toaster/confirm host so confirm() can drive a dialog. */
export function registerConfirmHandler(
  handler: ((message: string, destructive?: boolean) => Promise<boolean>) | null,
): void {
  confirmHandler = handler;
}

/** Ask the user to confirm. Pass `{ destructive: true }` for irreversible actions
 *  (delete/clear/forget) so the affirmative button is styled as dangerous. */
export function confirm(message: string, opts: { destructive?: boolean } = {}): Promise<boolean> {
  if (confirmHandler) {
    // Only forward the 2nd arg when set, so plain confirm(message) keeps its
    // single-argument call shape.
    return opts.destructive !== undefined
      ? confirmHandler(message, opts.destructive)
      : confirmHandler(message);
  }
  return Promise.resolve(typeof window !== 'undefined' ? window.confirm(message) : false);
}
