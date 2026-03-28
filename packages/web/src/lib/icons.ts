/**
 * Shared SVG icon paths — single source of truth for all icons.
 * Usage in Astro: <Fragment set:html={icons.document(16)} />
 * Usage in React: <span dangerouslySetInnerHTML={{ __html: icons.document(16) }} />
 */

function svg(size: number, strokeWidth: number, content: string): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" style="vertical-align:-0.125em">${content}</svg>`;
}

export const icons = {
  /** Document/file icon — folded corner with text lines */
  document: (size = 16) => svg(size, 1.5,
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'),

  /** Document without lines — for simpler contexts */
  documentSimple: (size = 16) => svg(size, 1.5,
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),

  /** Space/book icon */
  book: (size = 20) => svg(size, 1.5,
    '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),

  /** Person icon — for personal spaces */
  person: (size = 20) => svg(size, 1.5,
    '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),

  /** Bell/notification icon */
  bell: (size = 16) => svg(size, 2,
    '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'),

  /** Comment/chat bubble */
  comment: (size = 16) => svg(size, 2,
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),

  /** Edit/pencil with page */
  edit: (size = 15) => svg(size, 2,
    '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>'),

  /** Rename/pencil simple */
  pencil: (size = 14) => svg(size, 1.5,
    '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>'),

  /** Copy/duplicate */
  copy: (size = 15) => svg(size, 2,
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),

  /** Duplicate (same as copy but thinner) */
  duplicate: (size = 14) => svg(size, 1.5,
    '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),

  /** Delete/trash */
  trash: (size = 14) => svg(size, 1.5,
    '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14H7L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>'),

  /** Search/magnifying glass */
  search: (size = 14) => svg(size, 2,
    '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),

  /** Clock/history */
  clock: (size = 13) => svg(size, 2,
    '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),

  /** More/kebab (vertical dots) */
  more: (size = 15) => svg(size, 2,
    '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>'),

  /** Chevron right (for expand/collapse) */
  chevron: (size = 12) => svg(size, 2,
    '<polyline points="9 18 15 12 9 6"/>'),

  /** Plus/add */
  plus: (size = 16) => svg(size, 2,
    '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),

  /** Link icon */
  link: (size = 12) => svg(size, 2,
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),

  /** Terminal/CLI */
  terminal: (size = 16) => svg(size, 2,
    '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
};
