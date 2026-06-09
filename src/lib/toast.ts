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
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== item.id);
    emit();
  }, 4000);
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

export function confirm(message: string): Promise<boolean> {
  if (confirmHandler) {
    return confirmHandler(message);
  }
  return Promise.resolve(typeof window !== 'undefined' ? window.confirm(message) : false);
}
