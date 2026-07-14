import { useEffect, useRef, useState } from 'react';

import { Icon, IconButton } from '@/components/common';
import { type SearchMatch } from '@/core/pdf';
import { searchWithOcr } from '@/features/ocr';
import { useViewerStore } from '@/state/viewerStore';

/** Find-in-document bar with a results list. */
export function SearchBar() {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const goToPage = useViewerStore((s) => s.goToPage);
  const setSearchOpen = useViewerStore((s) => s.setSearchOpen);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const results = await searchWithOcr(q, { limit: 100 });
        if (!cancelled) {
          setMatches(results);
          setActiveIndex(0);
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const gotoMatch = (index: number) => {
    const match = matches[index];
    if (!match) return;
    setActiveIndex(index);
    goToPage(match.pageNumber);
  };
  const next = () => matches.length && gotoMatch((activeIndex + 1) % matches.length);
  const prev = () =>
    matches.length && gotoMatch((activeIndex - 1 + matches.length) % matches.length);

  const status = searching
    ? 'Searching…'
    : matches.length
      ? `${activeIndex + 1} of ${matches.length}`
      : query.trim().length >= 2
        ? 'No results'
        : '';

  return (
    <div className="folio-search" role="search">
      <div className="folio-search__bar">
        <Icon name="search" size={18} />
        <input
          ref={inputRef}
          className="folio-search__input"
          type="text"
          placeholder="Find in document"
          value={query}
          aria-label="Find in document"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (e.shiftKey) prev();
              else next();
            } else if (e.key === 'Escape') {
              setSearchOpen(false);
            }
          }}
        />
        <span className="folio-search__count" aria-live="polite">
          {status}
        </span>
        <IconButton
          icon="chevron-left"
          label="Previous match"
          disabled={!matches.length}
          onClick={prev}
        />
        <IconButton
          icon="chevron-right"
          label="Next match"
          disabled={!matches.length}
          onClick={next}
        />
        <IconButton icon="x" label="Close find" onClick={() => setSearchOpen(false)} />
      </div>

      {matches.length > 0 && (
        <ul className="folio-search__results">
          {matches.map((match, i) => (
            <li key={`${match.pageNumber}-${match.index}`}>
              <button
                type="button"
                className={`folio-search__result${i === activeIndex ? ' is-active' : ''}`}
                onClick={() => gotoMatch(i)}
              >
                <span className="folio-search__result-page">p.{match.pageNumber}</span>
                <span className="folio-search__result-snippet">{match.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
