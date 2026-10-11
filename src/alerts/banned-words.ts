/**
 * Banned-word matching, shared by alerts and the public leaderboard.
 */

export type BannedWordFilter = {
  /** Replaces each banned word with one star per character. */
  mask(text: string): string;
  /** Drops banned words and tidies the spacing they leave behind. */
  remove(text: string): string;
};

/**
 * One case-insensitive pattern for every banned word. A match must not be part
 * of a longer word ("ass" does not hit "class"), judged by Unicode letters and
 * digits so it works beyond English.
 *
 * This catches plain use. It does not try to catch deliberate evasion (spacing,
 * look-alike characters, leetspeak); no word list can, and trying produces false
 * positives on innocent messages.
 */
export function createBannedWordFilter(bannedWords: readonly string[]): BannedWordFilter {
  const pattern = compileBannedPattern(bannedWords);
  return {
    mask: (text) => (pattern === null ? text : text.replace(pattern, (match) => '*'.repeat([...match].length))),
    remove: (text) => (pattern === null ? text : text.replace(pattern, '').replace(/\s+/g, ' ').trim()),
  };
}

function compileBannedPattern(bannedWords: readonly string[]): RegExp | null {
  const words = bannedWords.map((word) => word.normalize('NFC').trim()).filter((word) => word !== '');
  if (words.length === 0) return null;
  // Longest first, so a phrase wins over a word it contains.
  const alternatives = [...new Set(words)]
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
}
