import type { AssetStatus } from '@assetpulse/protocol';

/** Each status has a letter as well as a hue, so status never rests on color alone. */
export const STATUS_META: Record<AssetStatus, { letter: string; label: string; color: string }> = {
  CLEAN: { letter: 'C', label: 'Clean', color: 'var(--status-clean)' },
  IN_USE: { letter: 'U', label: 'In use', color: 'var(--status-in-use)' },
  SOILED: { letter: 'S', label: 'Soiled', color: 'var(--status-soiled)' },
  REPROCESSING: { letter: 'P', label: 'Reprocessing', color: 'var(--status-reprocessing)' },
  READY: { letter: 'R', label: 'Ready', color: 'var(--status-ready)' },
};
