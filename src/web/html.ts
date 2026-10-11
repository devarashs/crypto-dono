/**
 * Minimal HTML templating with escaping by default.
 *
 * Every interpolated value is escaped unless it is already `SafeHtml`, which can
 * only come from another `html` template. Raw strings therefore cannot reach the
 * page unescaped by accident.
 */
import escapeHtml from 'escape-html';

export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

type Interpolation = SafeHtml | string | number | boolean | null | undefined | readonly Interpolation[];

/**
 * Tagged template: `html\`<p>${userText}</p>\``.
 * `null`, `undefined` and `false` render as nothing, so `${condition && html\`…\`}` works.
 */
export function html(strings: TemplateStringsArray, ...values: Interpolation[]): SafeHtml {
  let output = strings[0] ?? '';
  values.forEach((value, index) => {
    output += renderInterpolation(value) + (strings[index + 1] ?? '');
  });
  return new SafeHtml(output);
}

function renderInterpolation(value: Interpolation): string {
  if (value instanceof SafeHtml) return value.value;
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(renderInterpolation).join('');
  return escapeHtml(String(value));
}
