/**
 * Build a hierarchical nav tree from sections and documents.
 * Supports both section grouping and document nesting (parentId).
 *
 * Hierarchy: sections contain docs; docs can nest under other docs.
 * Top-level docs (no section, no parent) appear before sections.
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
  parentId?: string | null;
  tags?: string[];
  position?: number;
}

export interface NavItem {
  slug: string;
  title: string;
  type: "section" | "doc";
  children?: NavItem[];
}

/** Recursively build doc tree from a list of docs sharing a parent */
function buildDocChildren(parentId: string, docsByParent: Map<string | null, Doc[]>): NavItem[] {
  const children = (docsByParent.get(parentId) || []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return children.map(d => {
    const nested = d.id ? buildDocChildren(d.id, docsByParent) : [];
    const item: NavItem = { slug: d.slug, title: d.title, type: "doc" };
    if (nested.length > 0) item.children = nested;
    return item;
  });
}

/** Build doc items for a flat list (docs without children concept, or root-level) */
function buildDocItems(docs: Doc[], docsByParent: Map<string | null, Doc[]>): NavItem[] {
  return docs.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map(d => {
    const nested = d.id ? buildDocChildren(d.id, docsByParent) : [];
    const item: NavItem = { slug: d.slug, title: d.title, type: "doc" };
    if (nested.length > 0) item.children = nested;
    return item;
  });
}

export function buildNavTree(sections: Section[], documents: Doc[]): NavItem[] {
  const items: NavItem[] = [];

  // Group docs by parentId for nesting
  const docsByParent = new Map<string | null, Doc[]>();
  for (const d of documents) {
    const key = d.parentId ?? null;
    if (!docsByParent.has(key)) docsByParent.set(key, []);
    docsByParent.get(key)!.push(d);
  }

  // Root docs = no parent AND no section
  const rootDocs = (docsByParent.get(null) || []).filter(d => !d.sectionId);
  items.push(...buildDocItems(rootDocs, docsByParent));

  // Group root-level docs by sectionId (only those with no parent)
  const docsBySection = new Map<string, Doc[]>();
  for (const d of (docsByParent.get(null) || [])) {
    if (d.sectionId) {
      if (!docsBySection.has(d.sectionId)) docsBySection.set(d.sectionId, []);
      docsBySection.get(d.sectionId)!.push(d);
    }
  }

  // Sections sorted by position, with their child docs (which may have nested children)
  const topSections = [...sections].filter(s => !s.parentId).sort((a, b) => a.position - b.position);
  for (const s of topSections) {
    const children: NavItem[] = [];

    // Docs in this section
    const sectionDocs = docsBySection.get(s.id) || [];
    children.push(...buildDocItems(sectionDocs, docsByParent));

    // Nested sub-sections
    const subSections = [...sections].filter(sub => sub.parentId === s.id).sort((a, b) => a.position - b.position);
    for (const sub of subSections) {
      const subDocs = docsBySection.get(sub.id) || [];
      children.push({
        slug: sub.slug,
        title: sub.title,
        type: "section",
        children: buildDocItems(subDocs, docsByParent),
      });
    }

    items.push({ slug: s.slug, title: s.title, type: "section", children });
  }

  return items;
}
