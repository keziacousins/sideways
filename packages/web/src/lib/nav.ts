/**
 * Build a hierarchical nav tree from sections and documents.
 * Top-level docs (no section) appear first, then sections with their children.
 */

interface Section {
  id: string;
  slug: string;
  title: string;
  parentId: string | null;
  position: number;
}

interface Doc {
  slug: string;
  title: string;
  sectionId: string | null;
  tags?: string[];
  position?: number;
}

export interface NavItem {
  slug: string;
  title: string;
  type: "section" | "doc";
  children?: NavItem[];
}

export function buildNavTree(sections: Section[], documents: Doc[]): NavItem[] {
  const items: NavItem[] = [];

  // Index sections by ID
  const sectionMap = new Map<string, Section>();
  for (const s of sections) sectionMap.set(s.id, s);

  // Group docs by sectionId
  const docsBySection = new Map<string | null, Doc[]>();
  for (const d of documents) {
    const key = d.sectionId;
    if (!docsBySection.has(key)) docsBySection.set(key, []);
    docsBySection.get(key)!.push(d);
  }

  // Top-level docs (no section)
  const topDocs = (docsBySection.get(null) || []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  for (const d of topDocs) {
    items.push({ slug: d.slug, title: d.title, type: "doc" });
  }

  // Sections sorted by position, with their child docs
  const sortedSections = [...sections].filter(s => !s.parentId).sort((a, b) => a.position - b.position);
  for (const s of sortedSections) {
    const children: NavItem[] = [];

    // Docs in this section
    const sectionDocs = (docsBySection.get(s.id) || []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    for (const d of sectionDocs) {
      children.push({ slug: d.slug, title: d.title, type: "doc" });
    }

    // Nested sub-sections
    const subSections = [...sections].filter(sub => sub.parentId === s.id).sort((a, b) => a.position - b.position);
    for (const sub of subSections) {
      const subDocs = (docsBySection.get(sub.id) || []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      children.push({
        slug: sub.slug,
        title: sub.title,
        type: "section",
        children: subDocs.map(d => ({ slug: d.slug, title: d.title, type: "doc" as const })),
      });
    }

    items.push({ slug: s.slug, title: s.title, type: "section", children });
  }

  return items;
}
