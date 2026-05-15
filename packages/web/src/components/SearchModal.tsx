import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";

/**
 * Render a Postgres ts_headline snippet safely.
 *
 * ts_headline does NOT HTML-escape the source content — it just wraps matches
 * with <mark>…</mark>. To prevent stored XSS via document content, we render
 * the surrounding text as React text nodes (auto-escaped) and only emit a
 * real <mark> element around the highlighted spans.
 */
function renderSnippet(snippet: string): ReactNode[] {
  const cleaned = snippet
    .replace(/```[\s\S]*?```/g, " ") // strip code blocks
    .replace(/`([^`]+)`/g, "$1") // strip inline code
    .replace(/\*\*([^*]+)\*\*/g, "$1") // strip bold
    .replace(/\*([^*]+)\*/g, "$1") // strip italic
    .replace(/#{1,6}\s+/g, "") // strip headings
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // strip links
    .replace(/\n/g, " · ") // newlines to separator
    .replace(/\s+/g, " ") // collapse whitespace
    .trim();

  const parts: ReactNode[] = [];
  const regex = /<mark>([\s\S]*?)<\/mark>/g;
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleaned)) !== null) {
    if (match.index > lastIndex) parts.push(cleaned.slice(lastIndex, match.index));
    parts.push(<mark key={key++}>{match[1]}</mark>);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < cleaned.length) parts.push(cleaned.slice(lastIndex));
  return parts;
}

interface SearchResult {
  spaceSlug: string;
  spaceName: string;
  sectionSlug: string;
  path: string;
  url: string;
  title: string;
  tags: string[];
  snippet: string;
  rank: number;
  updatedAt?: string;
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
  const timerRef = useRef<number | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);

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

  // Debounced search with abort for stale requests
  const search = useCallback(async (q: string) => {
    if (q.length < 2) { setResults([]); setLoading(false); return; }
    // Abort any in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    try {
      const headers: Record<string, string> = {};
      if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
      const res = await fetch(`${apiUrl}/api/search?q=${encodeURIComponent(q)}&limit=10`, {
        headers,
        signal: controller.signal,
      });
      if (res.ok) {
        const data = await res.json();
        setResults(data.results);
        setActiveIndex(0);
      }
    } catch (e: any) {
      if (e.name === "AbortError") return;
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [apiUrl, accessToken]);

  const handleInput = (value: string) => {
    setQuery(value);
    clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => search(value), 150);
  };

  const navigate = (result: SearchResult) => {
    setOpen(false);
    window.location.href = result.url;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (results[activeIndex]) {
        navigate(results[activeIndex]);
      } else {
        // No results yet — search immediately
        clearTimeout(timerRef.current);
        search(query);
      }
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
          {loading && results.length === 0 && <div className="search-loading">Searching…</div>}
          {!loading && query.length >= 2 && results.length === 0 && (
            <div className="search-empty">No results for "{query}"</div>
          )}
          {results.map((r, i) => (
            <a
              key={r.url}
              href={r.url}
              className={`search-result ${i === activeIndex ? "active" : ""}`}
              onClick={(e) => { e.preventDefault(); navigate(r); }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              <div className="search-result-header">
                <span className="search-result-title">{r.title}</span>
                <span className="search-result-space">{r.spaceName}</span>
              </div>
              {r.snippet && (
                <div className="search-result-snippet">{renderSnippet(r.snippet)}</div>
              )}
              <div className="search-result-meta">
                {r.updatedAt && (
                  <span className="search-result-date">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{verticalAlign: "-0.125em"}}>
                      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                    </svg>
                    {" "}{new Date(r.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                  </span>
                )}
                {r.tags?.length > 0 && (
                  <span className="search-result-tags">
                    {r.tags.map(t => <span key={t} className="search-result-tag">{t}</span>)}
                  </span>
                )}
              </div>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
