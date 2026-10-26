import styles from './Panels.module.css';

/**
 * The tech's side of the loop: the real handheld app (served at `/tech`), live in an iframe as a
 * second client on the same socket. `embed` tells it to draw just the phone, sized to the frame.
 */
export function PhonePanel({ hospitalId }: { hospitalId: string }) {
  const src = `/tech?h=${encodeURIComponent(hospitalId)}`;
  return (
    <section className={styles.phonePanel} aria-labelledby="phone-heading">
      <h2 id="phone-heading" className={styles.heading}>
        Tech’s phone
      </h2>
      <p className={styles.phoneNote}>What the tech sees when the shelf runs low.</p>
      <iframe className={styles.phoneFrame} src={`${src}&embed=1`} title="Tech’s phone app" />
      <a className={styles.phoneOpen} href={src} target="_blank" rel="noreferrer">
        Open in its own tab
        <span className={styles.srOnly}> (opens in a new tab)</span>
      </a>
    </section>
  );
}
