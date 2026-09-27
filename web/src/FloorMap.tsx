import {
  FLOOR_HEIGHT,
  FLOOR_NAME,
  FLOOR_WIDTH,
  PAR,
  ZONES,
  type Asset,
} from '@assetpulse/protocol';
import { useEffect, useRef, type PointerEvent } from 'react';
import { dropTarget } from './drop';
import styles from './FloorMap.module.css';
import type { PositionTracker } from './positions';
import { STATUS_META } from './status';

const DOT_R = 11;

interface Props {
  assets: Asset[];
  positions: PositionTracker;
  parBreach: boolean;
  onMove: (assetId: string, toZoneId: string) => void;
}

interface Drag {
  assetId: string;
  status: Asset['status'];
  fromZoneId: string;
}

function toSvgPoint(svg: SVGSVGElement, e: PointerEvent): { x: number; y: number } {
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

function zoneAt(p: { x: number; y: number }): string | null {
  const zone = ZONES.find(
    ({ rect }) =>
      p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h,
  );
  return zone?.id ?? null;
}

/**
 * Pointer drag for the dots: the dot is pinned under the pointer via the tracker, and a drop that
 * `dropTarget` accepts hands off to `onMove`; any other drop lets the dot glide back.
 */
function useDotDrag(positions: PositionTracker, onMove: Props['onMove']) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);

  const start = (asset: Asset) => (e: PointerEvent<SVGGElement>) => {
    const svg = svgRef.current;
    if (!svg || e.button !== 0) return;
    svg.setPointerCapture(e.pointerId);
    drag.current = { assetId: asset.id, status: asset.status, fromZoneId: asset.zoneId };
    positions.hold(asset.id, toSvgPoint(svg, e));
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    if (drag.current) positions.hold(drag.current.assetId, toSvgPoint(e.currentTarget, e));
  };
  const end = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const to = dropTarget(d.status, d.fromZoneId, zoneAt(toSvgPoint(e.currentTarget, e)));
    if (to) onMove(d.assetId, to);
    else positions.release(d.assetId, performance.now());
  };
  const cancel = () => {
    if (drag.current) positions.release(drag.current.assetId, performance.now());
    drag.current = null;
  };

  return { svgRef, start, move, end, cancel };
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

export function FloorMap({ assets, positions, parBreach, onMove }: Props) {
  const dotRef = useDotAnimation(assets, positions);
  const drag = useDotDrag(positions, onMove);

  return (
    <figure className={styles.frame}>
      <svg
        ref={drag.svgRef}
        className={styles.map}
        onPointerMove={drag.move}
        onPointerUp={drag.end}
        onPointerCancel={drag.cancel}
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
            <g
              key={asset.id}
              ref={dotRef(asset.id)}
              className={styles.dot}
              onPointerDown={drag.start(asset)}
            >
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
