import { useState, useEffect, useRef, useCallback } from "react";

interface DocSuggestion {
  sectionSlug: string;
  path: string;
  title: string;
  url: string;
}

interface Props {
  apiUrl: string;
  spaceSlug: string;
  accessToken: string | null;
}

/**
 * Attaches wiki-link autocomplete to any textarea on the page.
 * When the user types [[ inside a textarea, shows a dropdown of matching docs.
 * Selecting inserts [[slug|title]] at the cursor position.
 *
 * Mount this once per page — it listens to all textareas with data-wiki-autocomplete.
 */
export default function WikiLinkAutocomplete({ apiUrl, spaceSlug, accessToken }: Props) {
  const [active, setActive] = useState(false);
  const [, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<DocSuggestion[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const targetRef = useRef<HTMLTextAreaElement | null>(null);
  const triggerPosRef = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | undefined>(undefined);

  const fetchSuggestions = useCallback(async (q: string) => {
    // Empty query is fine — the server returns the first 15 docs alphabetically.
    try {
      const headers: Record<string, string> = {};
      if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
      const res = await fetch(`${apiUrl}/api/documents/${spaceSlug}/_autocomplete?q=${encodeURIComponent(q)}`, { headers });
      if (res.ok) {
        const data = await res.json();
        setSuggestions(data);
        setSelectedIndex(0);
      }
    } catch {}
  }, [apiUrl, spaceSlug, accessToken]);

  const insertLink = useCallback((doc: DocSuggestion) => {
    const textarea = targetRef.current;
    if (!textarea) return;

    const before = textarea.value.slice(0, triggerPosRef.current);
    const after = textarea.value.slice(textarea.selectionStart);
    // Path-qualified target — strip `.md` and `index` collapse to mirror the
    // canonical URL form. The display text after `|` lets the rendered link
    // show the title rather than the raw path.
    const target = doc.path.replace(/\.md$/, "").replace(/(^|\/)index$/, "");
    const insert = `[[${target}|${doc.title}]]`;
    const newValue = before + insert + after;
    const newPos = before.length + insert.length;

    // Use native setter to trigger React's onChange
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (nativeSetter) {
      nativeSetter.call(textarea, newValue);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      textarea.value = newValue;
    }

    textarea.selectionStart = textarea.selectionEnd = newPos;
    textarea.focus();

    setActive(false);
    setSuggestions([]);
    setQuery("");
  }, []);

  // Listen for [[ trigger in textareas
  useEffect(() => {
    function handleInput(e: Event) {
      const textarea = e.target as HTMLTextAreaElement;
      if (!textarea.matches("textarea")) return;

      const pos = textarea.selectionStart;
      const text = textarea.value.slice(0, pos);

      // Find the last [[ that isn't closed
      const lastOpen = text.lastIndexOf("[[");
      if (lastOpen === -1 || text.indexOf("]]", lastOpen) !== -1) {
        if (active) setActive(false);
        return;
      }

      const searchText = text.slice(lastOpen + 2);
      if (searchText.includes("\n")) {
        if (active) setActive(false);
        return;
      }

      // Position the dropdown near the cursor
      const rect = textarea.getBoundingClientRect();
      // Approximate cursor position (rough but functional)
      const lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 20;
      const textBeforeCursor = textarea.value.slice(0, pos);
      const lines = textBeforeCursor.split("\n");
      const currentLineNum = lines.length - 1;
      const scrollTop = textarea.scrollTop;

      setPosition({
        top: rect.top + window.scrollY + (currentLineNum * lineHeight) - scrollTop + lineHeight + 4,
        left: rect.left + window.scrollX + 8,
      });

      targetRef.current = textarea;
      triggerPosRef.current = lastOpen;
      setQuery(searchText);
      setActive(true);

      clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => fetchSuggestions(searchText), 100);
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (!active) return;
      const textarea = e.target as HTMLTextAreaElement;
      if (!textarea.matches("textarea")) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, suggestions.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && suggestions[selectedIndex]) {
        e.preventDefault();
        insertLink(suggestions[selectedIndex]);
      } else if (e.key === "Escape") {
        setActive(false);
      }
    }

    document.addEventListener("input", handleInput);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("input", handleInput);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [active, suggestions, selectedIndex, fetchSuggestions, insertLink]);

  // Close on click outside
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setActive(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [active]);

  if (!active || suggestions.length === 0) return null;

  return (
    <div
      ref={panelRef}
      className="wiki-autocomplete"
      style={{ top: position.top, left: position.left }}
    >
      {suggestions.map((doc, i) => (
        <div
          key={`${doc.sectionSlug}/${doc.path}`}
          className={`wiki-autocomplete-item ${i === selectedIndex ? "active" : ""}`}
          onMouseEnter={() => setSelectedIndex(i)}
          onClick={() => insertLink(doc)}
        >
          <span className="wiki-autocomplete-title">{doc.title}</span>
          <span className="wiki-autocomplete-slug">{doc.sectionSlug}/{doc.path.replace(/\.md$/, "")}</span>
        </div>
      ))}
    </div>
  );
}
