// electron/main/historyRecorder.ts
import type { WebContents } from 'electron';
import type { HistoryRepo } from './db/historyRepo';

/** The subset of WebContents the recorder needs (kept narrow so it is node-testable with a fake). */
type RecorderWc = Pick<WebContents, 'on' | 'getTitle' | 'getURL'>;

export interface HistoryRecorderOpts {
  wc: RecorderWc;
  repo: HistoryRepo;
  onChanged: () => void;
  /** Whether a committed url should be recorded. Defaults to http(s)-only. */
  isRecordable?: (url: string) => boolean;
}

/** Default scheme filter: only http(s) (excludes about:blank, file:, and app chrome urls). */
function defaultIsRecordable(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

/**
 * Subscribes to the content WebContents' navigation + title events and records
 * page visits into HistoryRepo. Top-frame commits (`did-navigate`) and SPA
 * main-frame in-page navigations (`did-navigate-in-page`) record the current
 * url + title; a later `page-title-updated` for the most-recent url backfills
 * the title. Dedup/trim/timestamps are HistoryRepo's responsibility.
 */
export class HistoryRecorder {
  private readonly wc: RecorderWc;
  private readonly repo: HistoryRepo;
  private readonly onChanged: () => void;
  private readonly isRecordable: (url: string) => boolean;

  /** The url of the most-recent recordable nav, used to attribute late title updates. */
  private lastUrl: string | null = null;

  constructor(opts: HistoryRecorderOpts) {
    this.wc = opts.wc;
    this.repo = opts.repo;
    this.onChanged = opts.onChanged;
    this.isRecordable = opts.isRecordable ?? defaultIsRecordable;

    this.wc.on('did-navigate', (_event: unknown, url: string) => this.onNav(url));
    this.wc.on('did-navigate-in-page', (_event: unknown, url: string, isMainFrame: boolean) => {
      if (isMainFrame) this.onNav(url);
    });
    this.wc.on('page-title-updated', (_event: unknown, title: string) => {
      if (this.lastUrl) {
        this.repo.setMostRecentTitle(this.lastUrl, title);
        this.onChanged();
      }
    });
  }

  private onNav(url: string): void {
    if (!this.isRecordable(url)) return;
    this.lastUrl = url;
    this.repo.record({ url, title: this.wc.getTitle() });
    this.onChanged();
  }
}
