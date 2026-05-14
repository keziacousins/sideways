/**
 * Build the sidebar nav tree from sections and documents.
 *
 * Hierarchy comes from each doc's server-side `path` field, which encodes
 * its location within the section (e.g. "architecture/overview.md"). Path
 * components become directory headers; `index.md` in a directory is the
 * clickable page for that header.
 */

interface Section {
  id: string;
  slug: string;
  title: string;
  parentId: string | null;
  position: number;
}

interface Doc {
  id?: string;
  slug: string;
  title: string;
  sectionId: string | null;
  /** Server-owned path within the section. */
  path: string;
  parentId?: string | null;
  tags?: string[];
  position?: number;
  unread?: boolean;
}

export type NavItem =
  | { type: "section"; slug: string; title: string; children: NavItem[] }
  | {
      /** A path-component group. Non-clickable unless `docSlug` is set
       *  (i.e. the directory has an `index.md` to act as its page). */
      type: "directory";
      name: string;
      children: NavItem[];
      docSlug?: string;
      unread?: boolean;
    }
  | { type: "doc"; slug: string; title: string; unread?: boolean };

/** Title-case a directory segment for display (e.g. "event-system" → "Event System"). */
function titleizeDir(name: string): string {
  return name
    .split("-")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Build a directory tree from a flat list of docs (with paths). */
function buildPathTree(docs: Doc[]): NavItem[] {
  type Node = { docs: Doc[]; subdirs: Map<string, Node> };
  const root: Node = { docs: [], subdirs: new Map() };

  for (const doc of docs) {
    const parts = (doc.path || `${doc.slug}.md`).split("/");
    const segments = parts.slice(0, -1);
    let node = root;
    for (const seg of segments) {
      if (!node.subdirs.has(seg)) node.subdirs.set(seg, { docs: [], subdirs: new Map() });
      node = node.subdirs.get(seg)!;
    }
    node.docs.push(doc);
  }

  function render(node: Node): NavItem[] {
    const items: NavItem[] = [];

    // Directories first, alphabetical by segment name.
    const dirs = [...node.subdirs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [name, child] of dirs) {
      const idx = child.docs.find(d => {
        const last = (d.path || "").split("/").pop();
        return last === "index.md";
      });
      const childWithoutIndex: Node = idx
        ? { docs: child.docs.filter(d => d !== idx), subdirs: child.subdirs }
        : child;
      items.push({
        type: "directory",
        name: idx?.title ?? titleizeDir(name),
        docSlug: idx?.slug,
        unread: idx?.unread,
        children: render(childWithoutIndex),
      });
    }

    // Then loose docs at this level, sorted by position then title.
    const sortedDocs = [...node.docs]
      .filter(d => (d.path || "").split("/").pop() !== "index.md")
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.title.localeCompare(b.title));
    for (const d of sortedDocs) {
      items.push({ type: "doc", slug: d.slug, title: d.title, unread: d.unread });
    }

    return items;
  }

  return render(root);
}

/**
 * Sidebar visibility rules:
 *   1. Hide `default` section if empty and other sections exist.
 *   2. If only one section remains, render its children flat (no header).
 */
function applyVisibilityRules(items: NavItem[]): NavItem[] {
  const sectionItems = items.filter((i): i is Extract<NavItem, { type: "section" }> => i.type === "section");
  const topLevelOther = items.filter(i => i.type !== "section");

  let visibleSections = sectionItems;
  if (sectionItems.length > 1) {
    visibleSections = sectionItems.filter(s => !(s.slug === "default" && s.children.length === 0));
  }

  if (topLevelOther.length === 0 && visibleSections.length === 1) {
    return visibleSections[0].children;
  }

  return [...topLevelOther, ...visibleSections];
}

export function buildNavTree(sections: Section[], documents: Doc[]): NavItem[] {
  const items: NavItem[] = [];

  // Group docs by sectionId. Sectionless docs shouldn't exist post-migration,
  // but if any sneak through, render them at the top level.
  const docsBySection = new Map<string, Doc[]>();
  const orphanDocs: Doc[] = [];
  for (const d of documents) {
    if (d.sectionId) {
      if (!docsBySection.has(d.sectionId)) docsBySection.set(d.sectionId, []);
      docsBySection.get(d.sectionId)!.push(d);
    } else {
      orphanDocs.push(d);
    }
  }

  // Orphans (defensive): render at top level using path-tree logic.
  if (orphanDocs.length > 0) {
    items.push(...buildPathTree(orphanDocs));
  }

  // Sections sorted by position.
  const topSections = [...sections].filter(s => !s.parentId).sort((a, b) => a.position - b.position);
  for (const s of topSections) {
    const sectionDocs = docsBySection.get(s.id) || [];
    items.push({
      type: "section",
      slug: s.slug,
      title: s.title,
      children: buildPathTree(sectionDocs),
    });
  }

  return applyVisibilityRules(items);
}
