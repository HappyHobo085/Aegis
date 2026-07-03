import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useDialog } from '../hooks/useDialog';
import { useChromeSurface } from '../hooks/useChromeSurfaces';

export interface CommandAction {
  id: string;
  title: string;
  subtitle?: string;
  keywords?: string;
  group?: string;
  run(): void;
  secondaryLabel?: string;
  secondaryRun?(): void;
}

export interface CommandPaletteProps {
  open: boolean;
  actions: CommandAction[];
  onClose(): void;
}

const RECENT_KEY = 'aegis.commandPalette.recent';
const MAX_RECENT = 5;

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeRecent(ids: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, MAX_RECENT)));
  } catch {
    /* localStorage unavailable */
  }
}

function fuzzyScore(action: CommandAction, query: string, recentIds: string[]): number {
  const haystack =
    `${action.title} ${action.subtitle ?? ''} ${action.keywords ?? ''}`.toLowerCase();
  const q = query.toLowerCase();
  if (q.length === 0) {
    const recentIndex = recentIds.indexOf(action.id);
    return recentIndex === -1 ? 0 : 100 - recentIndex;
  }
  if (haystack.includes(q)) return 1000 - haystack.indexOf(q);
  let score = 0;
  let at = 0;
  for (const ch of q) {
    const found = haystack.indexOf(ch, at);
    if (found === -1) return -1;
    score += Math.max(1, 40 - (found - at));
    at = found + 1;
  }
  return score;
}

export function CommandPalette({ open, actions, onClose }: CommandPaletteProps) {
  useChromeSurface('commandPalette', open);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentIds, setRecentIds] = useState<string[]>(readRecent);
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useDialog<HTMLDivElement>(onClose, { initialFocus: inputRef });

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim();
    return actions
      .map((action) => ({ action, score: fuzzyScore(action, q, recentIds) }))
      .filter(({ score }) => score >= 0)
      .sort((a, b) => b.score - a.score || a.action.title.localeCompare(b.action.title))
      .map(({ action }) => action);
  }, [actions, query, recentIds]);

  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  if (!open) return null;

  const run = (action: CommandAction): void => {
    const nextRecent = [action.id, ...recentIds.filter((id) => id !== action.id)];
    setRecentIds(nextRecent.slice(0, MAX_RECENT));
    writeRecent(nextRecent);
    onClose();
    action.run();
  };

  return (
    <div className="command-palette__scrim" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="command-palette"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="sr-only">
          Command palette
        </h2>
        <div className="command-palette__search">
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            aria-label="Search commands"
            placeholder="Search commands, tabs, and settings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter' && e.shiftKey && filtered[activeIndex]?.secondaryRun) {
                e.preventDefault();
                filtered[activeIndex].secondaryRun?.();
              } else if (e.key === 'Enter' && filtered[activeIndex]) {
                e.preventDefault();
                run(filtered[activeIndex]);
              }
            }}
          />
        </div>
        <ul className="command-palette__list" role="listbox" aria-label="Commands">
          {filtered.map((action, index) => (
            <li key={action.id}>
              <button
                type="button"
                className={`command-palette__item${
                  index === activeIndex ? ' command-palette__item--active' : ''
                }`}
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => run(action)}
              >
                <span className="command-palette__item-kicker">
                  {action.group ?? (recentIds.includes(action.id) ? 'Recent' : 'Command')}
                </span>
                <span className="command-palette__item-title">{action.title}</span>
                {action.subtitle && (
                  <span className="command-palette__item-subtitle">{action.subtitle}</span>
                )}
                {action.secondaryRun && (
                  <span
                    role="button"
                    tabIndex={-1}
                    className="command-palette__item-secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      action.secondaryRun?.();
                    }}
                  >
                    {action.secondaryLabel ?? 'More'}
                  </span>
                )}
              </button>
            </li>
          ))}
          {filtered.length === 0 && <li className="command-palette__empty">No commands found.</li>}
        </ul>
      </div>
    </div>
  );
}
