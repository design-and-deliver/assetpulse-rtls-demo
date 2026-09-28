import { PAR, ZONES, type Asset, type ParState } from '@assetpulse/protocol';
import {
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import styles from './Panels.module.css';

const ROOMS = ZONES.filter((z) => z.kind === 'room');
/** Pixels a press must travel before it counts as a drag rather than a tap. */
const DRAG_SLOP = 5;

interface Drag {
  assetId: string;
  fromZoneId: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  moving: boolean;
  overZoneId: string | null;
}

type Move = (assetId: string, toZoneId: string) => void;

function zoneAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-zone]');
  return el?.dataset.zone ?? null;
}

/** Advances a drag to a pointer event's position; null when no drag is under way. */
function track(drag: Drag | null, e: { clientX: number; clientY: number }): Drag | null {
  if (!drag) return null;
  const { clientX: x, clientY: y } = e;
  const moving = drag.moving || Math.hypot(x - drag.startX, y - drag.startY) > DRAG_SLOP;
  return { ...drag, x, y, moving, overZoneId: moving ? zoneAt(x, y) : null };
}

/**
 * Pointer drag (mouse and touch) plus tap-to-select: tap a pump, then tap a zone. The tap path is
 * also the keyboard path, since pills and "Move here" are real buttons.
 */
function useDragMove(assets: Asset[], onMove: Move) {
  const [drag, setDragState] = useState<Drag | null>(null);
  /** The drag as of the latest pointer event; `drag` is its rendered copy. */
  const live = useRef<Drag | null>(null);
  const setDrag = (next: Drag | null) => {
    live.current = next;
    setDragState(next);
  };
  const [selected, setSelected] = useState<string | null>(null);
  /** Swallows the click the browser fires after a drag ends on the same pill. */
  const dragged = useRef(false);

  const zoneOf = (assetId: string) => assets.find((a) => a.id === assetId)?.zoneId ?? null;
  const moveTo = (assetId: string, toZoneId: string | null) => {
    if (toZoneId && toZoneId !== zoneOf(assetId)) onMove(assetId, toZoneId);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>, asset: Asset) => {
    if (e.button !== 0) return;
    // The pill may remount in its new zone, so a drag's trailing click can go missing.
    dragged.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { clientX: x, clientY: y } = e;
    setDrag({
      assetId: asset.id,
      fromZoneId: asset.zoneId,
      startX: x,
      startY: y,
      x,
      y,
      moving: false,
      overZoneId: null,
    });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const next = track(live.current, e);
    if (next) setDrag(next);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    // Judged from this event, not the last render: a fast drag can end before its move commits.
    const last = track(live.current, e);
    setDrag(null);
    if (!last) return;
    dragged.current = last.moving;
    if (last.moving) moveTo(last.assetId, last.overZoneId);
  };
  const onPillClick = (assetId: string) => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    setSelected((s) => (s === assetId ? null : assetId));
  };
  const onZoneClick = (zoneId: string) => {
    if (!selected) return;
    moveTo(selected, zoneId);
    setSelected(null);
  };

  const pillHandlers = (asset: Asset) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => onPointerDown(e, asset),
    onPointerMove,
    onPointerUp,
    onPointerCancel: () => setDrag(null),
    onClick: (e: ReactMouseEvent) => {
      e.stopPropagation();
      onPillClick(asset.id);
    },
  });

  return { drag, selected, pillHandlers, onZoneClick };
}

type DragMove = ReturnType<typeof useDragMove>;

function Pill({ asset, dm }: { asset: Asset; dm: DragMove }) {
  const lifted = dm.drag?.moving && dm.drag.assetId === asset.id;
  const inUse = asset.status === 'IN_USE';
  const cls = [
    styles.pumpPill,
    inUse ? styles.pumpInUse : '',
    dm.selected === asset.id ? styles.pumpSelected : '',
    lifted ? styles.pumpLifted : '',
  ].join(' ');
  return (
    <button
      type="button"
      className={cls}
      aria-pressed={dm.selected === asset.id}
      data-pump={asset.id}
      {...dm.pillHandlers(asset)}
    >
      {asset.id}
    </button>
  );
}

function DropZone({
  zoneId,
  className,
  assets,
  dm,
  children,
}: {
  zoneId: string;
  className: string | undefined;
  assets: Asset[];
  dm: DragMove;
  children?: ReactNode;
}) {
  const over = dm.drag?.moving && dm.drag.overZoneId === zoneId && dm.drag.fromZoneId !== zoneId;
  const here = assets.filter((a) => a.zoneId === zoneId);
  const canTarget = dm.selected !== null && here.every((a) => a.id !== dm.selected);
  return (
    <div
      data-zone={zoneId}
      className={`${className} ${over ? styles.zoneOver : ''} ${canTarget ? styles.zoneTarget : ''}`}
      onClick={() => dm.onZoneClick(zoneId)}
    >
      {children}
      <div className={styles.pills}>
        {here.map((a) => (
          <Pill key={a.id} asset={a} dm={dm} />
        ))}
        {canTarget && (
          <button type="button" className={styles.moveHere}>
            Move {dm.selected} here
          </button>
        )}
      </div>
    </div>
  );
}

function BufferBadge({ clean, par }: { clean: number; par: ParState }) {
  const breach = par.state === 'BREACH';
  return (
    <span
      className={`${styles.badge} ${breach ? styles.badgeAlert : styles.badgeOk}`}
      role="status"
    >
      {breach ? '⚠ Below PAR' : '✓ Buffer OK'} ({clean}/{par.max})
    </span>
  );
}

/** Panels 1 and 2: the Clean Utility shelf and the patient rooms, one drag surface. */
export function Stock({
  assets,
  par,
  clean,
  onMove,
}: {
  assets: Asset[];
  par: ParState | null;
  clean: number;
  onMove: Move;
}) {
  const dm = useDragMove(assets, onMove);
  const ghost = dm.drag?.moving ? dm.drag : null;
  return (
    <>
      <section className={styles.panel} aria-labelledby="shelf-heading">
        <div className={styles.panelTop}>
          <h2 id="shelf-heading" className={styles.heading}>
            Clean Utility{' '}
            <span className={styles.headingNote}>
              PAR {PAR.max} · min {PAR.min}
            </span>
          </h2>
          {par && <BufferBadge clean={clean} par={par} />}
        </div>
        <DropZone zoneId={PAR.zoneId} className={styles.shelf} assets={assets} dm={dm} />
      </section>

      <section className={styles.panel} aria-labelledby="rooms-heading">
        <h2 id="rooms-heading" className={styles.heading}>
          Patient rooms
        </h2>
        <div className={styles.rooms}>
          {ROOMS.map((room) => (
            <DropZone
              key={room.id}
              zoneId={room.id}
              className={styles.room}
              assets={assets}
              dm={dm}
            >
              <span className={styles.roomLabel}>{room.label}</span>
            </DropZone>
          ))}
        </div>
      </section>

      {ghost && (
        <span
          className={`${styles.pumpPill} ${styles.pumpGhost}`}
          style={{ left: ghost.x, top: ghost.y }}
          aria-hidden="true"
        >
          {ghost.assetId}
        </span>
      )}
    </>
  );
}
