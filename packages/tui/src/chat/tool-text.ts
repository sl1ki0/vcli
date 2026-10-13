/** A shifted UTF-16 boundary can add one unit; each displayed page stays within 4,000. */
export const toolPageStride = 3999;

function boundary(text: string, index: number): number {
  const next = text.charCodeAt(index);
  const previous = text.charCodeAt(index - 1);
  return next >= 0xdc00 && next <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff
    ? index - 1
    : index;
}

/** Adjacent slices share adjusted boundaries, retaining each complete Unicode character once. */
export function sliceToolText(text: string, start: number, end: number): string {
  return text.slice(boundary(text, start), boundary(text, end));
}
