import styles from './Panels.module.css';

/**
 * The tech's side of the loop: the real handheld app (served at `/tech`), live in an iframe as a
 * second client on the same socket. `embed` tells it to draw just the phone, sized to the frame.
 */
export function PhonePanel({ hospitalId }: { hospitalId: string }) {
  return (
    <section className={styles.phonePanel} aria-labelledby="phone-heading">
      {/* Wide, the phone's lock screen names its owner, so this caption is for screen readers. */}
      <div className={styles.phoneCaption}>
        <h2 id="phone-heading" className={styles.heading}>
          Tech’s phone
        </h2>
        <p className={styles.phoneNote}>What the tech sees when the shelf runs low.</p>
      </div>
      <iframe
        className={styles.phoneFrame}
        src={`/tech?h=${encodeURIComponent(hospitalId)}&embed=1`}
        title="Tech’s phone app"
      />
    </section>
  );
}
