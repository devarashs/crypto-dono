import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain browser module without type declarations.
import { splitAlertTemplate } from '../public/alert-template.js';

describe('splitAlertTemplate', () => {
  it('splits the default template', () => {
    expect(splitAlertTemplate('{name} donated {amount}')).toEqual([
      { type: 'name' },
      { type: 'text', value: ' donated ' },
      { type: 'amount' },
    ]);
  });

  it('keeps leading and trailing text, and repeated placeholders', () => {
    expect(splitAlertTemplate('Wow! {amount} from {name}, thanks {name}!')).toEqual([
      { type: 'text', value: 'Wow! ' },
      { type: 'amount' },
      { type: 'text', value: ' from ' },
      { type: 'name' },
      { type: 'text', value: ', thanks ' },
      { type: 'name' },
      { type: 'text', value: '!' },
    ]);
  });

  it('leaves unknown placeholders and stray braces as literal text', () => {
    expect(splitAlertTemplate('{donor} {Name} {amount')).toEqual([{ type: 'text', value: '{donor} {Name} {amount' }]);
  });

  it('keeps HTML-looking template text literal', () => {
    expect(splitAlertTemplate('<b>{name}</b>')).toEqual([
      { type: 'text', value: '<b>' },
      { type: 'name' },
      { type: 'text', value: '</b>' },
    ]);
  });

  it('handles a template with no placeholders, and adjacent placeholders', () => {
    expect(splitAlertTemplate('New donation!')).toEqual([{ type: 'text', value: 'New donation!' }]);
    expect(splitAlertTemplate('{name}{amount}')).toEqual([{ type: 'name' }, { type: 'amount' }]);
  });
});
