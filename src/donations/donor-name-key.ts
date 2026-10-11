/**
 * The key donations are grouped by on the leaderboard: the name compared
 * without regard to case or Unicode presentation ("ＡＮＮ", "ann" and "Ann" are
 * one donor). Computed in the app because SQLite's lower() only folds ASCII.
 *
 * Names are already NFC-normalised with collapsed whitespace when stored (see
 * donation-form.ts); NFKC additionally folds compatibility forms such as
 * full-width letters.
 */
export function donorNameKey(donorName: string): string {
  return donorName.normalize('NFKC').toLowerCase();
}
