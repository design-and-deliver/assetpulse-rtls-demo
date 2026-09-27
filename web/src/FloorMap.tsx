import {
  FLOOR_HEIGHT,
  FLOOR_NAME,
  FLOOR_WIDTH,
  PAR,
  ZONES,
  type Asset,
} from '@assetpulse/protocol';
import { useEffect, useRef } from 'react';
import styles from './FloorMap.module.css';
import type { PositionTracker } from './positions';
import { STATUS_META } from './status';

const DOT_R = 11;

interface Props {
  assets: Asset[];
  positions: PositionTracker;
  parBreach: boolean;
}

/** Moves each dot's `<g>` every animation frame, straight on the DOM — React renders only on events. */
function useDotAnimation(assets: Asset[], positions: PositionTracker) {
  const dots = useRef(new Map<string, SVGGElement>());
  const latest = useRef(assets);

  useEffect(() => {
    latest.current = assets;
  }, [assets]);

  useEffect(() => {
    let frame = 0;
    const paint = () => {
      const now = performance.now();
      for (const asset of latest.current) {
        const p = positions.pointFor(asset.id, asset.zoneId, now);
        dots.current.get(asset.id)?.setAttribute('transform', `translate(${p.x} ${p.y})`);
      }
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [positions]);

  return (id: string) => (el: SVGGElement | null) => {
    if (el) dots.current.set(id, el);
    else dots.current.delete(id);
  };
}

export function FloorMap({ assets, positions, parBreach }: Props) {
  const dotRef = useDotAnimation(assets, positions);

  return (
    <figure className={styles.frame}>
      <svg
        className={styles.map}
        viewBox={`0 0 ${FLOOR_WIDTH} ${FLOOR_HEIGHT}`}
        role="img"
        aria-label={`Floor ${FLOOR_NAME}: ${assets.length} IV pumps`}
      >
        {ZONES.map((zone) => {
          const breach = parBreach && zone.id === PAR.zoneId;
          return (
            <g key={zone.id}>
              <rect
                className={`${styles.zone} ${styles[zone.kind]} ${breach ? styles.breach : ''}`}
                x={zone.rect.x}
                y={zone.rect.y}
                width={zone.rect.w}
                height={zone.rect.h}
                rx={6}
              />
              <text className={styles.zoneLabel} x={zone.rect.x + 10} y={zone.rect.y + 20}>
                {zone.label}
              </text>
            </g>
          );
        })}
        {assets.map((asset) => {
          const meta = STATUS_META[asset.status];
          return (
            <g key={asset.id} ref={dotRef(asset.id)} className={styles.dot}>
              <title>{`${asset.id} · ${meta.label} · ${asset.zoneId}`}</title>
              <circle r={DOT_R} fill={meta.color} />
              <text className={styles.dotLetter} dy="0.35em">
                {meta.letter}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className={styles.legend}>
        {Object.values(STATUS_META).map((meta) => (
          <span key={meta.label} className={styles.legendItem}>
            <svg width={20} height={20} viewBox="-10 -10 20 20" aria-hidden="true">
              <circle r={9} fill={meta.color} />
              <text className={styles.dotLetter} dy="0.35em">
                {meta.letter}
              </text>
            </svg>
            {meta.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
