import type { AssetStatus } from '@assetpulse/protocol';

/** Status words for copy; on screen, a pump's status is simply which panel it sits in. */
export const STATUS_META: Record<AssetStatus, { label: string }> = {
  CLEAN: { label: 'Clean' },
  IN_USE: { label: 'In use' },
};
