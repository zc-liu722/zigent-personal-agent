/** Canvas and diagram engines need computed color values instead of CSS references. */
export function readColors() {
  const style = getComputedStyle(document.documentElement);
  return name => style.getPropertyValue(`--${name}`).trim();
}
