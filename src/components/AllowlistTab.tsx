// src/components/AllowlistTab.tsx
export interface AllowlistTabProps {
  hosts: string[];
  removeAllowlist(host: string): void;
  clearAllowlist(): void;
}

export function AllowlistTab({ hosts, removeAllowlist, clearAllowlist }: AllowlistTabProps) {
  return (
    <div className="allowlist-tab">
      <div className="allowlist-tab__actions">
        <button type="button" disabled={hosts.length === 0} onClick={() => clearAllowlist()}>
          Clear all
        </button>
      </div>
      {hosts.length === 0 ? (
        <p className="allowlist-tab__empty">No allowlisted hosts.</p>
      ) : (
        <ul className="allowlist-tab__list">
          {hosts.map((host) => (
            <li key={host} className="allowlist-tab__row">
              <span className="allowlist-tab__host">{host}</span>
              <button
                type="button"
                aria-label={`Remove ${host} from allowlist`}
                onClick={() => removeAllowlist(host)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
