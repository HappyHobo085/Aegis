import { useEffect, useRef } from 'react';
import type { DownloadEntry } from '../../shared/types';
import { toast } from '../lib/toast';

export function useDownloadToasts(
  downloads: DownloadEntry[],
  actions: {
    openFile(id: number): Promise<void>;
    showInFolder(id: number): Promise<void>;
  },
): void {
  const seenRef = useRef(new Map<number, DownloadEntry['state']>());
  const mountedRef = useRef(false);

  useEffect(() => {
    const previous = seenRef.current;
    const next = new Map<number, DownloadEntry['state']>();

    for (const download of downloads) {
      next.set(download.id, download.state);
      const prevState = previous.get(download.id);
      if (!mountedRef.current) continue;

      if (prevState === undefined && download.state === 'progressing') {
        toast.info(`Downloading ${download.filename}…`, { durationMs: 3000 });
      } else if (prevState !== download.state && download.state === 'completed') {
        toast.info(`Downloaded ${download.filename}.`, {
          durationMs: 7000,
          action: {
            label: 'Open',
            onClick: () => {
              void actions.openFile(download.id);
            },
          },
        });
      } else if (prevState !== download.state && download.state === 'interrupted') {
        toast.error(`Download failed: ${download.filename}.`);
      } else if (prevState !== download.state && download.state === 'cancelled') {
        toast.info(`Download cancelled: ${download.filename}.`, { durationMs: 3000 });
      }
    }

    seenRef.current = next;
    mountedRef.current = true;
  }, [downloads, actions]);
}
