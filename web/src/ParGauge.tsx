import styles from './Panels.module.css';

interface Props {
  clean: number;
  min: number;
  max: number;
  breach: boolean;
}

/** Clean pumps on the shelf against the PAR band; the scale runs to max plus headroom. */
export function ParGauge({ clean, min, max, breach }: Props) {
  const scale = max + 2;
  const pct = (n: number) => `${(Math.min(n, scale) / scale) * 100}%`;

  return (
    <section className={styles.panel} aria-labelledby="par-heading">
      <h2 id="par-heading" className={styles.heading}>
        Clean Utility · IV pumps
      </h2>
      <p className={styles.gaugeFigure}>
        <strong className={breach ? styles.alertText : undefined}>{clean}</strong>
        <span className={styles.muted}>
          {' '}
          on shelf · PAR {min}–{max}
        </span>
      </p>
      <div
        className={styles.track}
        role="meter"
        aria-label="Clean IV pumps on the shelf"
        aria-valuemin={0}
        aria-valuemax={scale}
        aria-valuenow={clean}
      >
        <div className={styles.band} style={{ left: pct(min), width: pct(max - min) }} />
        <div
          className={`${styles.fill} ${breach ? styles.fillAlert : ''}`}
          style={{ width: pct(clean) }}
        />
      </div>
      <div className={styles.scale} aria-hidden="true">
        <span style={{ left: pct(min) }}>min {min}</span>
        <span style={{ left: pct(max) }}>max {max}</span>
      </div>
      {breach && <p className={styles.alertText}>Below PAR — restock order raised</p>}
    </section>
  );
}
