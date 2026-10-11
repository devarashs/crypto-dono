/**
 * Turns the configured SOCIAL_LINKS into what pages render: an icon, an
 * accessible label, and a short readable address for places where the link
 * cannot be clicked, such as a stream scene.
 */
import type { SocialLink } from '../config.ts';
import { genericLinkIcon, socialIcons } from './social-icons.ts';

export type SocialLinkModel = {
  /** Platform name, used as the link's accessible label, e.g. "Twitch". */
  readonly label: string;
  readonly url: string;
  /** 24×24 SVG path. */
  readonly iconPath: string;
  /** Host and path without "www." or a trailing slash, e.g. "twitch.tv/machinearash". */
  readonly display: string;
};

export function toSocialLinkModels(links: readonly SocialLink[]): SocialLinkModel[] {
  return links.map((link) => {
    const icon = socialIcons[link.platform] ?? genericLinkIcon;
    const url = new URL(link.url);
    const display = `${url.hostname.replace(/^www\./, '')}${decodeURIComponent(url.pathname)}`.replace(/\/+$/, '');
    // A generic link is labelled by its site, which tells a screen reader more than "Link".
    const label = link.platform === 'link' ? url.hostname : icon.title;
    return { label, url: link.url, iconPath: icon.path, display };
  });
}
