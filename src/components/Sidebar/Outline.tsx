import { useState } from 'react';

import { Icon } from '@/components/common';
import type { OutlineNode } from '@/core/pdf';
import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';

export function Outline() {
  const outline = useDocumentStore((s) => s.outline);
  const goToPage = useViewerStore((s) => s.goToPage);

  if (outline.length === 0) {
    return <p className="folio-sidebar__empty">This document has no outline.</p>;
  }

  return (
    <ul className="folio-outline">
      {outline.map((node, i) => (
        <OutlineItem key={i} node={node} onNavigate={goToPage} />
      ))}
    </ul>
  );
}

interface OutlineItemProps {
  node: OutlineNode;
  onNavigate: (page: number) => void;
}

function OutlineItem({ node, onNavigate }: OutlineItemProps) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;

  return (
    <li className="folio-outline__item">
      <div className="folio-outline__row">
        {hasChildren ? (
          <button
            type="button"
            className="folio-outline__toggle"
            aria-label={open ? 'Collapse' : 'Expand'}
            title={open ? 'Collapse' : 'Expand'}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} />
          </button>
        ) : (
          <span className="folio-outline__spacer" aria-hidden="true" />
        )}
        <button
          type="button"
          className="folio-outline__link"
          // Bookmark titles are clipped at the sidebar's width, and nested ones
          // lose more of it to indentation.
          title={node.title}
          disabled={node.pageNumber == null}
          onClick={() => node.pageNumber != null && onNavigate(node.pageNumber)}
        >
          {node.title}
        </button>
      </div>
      {hasChildren && open && (
        <ul className="folio-outline__children">
          {node.children.map((child, i) => (
            <OutlineItem key={i} node={child} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </li>
  );
}
