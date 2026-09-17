/**
 * Stable key used for optional title-based de-duplication.
 *
 * Keep punctuation intact: two genuinely different headlines should not be
 * merged merely because their punctuation differs. Case, surrounding space,
 * repeated whitespace, and Unicode presentation variants are ignored.
 */
export function titleKey(title) {
  return String(title ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('en-US');
}
