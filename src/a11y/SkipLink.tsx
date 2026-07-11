/**
 * A "skip to document" link: the first focusable element on the page, visually
 * hidden until focused. Lets keyboard and screen-reader users jump past the
 * toolbar straight to the content.
 */
export function SkipLink() {
  return (
    <a className="folio-skip-link" href="#folio-main">
      Skip to document
    </a>
  );
}
