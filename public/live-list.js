/*
 * Live lists for OBS pages: poll a JSON feed and redraw a list only when its
 * contents changed, fading in entries that are new since the last draw. Used by
 * the table under the camera (board.js) and the stream scenes (scene.js).
 *
 * Plain ES module, no build step. Rows are built by the caller with
 * textContent, so donor names are never parsed as HTML.
 */

/**
 * Fetches `url` now and every `intervalMs`, calling `onData` with the parsed
 * body only when the response text changed. A failed request keeps whatever is
 * on screen.
 */
export function pollJson(url, intervalMs, onData) {
  let lastText = null;
  const tick = async () => {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) return;
      const text = await response.text();
      if (text === lastText) return;
      lastText = text;
      onData(JSON.parse(text));
    } catch {
      // Unreachable for a moment: keep the last good list on screen.
    }
  };
  void tick();
  setInterval(() => void tick(), intervalMs);
}

/**
 * A list element that knows what it showed last time.
 *
 * @param list The <ol>/<ul> to fill.
 * @param emptyState Element shown instead when there are no items.
 * @param keyOf Identity of an item, to spot new entries.
 * @param renderItem Builds one <li> for an item at a position.
 * @returns update(items): redraws, marking entries new since the previous draw.
 */
export function createLiveList(list, emptyState, keyOf, renderItem) {
  let previousKeys = null;
  return (items) => {
    const keys = items.map(keyOf);
    // Nothing is "new" on the first draw, so the page does not animate on load.
    const known = new Set(previousKeys ?? keys);
    previousKeys = keys;
    emptyState.hidden = items.length > 0;
    list.replaceChildren(
      ...items.map((item, index) => {
        const row = renderItem(item, index);
        if (!known.has(keys[index])) row.classList.add('is-new');
        return row;
      }),
    );
  };
}

/** Builds an element with a class and text, the only way these pages create text. */
export function textElement(tagName, className, text) {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  return element;
}
