/**
 * mIRC formatting codes, removed rather than drawn.
 *
 * Colour is stripped rather than mapped onto the theme. `readability/READABILITY.md`
 * reserves the warm hues for security state and `src/styles/tokens.test.ts`
 * holds the nick palette inside 186-335deg, so mIRC's sixteen colours have
 * nowhere to land that does not either collide with a meaning the reader is
 * trained to trust or put colour on screen from outside the token system. The
 * emphasis codes go with them; a line already carries Markdown emphasis.
 *
 * `\x03` and `\x04` take their numeric arguments with them. Those digits are
 * ordinary characters, and leaving them behind turns a coloured line into a
 * line with stray numbers in it.
 */
// eslint-disable-next-line no-control-regex
const FORMATTING = /\x03(\d{1,2}(,\d{1,2})?)?|\x04([\da-f]{6}(,[\da-f]{6})?)?|[\x02\x0f\x11\x16\x1d\x1e\x1f]/gi;

export function stripIrcFormatting(text: string): string {
  return text.replace(FORMATTING, "");
}
