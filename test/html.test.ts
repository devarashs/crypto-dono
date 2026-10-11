import { describe, expect, it } from 'vitest';
import { html, SafeHtml } from '../src/web/html.ts';

describe('html', () => {
  it('escapes interpolated strings', () => {
    expect(html`<p>${'<script>alert("x")</script> & \'q\''}</p>`.value).toBe(
      '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;</p>',
    );
  });

  it('escapes values placed in attributes', () => {
    expect(html`<input value="${'" onfocus="alert(1)'}">`.value).toBe(
      '<input value="&quot; onfocus=&quot;alert(1)">',
    );
  });

  it('nests templates without double escaping', () => {
    const inner = html`<b>${'a&b'}</b>`;
    expect(html`<p>${inner}</p>`.value).toBe('<p><b>a&amp;b</b></p>');
  });

  it('renders arrays, numbers and booleans', () => {
    expect(html`${[html`<i>1</i>`, '<2>', 3]}|${true}`.value).toBe('<i>1</i>&lt;2&gt;3|true');
  });

  it('renders null, undefined and false as nothing', () => {
    expect(html`[${null}${undefined}${false}]`.value).toBe('[]');
  });

  it('returns SafeHtml that stringifies to its value', () => {
    const result = html`<p>hi</p>`;
    expect(result).toBeInstanceOf(SafeHtml);
    expect(String(result)).toBe('<p>hi</p>');
  });
});
