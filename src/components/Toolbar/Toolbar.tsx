import { useEffect, useState } from 'react';

import { commandRegistry } from '@/commands';
import { IconButton, type IconName } from '@/components/common';
import { useNotesUi } from '@/features/annotations';
import { useContributionStore } from '@/plugins';
import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';
import { useThemeStore } from '@/theme/themeStore';

const run = (id: string) => commandRegistry.execute(id);

/** The top application toolbar. */
export function Toolbar() {
  const hasDoc = useDocumentStore((s) => s.status === 'ready');
  const currentPage = useViewerStore((s) => s.currentPage);
  const numPages = useViewerStore((s) => s.numPages);
  const scale = useViewerStore((s) => s.scale);
  const sidebarOpen = useViewerStore((s) => s.sidebarOpen);
  const goToPage = useViewerStore((s) => s.goToPage);
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const readingMode = useThemeStore((s) => s.readingMode);
  const addingNote = useNotesUi((s) => s.adding);
  const toolbarItems = useContributionStore((s) => s.toolbarItems);

  return (
    <header className="folio-toolbar" role="banner">
      <div className="folio-toolbar__group">
        <IconButton
          icon="sidebar"
          label="Toggle sidebar"
          active={sidebarOpen}
          onClick={() => run('view.toggleSidebar')}
        />
        <IconButton
          icon="folder-open"
          label="Open document (Ctrl/Cmd + O)"
          onClick={() => run('file.open')}
        />
      </div>

      <div className="folio-toolbar__group folio-toolbar__group--center">
        <IconButton
          icon="chevron-left"
          label="Previous page"
          disabled={!hasDoc || currentPage <= 1}
          onClick={() => run('nav.prevPage')}
        />
        <PageBox
          currentPage={currentPage}
          numPages={numPages}
          disabled={!hasDoc}
          onSubmit={goToPage}
        />
        <IconButton
          icon="chevron-right"
          label="Next page"
          disabled={!hasDoc || currentPage >= numPages}
          onClick={() => run('nav.nextPage')}
        />
        <span className="folio-toolbar__divider" aria-hidden="true" />
        <IconButton
          icon="zoom-out"
          label="Zoom out"
          disabled={!hasDoc}
          onClick={() => run('view.zoomOut')}
        />
        <span className="folio-toolbar__zoom" aria-live="polite">
          {Math.round(scale * 100)}%
        </span>
        <IconButton
          icon="zoom-in"
          label="Zoom in"
          disabled={!hasDoc}
          onClick={() => run('view.zoomIn')}
        />
        <IconButton
          icon="fit-width"
          label="Fit width"
          disabled={!hasDoc}
          onClick={() => run('view.fitWidth')}
        />
        <IconButton
          icon="fit-page"
          label="Fit page"
          disabled={!hasDoc}
          onClick={() => run('view.fitPage')}
        />
      </div>

      <div className="folio-toolbar__group folio-toolbar__group--right">
        {toolbarItems.map((item) => (
          <IconButton
            key={item.id}
            icon={(item.icon as IconName) ?? 'note'}
            label={item.title}
            onClick={() => commandRegistry.execute(item.commandId)}
          />
        ))}
        <IconButton
          icon="comment"
          label="Comment on selected text, or click to place (Ctrl/Cmd + Shift + M)"
          active={addingNote}
          disabled={!hasDoc}
          // Keep the text selection alive: a plain button mousedown collapses it
          // before the click handler can read it.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run('annotate.addNote')}
        />
        <IconButton
          icon="highlighter"
          label="Highlight selection (Ctrl/Cmd + Shift + H)"
          disabled={!hasDoc}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run('annotate.highlight')}
        />
        <IconButton
          icon="type"
          label="Add text box"
          disabled={!hasDoc}
          onClick={() => run('edit.addText')}
        />
        <IconButton
          icon="image"
          label="Add image"
          disabled={!hasDoc}
          onClick={() => run('edit.addImage')}
        />
        <IconButton
          icon="signature"
          label="Add signature"
          disabled={!hasDoc}
          onClick={() => run('sign.addSignature')}
        />
        <IconButton
          icon="shield"
          label="Digitally sign"
          disabled={!hasDoc}
          onClick={() => run('sign.digitallySign')}
        />
        <IconButton
          icon="download"
          label="Save a copy (Ctrl/Cmd + S)"
          disabled={!hasDoc}
          onClick={() => run('file.save')}
        />
        <IconButton
          icon="search"
          label="Find (Ctrl/Cmd + F)"
          disabled={!hasDoc}
          onClick={() => run('search.toggle')}
        />
        <IconButton
          icon="contrast"
          label={`Reading mode: ${readingMode}`}
          active={readingMode !== 'normal'}
          onClick={() => run('theme.cycleReadingMode')}
        />
        <IconButton
          icon={resolvedTheme === 'dark' ? 'sun' : 'moon'}
          label="Toggle light / dark (Ctrl/Cmd + Shift + L)"
          onClick={() => run('theme.toggle')}
        />
      </div>
    </header>
  );
}

interface PageBoxProps {
  currentPage: number;
  numPages: number;
  disabled: boolean;
  onSubmit: (page: number) => void;
}

function PageBox({ currentPage, numPages, disabled, onSubmit }: PageBoxProps) {
  const [value, setValue] = useState(String(currentPage));

  useEffect(() => {
    setValue(String(currentPage));
  }, [currentPage]);

  return (
    <span className="folio-pagebox">
      <input
        className="folio-pagebox__input"
        type="text"
        inputMode="numeric"
        value={value}
        disabled={disabled}
        aria-label={`Page number, ${currentPage} of ${numPages}`}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => setValue(String(currentPage))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const n = parseInt(value, 10);
            if (!Number.isNaN(n)) onSubmit(n);
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            setValue(String(currentPage));
            e.currentTarget.blur();
          }
        }}
      />
      <span className="folio-pagebox__total">/ {numPages || 0}</span>
    </span>
  );
}
