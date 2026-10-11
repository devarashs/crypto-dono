/**
 * Alert headlines: a template such as "{name} gifted {count} {subs}" filled in
 * as parts, so the overlay can highlight the numbers without ever parsing text
 * as HTML. Built on the server for every alert kind, so the overlay needs no
 * knowledge of templates.
 */

export type HeadlinePart = {
  readonly text: string;
  /** Drawn in the accent colour: amounts and counts. */
  readonly emphasis: boolean;
};

/**
 * @param template Wording with {placeholders}.
 * @param values Text for each placeholder; placeholders without a value stay
 *   literal, so a typo in a custom template is visible rather than silent.
 * @param emphasised Placeholder names to highlight.
 * @returns Parts in order; adjacent literal text is merged.
 */
export function renderHeadline(
  template: string,
  values: Readonly<Record<string, string>>,
  emphasised: ReadonlySet<string> = new Set(),
): HeadlinePart[] {
  const parts: HeadlinePart[] = [];
  const push = (text: string, emphasis: boolean) => {
    if (text === '') return;
    const previous = parts.at(-1);
    if (previous !== undefined && !previous.emphasis && !emphasis) {
      parts[parts.length - 1] = { text: previous.text + text, emphasis: false };
    } else {
      parts.push({ text, emphasis });
    }
  };

  let cursor = 0;
  for (const match of template.matchAll(/\{([a-z]+)\}/g)) {
    const key = match[1] ?? '';
    const value = Object.hasOwn(values, key) ? values[key] : undefined;
    push(template.slice(cursor, match.index), false);
    push(value ?? match[0], value !== undefined && emphasised.has(key));
    cursor = match.index + match[0].length;
  }
  push(template.slice(cursor), false);
  return parts;
}

/** Plain text of a headline, for logs, speech and tests. */
export function headlineText(parts: readonly HeadlinePart[]): string {
  return parts.map((part) => part.text).join('');
}
