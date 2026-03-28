import { useState, useEffect, useRef, useCallback } from "react";

interface SearchResult {
  spaceSlug: string;
  spaceName: string;
  docSlug: string;
  title: string;
  tags: string[];
  snippet: string;
  rank: number;
}

interface Props {
  apiUrl: string;
  accessToken: string | null;
}

export default function SearchModal({ apiUrl, accessToken }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number>();

  // Open on ⌘K / Ctrl+K or click on search trigger
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handleKey);

    const trigger = document.querySelector(".search-trigger");
    const handleClick = () => setOpen(true);
    trigger?.addEventListener("click", handleClick);

    return () => {
      document.removeEventListener("keydown", handleKey);
      trigger?.removeEventListener("click", handleClick);
    };
  }, [open]);

  // Focus input when opening
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery("");
      setResults([]);
      setActiveIndex(0);
    }
  }, [open]);

  // Debounced search
  const search = useCallback(async (q: string) => {
    if (q.length < 2) { setResults([]); return; }
    setLoading(true);
    try {
      const headers: Record<string, string> = {};
      if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
      const res = await fetch(`${apiUrl}/api/search?q=${encodeURIComponent(q)}&limit=10`, { headers });
      if (res.ok) {
        const data = await res.json();
        setResults(data.results);
        setActiveIndex(0);
      }
    } catch {} finally {
      setLoading(false);
    }
  }, [apiUrl, accessToken]);

  const handleInput = (value: string) => {
    setQuery(value);
    clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => search(value), 150);
  };

  const navigate = (result: SearchResult) => {
    setOpen(false);
    window.location.href = `/s/${result.spaceSlug}/${result.docSlug}`;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[activeIndex]) {
      navigate(results[activeIndex]);
    }
  };

  // Scroll active item into view
  useEffect(() => {
    const active = listRef.current?.children[activeIndex] as HTMLElement;
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) return null;

  return (
    <div className="search-overlay" onClick={() => setOpen(false)}>
      <div className="search-modal" onClick={e => e.stopPropagation()}>
        <div className="search-input-row">
          <svg className="search-input-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="search-input"
            placeholder="Search documentation…"
            value={query}
            onChange={e => handleInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <kbd className="search-kbd">esc</kbd>
        </div>

        <div className="search-results" ref={listRef}>
          {loading && <div className="search-loading">Searching…</div>}
          {!loading && query.length >= 2 && results.length === 0 && (
            <div className="search-empty">No results for "{query}"</div>
          )}
          {results.map((r, i) => (
            <a
              key={`${r.spaceSlug}/${r.docSlug}`}
              href={`/s/${r.spaceSlug}/${r.docSlug}`}
              className={`search-result ${i === activeIndex ? "active" : ""}`}
              onClick={(e) => { e.preventDefault(); navigate(r); }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              <div className="search-result-header">
                <span className="search-result-space">{r.spaceName}</span>
                <span className="search-result-title">{r.title}</span>
              </div>
              {r.snippet && (
                <div className="search-result-snippet" dangerouslySetInnerHTML={{ __html: r.snippet }} />
              )}
              {r.tags?.length > 0 && (
                <div className="search-result-tags">
                  {r.tags.map(t => <span key={t} className="search-result-tag">{t}</span>)}
                </div>
              )}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
