/** Inline SVG icon set, drawn on a 24px grid with a consistent 1.8 stroke. */

const PATHS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.08a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 1 1 0-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.04-1.56V3a2 2 0 1 1 4 0v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 1 1 0 4h-.08A1.7 1.7 0 0 0 19.4 15Z"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  trash:
    '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  external:
    '<path d="M15 3h6v6M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z"/><path d="m9 12 2 2 4-4"/>',
  redirect: '<path d="m16 3 4 4-4 4M20 7H4"/><path d="m8 21-4-4 4-4M4 17h16"/>',
  block: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  headers: '<path d="M4 6h16M4 12h10M4 18h7"/><path d="M17 15v6M14 18h6"/>',
  sliders: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3"/><path d="M14 2v4M8 10v4M16 18v4"/>',
  cookie:
    '<path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5Z"/><path d="M8.5 8.5h.01M12 12h.01M15.5 15.5h.01M8.5 15.5h.01"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  rotate: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  alert: '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  zap: '<path d="M13 2 3 14h8l-1 8 10-12h-8l1-8Z"/>',
  lock: '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  auto: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M10 12l-2 2 2 2M14 16l2-2-2-2"/>',
  filter: '<path d="M22 3H2l8 9.5V19l4 2v-8.5Z"/>',
  arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  arrowUpRight: '<path d="M7 17 17 7M8 7h9v9"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  play: '<path d="m7 4 13 8-13 8Z"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.5 12.5 8-8M15 5l3 3M17 3l4 4"/>',
};

export function icon(name, size = 16, className = '') {
  const body = PATHS[name] || PATHS.info;
  return `<svg class="ico ${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

export const TYPE_ICON = {
  allow: 'shield',
  redirect: 'redirect',
  block: 'block',
  headers: 'headers',
  cookie: 'cookie',
};

export function brandMark(size = 30) {
  return `<svg class="brand-glyph" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <rect x="1" y="1" width="30" height="30" rx="9" fill="#151917"/>
    <rect x="1.5" y="1.5" width="29" height="29" rx="8.5" fill="none" stroke="#2B322C"/>
    <path d="M8 12.2h14.5M18.6 8.4l4 3.8-4 3.8" fill="none" stroke="#C8F45A" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M24 19.8H9.5M13.4 16l-4 3.8 4 3.8" fill="none" stroke="#F2F5EE" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

export function emptyArt() {
  return `<svg class="empty-art" width="236" height="150" viewBox="0 0 236 150" fill="none" aria-hidden="true">
    <path d="M43 79c0-35 31-61 72-61s78 28 78 63-35 60-79 60-71-26-71-62Z" stroke="currentColor" stroke-opacity=".16" stroke-dasharray="3 6"/>
    <rect x="58" y="48" width="120" height="68" rx="10" fill="var(--surface)" stroke="currentColor" stroke-opacity=".25"/>
    <path d="M58 63h120" stroke="currentColor" stroke-opacity=".22"/>
    <circle cx="69" cy="55.5" r="2.1" fill="currentColor" fill-opacity=".35"/>
    <circle cx="77" cy="55.5" r="2.1" fill="currentColor" fill-opacity=".2"/>
    <circle cx="85" cy="55.5" r="2.1" fill="currentColor" fill-opacity=".2"/>
    <path d="M74 92h52" stroke="currentColor" stroke-opacity=".22" stroke-linecap="round"/>
    <path d="M74 82h28" stroke="currentColor" stroke-opacity=".18" stroke-linecap="round"/>
    <rect x="74" y="70" width="36" height="5" rx="2.5" fill="var(--accent)" fill-opacity=".55"/>
    <rect x="132" y="78" width="30" height="18" rx="5" fill="var(--accent-soft)" stroke="var(--accent-strong)" stroke-opacity=".55"/>
    <path d="m138 88 4 4 8-8" stroke="var(--ink)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M188 60h10M188 67h6M188 74h10" stroke="currentColor" stroke-opacity=".24" stroke-linecap="round"/>
    <circle cx="47" cy="92" r="4.5" fill="var(--accent)"/>
    <path d="M188 92c10 9 19 11 29 8" stroke="currentColor" stroke-opacity=".2" stroke-dasharray="2 5"/>
    <circle cx="220" cy="99" r="3.2" fill="currentColor" fill-opacity=".28"/>
    <path d="M29 62c-5 8-5 17-1 25" stroke="currentColor" stroke-opacity=".16" stroke-dasharray="2 5"/>
    <circle cx="27" cy="55" r="3" fill="currentColor" fill-opacity=".24"/>
  </svg>`;
}
