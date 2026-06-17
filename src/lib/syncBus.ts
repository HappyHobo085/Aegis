// A tiny in-renderer pub/sub so a `sync.changed` event (relayed by useSync) drives a
// TARGETED per-store refetch — never a full reload. Domain hooks subscribe to the
// namespace(s) they own (favorites/saved/allowlist); useSync publishes when the engine
// reports a post-merge change for that namespace.
type Listener = (changedUuids: string[]) => void;

const listeners = new Map<string, Set<Listener>>();

/** Subscribe to changes for `namespace`. Returns an unsubscribe fn. */
export function onSyncChange(namespace: string, fn: Listener): () => void {
  let set = listeners.get(namespace);
  if (!set) {
    set = new Set();
    listeners.set(namespace, set);
  }
  set.add(fn);
  return () => {
    set?.delete(fn);
  };
}

/** Publish a post-merge change for `namespace` to its subscribers. */
export function publishSyncChange(namespace: string, changedUuids: string[]): void {
  listeners.get(namespace)?.forEach((fn) => {
    try {
      fn(changedUuids);
    } catch {
      /* a listener error must not break the others */
    }
  });
}
