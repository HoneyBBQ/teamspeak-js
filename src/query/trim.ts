/**
 * Trimming by index. A regular expression such as `/\/+$/` retries from every
 * start of a long run that does not end the string, which takes quadratic time
 * on input a server or a caller controls; these walk the string once.
 */

/** `text` without the `/` characters at its end. */
export function trimTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x2f) end--;
  return end === text.length ? text : text.slice(0, end);
}

/** `text` without the `\r` characters at either end. */
export function trimCarriageReturns(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) === 0x0d) start++;
  while (end > start && text.charCodeAt(end - 1) === 0x0d) end--;
  return start === 0 && end === text.length ? text : text.slice(start, end);
}
