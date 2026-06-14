// src/lib/toast.ts
export type ToastKind = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
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

function push(kind: ToastKind, message: string): void {
  const item: ToastItem = { id: nextId++, kind, message };
  toasts = [...toasts, item];
  emit();
  const handle = setTimeout(() => {
    dismissTimers.delete(item.id);
    toasts = toasts.filter((t) => t.id !== item.id);
    emit();
  }, 4000);
  dismissTimers.set(item.id, handle);
}

export const toast = {
  success(m: string): void {
    push('success', m);
  },
  error(m: string): void {
    push('error', m);
  },
  info(m: string): void {
    push('info', m);
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

let confirmHandler: ((message: string) => Promise<boolean>) | null = null;

/** Registered by the Toaster/confirm host so confirm() can drive a dialog. */
export function registerConfirmHandler(
  handler: ((message: string) => Promise<boolean>) | null,
): void {
  confirmHandler = handler;
}

// Track whether a confirm dialog is open so the shell can treat it as a full
// overlay (on Tauri the content webview is opaque + on top, so an untracked
// overlay renders behind the page).
let confirmOpen = false;
const confirmOpenListeners = new Set<(open: boolean) => void>();
function setConfirmOpen(open: boolean): void {
  confirmOpen = open;
  for (const l of confirmOpenListeners) l(open);
}
export function subscribeConfirmOpen(listener: (open: boolean) => void): () => void {
  confirmOpenListeners.add(listener);
  listener(confirmOpen);
  return () => {
    confirmOpenListeners.delete(listener);
  };
}

export function confirm(message: string): Promise<boolean> {
  if (confirmHandler) {
    setConfirmOpen(true);
    return confirmHandler(message).finally(() => setConfirmOpen(false));
  }
  return Promise.resolve(typeof window !== 'undefined' ? window.confirm(message) : false);
}
