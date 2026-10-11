import { describe, expect, it } from 'vitest';
import { toSocialLinkModels } from '../src/web/social-links.ts';

describe('toSocialLinkModels', () => {
  it('labels known platforms and shortens the address for display', () => {
    expect(
      toSocialLinkModels([
        { platform: 'twitch', url: 'https://www.twitch.tv/machinearash' },
        { platform: 'youtube', url: 'https://www.youtube.com/@machinearash/' },
        { platform: 'discord', url: 'https://discord.gg/jxpvnvPg9z' },
      ]).map(({ label, display }) => ({ label, display })),
    ).toEqual([
      { label: 'Twitch', display: 'twitch.tv/machinearash' },
      { label: 'YouTube', display: 'youtube.com/@machinearash' },
      { label: 'Discord', display: 'discord.gg/jxpvnvPg9z' },
    ]);
  });

  it('names a generic link by its site and uses the generic icon', () => {
    const [link] = toSocialLinkModels([{ platform: 'link', url: 'https://devarash.example/blog' }]);
    expect(link).toMatchObject({ label: 'devarash.example', display: 'devarash.example/blog' });
    expect(link?.iconPath).toMatch(/^M14 3h7v7/);
  });

  it('shows a bare domain without a trailing slash, and decodes the path', () => {
    expect(toSocialLinkModels([{ platform: 'link', url: 'https://example.com/' }])[0]?.display).toBe('example.com');
    expect(toSocialLinkModels([{ platform: 'link', url: 'https://example.com/caf%C3%A9' }])[0]?.display).toBe('example.com/café');
  });
});
