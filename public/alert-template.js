/*
 * Splits the streamer's alert wording (ALERT_TEXT_TEMPLATE) into literal text and
 * placeholders. The overlay builds DOM nodes from the parts, so neither the
 * template nor donor text is ever parsed as HTML, and {amount} can be styled.
 *
 * Plain ES module with no dependencies: loaded by the overlay as is and imported
 * by the unit tests.
 */

/** Placeholders the template may use. Anything else in braces stays literal. */
const placeholderPattern = /\{(name|amount)\}/g;

/**
 * @param {string} template e.g. "{name} donated {amount}!"
 * @returns {Array<{ type: 'text', value: string } | { type: 'name' } | { type: 'amount' }>}
 */
export function splitAlertTemplate(template) {
  const parts = [];
  let cursor = 0;
  for (const match of template.matchAll(placeholderPattern)) {
    if (match.index > cursor) parts.push({ type: 'text', value: template.slice(cursor, match.index) });
    parts.push({ type: match[1] });
    cursor = match.index + match[0].length;
  }
  if (cursor < template.length) parts.push({ type: 'text', value: template.slice(cursor) });
  return parts;
}
