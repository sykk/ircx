/**
 * RFC 2812 §2.3.1: a nickname begins with a letter or one of the "special"
 * characters `[]\`_^{|}`, and continues with those, digits, or `-`. A leading
 * digit or `-` is the rule people trip over, so it gets its own message.
 *
 * The length limit is the server's, not the RFC's: the grammar says nine and no
 * network has enforced that in twenty years.
 */
const SPECIAL = "[]\\`_^{|}";

/** What most ircds allow when we have nothing better to go on. */
export const COMMON_NICK_LIMIT = 30;

function isLetter(c: string): boolean {
  return /^[A-Za-z]$/.test(c);
}

function isDigit(c: string): boolean {
  return /^[0-9]$/.test(c);
}

function isSpecial(c: string): boolean {
  return SPECIAL.includes(c);
}

/** Null when the server will accept it; otherwise what to change, in words. */
export function nicknameProblem(nick: string, limit: number): string | null {
  if (nick.length === 0) {
    return "Choose a nickname — it is how everyone on the network sees you.";
  }
  if (nick.includes(" ")) {
    return "A nickname cannot contain spaces. Use an underscore instead.";
  }

  const first = nick[0] as string;
  if (isDigit(first)) {
    return "A nickname cannot start with a digit. Move the number further along.";
  }
  if (first === "-") {
    return "A nickname cannot start with a hyphen. Start with a letter.";
  }
  if (!isLetter(first) && !isSpecial(first)) {
    return `A nickname cannot start with ${quote(first)}. Start with a letter.`;
  }

  for (const c of nick.slice(1)) {
    if (isLetter(c) || isDigit(c) || isSpecial(c) || c === "-") continue;
    return `A nickname cannot contain ${quote(c)}. Letters, digits and - _ [ ] \\ \` ^ { | } are allowed.`;
  }

  if (nick.length > limit) {
    return `This network allows ${limit} characters in a nickname; this one is ${nick.length}.`;
  }
  return null;
}

function quote(c: string): string {
  return `"${c}"`;
}
