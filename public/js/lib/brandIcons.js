import { svg } from './dom.js';

/**
 * App icons for the Integrations screen, bundled locally so the page never
 * loads third-party assets. Gmail, Google Drive, HubSpot, Zoho and Jira glyphs
 * come from Simple Icons (CC0); the rest are simplified marks drawn here.
 * Every icon is a rounded tile in the brand colour with a white mark.
 */

const SIMPLE = {
  gmail: 'M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z',
  google_drive:
    'M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z',
  hubspot:
    'M18.164 7.93V5.084a2.198 2.198 0 001.267-1.978v-.067A2.2 2.2 0 0017.238.845h-.067a2.2 2.2 0 00-2.193 2.193v.067a2.196 2.196 0 001.252 1.973l.013.006v2.852a6.22 6.22 0 00-2.969 1.31l.012-.01-7.828-6.095A2.497 2.497 0 104.3 4.656l-.012.006 7.697 5.991a6.176 6.176 0 00-1.038 3.446c0 1.343.425 2.588 1.147 3.607l-.013-.02-2.342 2.343a1.968 1.968 0 00-.58-.095h-.002a2.033 2.033 0 102.033 2.033 1.978 1.978 0 00-.1-.595l.005.014 2.317-2.317a6.247 6.247 0 104.782-11.134l-.036-.005zm-.964 9.378a3.206 3.206 0 113.215-3.207v.002a3.206 3.206 0 01-3.207 3.207z',
  jira: 'M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z'
};

const COLORS = {
  outlook: '#0F6CBD',
  gmail: '#EA4335',
  teams: '#5B5FC7',
  slack: '#4A154B',
  docusign: '#4C00FF',
  google_drive: '#1FA463',
  onedrive: '#0364B8',
  salesforce: '#00A1E0',
  hubspot: '#FF7A59',
  zoho_crm: '#E42527',
  jira: '#0052CC'
};

const WHITE = '#ffffff';

/** Hand-drawn marks on a 24×24 grid. */
function drawn(key) {
  switch (key) {
    case 'outlook':
      return [
        svg('rect', { x: 9, y: 6, width: 12, height: 12, rx: 1.5, fill: 'none', stroke: WHITE, 'stroke-width': 1.6 }),
        svg('path', { d: 'M9.5 7.5l5.5 4.5 5.5-4.5', fill: 'none', stroke: WHITE, 'stroke-width': 1.6, 'stroke-linejoin': 'round' }),
        svg('rect', { x: 2.5, y: 4.5, width: 10, height: 15, rx: 1.6, fill: WHITE }),
        svg('ellipse', { cx: 7.5, cy: 12, rx: 2.6, ry: 3.4, fill: 'none', stroke: COLORS.outlook, 'stroke-width': 1.9 })
      ];
    case 'teams':
      return [
        svg('circle', { cx: 17.5, cy: 6.5, r: 2.4, fill: WHITE, opacity: 0.85 }),
        svg('rect', { x: 14.5, y: 10, width: 7, height: 8.5, rx: 3, fill: WHITE, opacity: 0.85 }),
        svg('rect', { x: 2.5, y: 5, width: 13, height: 14, rx: 1.6, fill: WHITE }),
        svg('path', { d: 'M5.5 8.5h7M9 8.5v8', fill: 'none', stroke: COLORS.teams, 'stroke-width': 2.2, 'stroke-linecap': 'round' })
      ];
    case 'slack':
      // one pill-and-node piece, rotated four times around the centre
      return ['#36C5F0', '#2EB67D', '#ECB22E', '#E01E5A'].map((fill, index) =>
        svg(
          'g',
          { transform: `rotate(${index * 90} 12 12)` },
          svg('rect', { x: 3, y: 9.25, width: 8.5, height: 3, rx: 1.5, fill }),
          svg('rect', { x: 8.5, y: 4.75, width: 3, height: 3, rx: 1, fill })
        )
      );
    case 'docusign':
      return [
        svg('path', { d: 'M4 16.5s2.5-7 5-7 1.5 5 3.5 5 3-3.5 4.5-3.5', fill: 'none', stroke: WHITE, 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
        svg('path', { d: 'M4 20h16', stroke: WHITE, 'stroke-width': 1.9, 'stroke-linecap': 'round' }),
        svg('path', { d: 'M15.5 4.5l2.5 2.5 3.5-3.5', fill: 'none', stroke: WHITE, 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
      ];
    case 'onedrive':
    case 'salesforce':
      return [
        svg('path', {
          d: 'M7 18.5h11a4 4 0 00.6-7.96A5.5 5.5 0 008.1 9.1 4.75 4.75 0 007 18.5z',
          fill: WHITE
        })
      ];
    case 'zoho_crm':
      return [
        svg('text', { x: 12, y: 15.6, 'text-anchor': 'middle', 'font-size': 8.2, 'font-weight': 800, 'font-family': 'Arial, sans-serif', fill: WHITE, 'letter-spacing': -0.2 }, 'ZOHO')
      ];
    default:
      return null;
  }
}

/** A brand tile for an integration key, `size` px square. */
export function brandIcon(key, size = 44) {
  const color = COLORS[key] || '#475467';
  const isSlack = key === 'slack';
  const mark = SIMPLE[key]
    ? [svg('path', { d: SIMPLE[key], fill: WHITE, transform: 'translate(12 12) scale(0.62) translate(-12 -12)' })]
    : drawn(key) || [];
  return svg(
    'svg',
    { width: size, height: size, viewBox: '0 0 24 24', class: 'brand-tile', role: 'img', 'aria-hidden': 'true' },
    svg('rect', { x: 0, y: 0, width: 24, height: 24, rx: 5.5, fill: isSlack ? '#ffffff' : color, stroke: isSlack ? '#e4e7ec' : 'none', 'stroke-width': 0.6 }),
    svg('g', { transform: SIMPLE[key] ? null : 'translate(12 12) scale(0.78) translate(-12 -12)' }, ...mark.filter(Boolean))
  );
}

export default brandIcon;
