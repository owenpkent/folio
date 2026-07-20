import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { commandRegistry } from '@/commands';
import { IconButton, type IconName } from '@/components/common';
import { useNotesUi } from '@/features/annotations';
import { useTextEditStore } from '@/features/textedit';
import { useContributionStore } from '@/plugins';
import { useDocumentStore } from '@/state/documentStore';
import { focusViewer } from '@/state/viewerElement';
import { AUTO_SCROLL_MAX, AUTO_SCROLL_MIN, useViewerStore } from '@/state/viewerStore';
import { useThemeStore } from '@/theme/themeStore';

import { DarkSchemeMenu } from './DarkSchemeMenu';
import { ToolbarOverflow } from './ToolbarOverflow';
import type { OverflowTool } from './toolbarTools';

const run = (id: string) => commandRegistry.execute(id);

// The auto-scroll slider is geometric, not linear: equal slider travel is equal
// *ratio* of speed change, so the slow end (where fine control matters) gets as
// much of the track as the fast end. Position runs 0..1.
const speedToSlider = (speed: number): number =>
  Math.log(speed / AUTO_SCROLL_MIN) / Math.log(AUTO_SCROLL_MAX / AUTO_SCROLL_MIN);
const sliderToSpeed = (pos: number): number =>
  AUTO_SCROLL_MIN * (AUTO_SCROLL_MAX / AUTO_SCROLL_MIN) ** pos;

/** The top application toolbar. */
export function Toolbar() {
  const hasDoc = useDocumentStore((s) => s.status === 'ready');
  const docName = useDocumentStore((s) => s.info?.name);
  const currentPage = useViewerStore((s) => s.currentPage);
  const numPages = useViewerStore((s) => s.numPages);
  const scale = useViewerStore((s) => s.scale);
  const sidebarOpen = useViewerStore((s) => s.sidebarOpen);
  const handMode = useViewerStore((s) => s.handMode);
  const autoScroll = useViewerStore((s) => s.autoScroll);
  const autoScrollSpeed = useViewerStore((s) => s.autoScrollSpeed);
  const setAutoScrollSpeed = useViewerStore((s) => s.setAutoScrollSpeed);
  const goToPage = useViewerStore((s) => s.goToPage);
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const addingNote = useNotesUi((s) => s.adding);
  const textEditActive = useTextEditStore((s) => s.active);
  const toolbarItems = useContributionStore((s) => s.toolbarItems);

  // The right-group tools, in display order. Those that don't fit collapse into
  // the overflow (⋯) menu, from the end, so a narrow window never clips them.
  const docTools: OverflowTool[] = [
    ...toolbarItems.map((item) => ({
      id: item.id,
      icon: (item.icon as IconName) ?? 'note',
      label: item.title,
      menuLabel: item.title,
      onClick: () => commandRegistry.execute(item.commandId),
    })),
    {
      id: 'comment',
      icon: 'comment',
      label: 'Comment on selected text, or click to place (Ctrl/Cmd + Shift + M)',
      menuLabel: 'Comment',
      active: addingNote,
      disabled: !hasDoc,
      preserveSelection: true,
      onClick: () => run('annotate.addNote'),
    },
    {
      id: 'highlight',
      icon: 'highlighter',
      label: 'Highlight selection (Ctrl/Cmd + Shift + H)',
      menuLabel: 'Highlight',
      disabled: !hasDoc,
      preserveSelection: true,
      onClick: () => run('annotate.highlight'),
    },
    {
      id: 'edit-text',
      icon: 'pencil',
      label: 'Edit text',
      menuLabel: 'Edit text',
      active: textEditActive,
      disabled: !hasDoc,
      onClick: () => run('textedit.toggle'),
    },
    {
      id: 'add-text',
      icon: 'type',
      label: 'Add text box',
      menuLabel: 'Add text box',
      disabled: !hasDoc,
      onClick: () => run('edit.addText'),
    },
    {
      id: 'add-image',
      icon: 'image',
      label: 'Add image',
      menuLabel: 'Add image',
      disabled: !hasDoc,
      onClick: () => run('edit.addImage'),
    },
    {
      id: 'ocr',
      icon: 'scan',
      label: 'Recognize text (OCR)',
      menuLabel: 'Recognize text (OCR)',
      disabled: !hasDoc,
      onClick: () => run('ocr.recognizeDocument'),
    },
    {
      id: 'signature',
      icon: 'signature',
      label: 'Add signature',
      menuLabel: 'Add signature',
      disabled: !hasDoc,
      onClick: () => run('sign.addSignature'),
    },
    {
      id: 'digitally-sign',
      icon: 'shield',
      label: 'Digitally sign',
      menuLabel: 'Digitally sign',
      disabled: !hasDoc,
      onClick: () => run('sign.digitallySign'),
    },
    {
      id: 'save',
      icon: 'download',
      label: 'Save a copy (Ctrl/Cmd + S)',
      menuLabel: 'Save a copy',
      disabled: !hasDoc,
      onClick: () => run('file.save'),
    },
    {
      id: 'find',
      icon: 'search',
      label: 'Find (Ctrl/Cmd + F)',
      menuLabel: 'Find',
      disabled: !hasDoc,
      onClick: () => run('search.toggle'),
    },
  ];

  const toolbarRef = useRef<HTMLElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(docTools.length);
  const toolCount = docTools.length;

  // How many right-group tools fit inline before the pinned tail (dark scheme,
  // theme, About); the rest collapse into the overflow menu. Measured from the
  // fixed siblings' widths so it never depends on the flow's own content (which
  // would oscillate). Right-group buttons are uniform-width IconButtons, so a
  // single button width is enough to divide the available space.
  const measure = useCallback(() => {
    const tb = toolbarRef.current;
    const left = leftRef.current;
    const center = centerRef.current;
    const pinned = pinnedRef.current;
    if (!tb || !left || !center || !pinned) return;
    const sumChildren = (el: HTMLElement): number => {
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
      const kids = Array.from(el.children) as HTMLElement[];
      const w = kids.reduce((s, k) => s + k.getBoundingClientRect().width, 0);
      return w + gap * Math.max(0, kids.length - 1);
    };
    const cs = getComputedStyle(tb);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const groupGap = parseFloat(cs.columnGap) || 0;
    const leftW = left.getBoundingClientRect().width;
    const centerW = sumChildren(center);
    const pinnedW = sumChildren(pinned);
    const pinnedKids = Array.from(pinned.children) as HTMLElement[];
    const btnW = pinnedKids.length
      ? pinnedKids[pinnedKids.length - 1].getBoundingClientRect().width
      : 34;
    const flowGap = 2; // .folio-toolbar__group inter-button gap
    // groupGap sits between left|center and center|right; flowGap between the
    // flow and the pinned tail. 8px is a sub-pixel safety margin.
    const available =
      tb.clientWidth - padX - leftW - centerW - pinnedW - groupGap * 2 - flowGap - 8;
    const slot = btnW + flowGap;
    const slots = Math.max(0, Math.floor((available + flowGap) / slot));
    setVisibleCount(slots >= toolCount ? toolCount : Math.max(0, slots - 1));
  }, [toolCount]);

  // Re-measure after every render (catches content-width changes: the filename,
  // the zoom readout, the auto-scroll slider appearing) and on toolbar resize.
  useLayoutEffect(() => {
    measure();
  });
  useEffect(() => {
    const tb = toolbarRef.current;
    if (!tb) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(tb);
    return () => ro.disconnect();
  }, [measure]);

  return (
    <header className="folio-toolbar" role="banner" ref={toolbarRef}>
      <div className="folio-toolbar__group folio-toolbar__group--left" ref={leftRef}>
        <IconButton
          icon="sidebar"
          label="Toggle sidebar (Ctrl/Cmd + B)"
          active={sidebarOpen}
          onClick={() => run('view.toggleSidebar')}
        />
        <IconButton
          icon="folder-open"
          label="Open document (Ctrl/Cmd + O)"
          onClick={() => run('file.open')}
        />
        {hasDoc && docName && (
          <span className="folio-toolbar__title" title={docName}>
            {docName}
          </span>
        )}
      </div>

      <div className="folio-toolbar__group folio-toolbar__group--center" ref={centerRef}>
        <IconButton
          icon="chevron-left"
          label="Previous page (←)"
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
          label="Next page (→)"
          disabled={!hasDoc || currentPage >= numPages}
          onClick={() => run('nav.nextPage')}
        />
        <span className="folio-toolbar__divider" aria-hidden="true" />
        <IconButton
          icon="zoom-out"
          label="Zoom out (Ctrl/Cmd + -)"
          disabled={!hasDoc}
          onClick={() => run('view.zoomOut')}
        />
        <span className="folio-toolbar__zoom" aria-live="polite">
          {Math.round(scale * 100)}%
        </span>
        <IconButton
          icon="zoom-in"
          label="Zoom in (Ctrl/Cmd + =)"
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
        <IconButton
          icon="hand"
          label="Hand tool (pan to scroll)"
          active={handMode}
          disabled={!hasDoc}
          onClick={() => run('view.toggleHandMode')}
        />
        <IconButton
          icon="auto-scroll"
          label="Auto-scroll (continuous)"
          active={autoScroll}
          disabled={!hasDoc}
          onClick={() => run('view.toggleAutoScroll')}
        />
        {/* Only occupy toolbar width while auto-scroll is on; reserving a fixed
            slot when idle pushed the right-hand tools off narrow windows. */}
        {autoScroll && (
          <span className="folio-toolbar__speed-slot">
            <input
              className="folio-toolbar__speed"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={speedToSlider(autoScrollSpeed)}
              aria-label={`Auto-scroll speed, ${autoScrollSpeed} pixels per second`}
              title="Auto-scroll speed (slower ← → faster)"
              onChange={(e) => setAutoScrollSpeed(sliderToSpeed(Number(e.target.value)))}
            />
          </span>
        )}
      </div>

      <div className="folio-toolbar__group folio-toolbar__group--right">
        <ToolbarOverflow items={docTools} visibleCount={visibleCount} />
        {/* The theme controls and About stay pinned (always visible); the
            document tools to their left collapse into the overflow menu. */}
        <div className="folio-toolbar__pinned" ref={pinnedRef}>
          <DarkSchemeMenu />
          <IconButton
            icon={resolvedTheme === 'dark' ? 'sun' : 'moon'}
            label="Toggle light / dark (Ctrl/Cmd + Shift + L)"
            onClick={() => run('theme.toggle')}
          />
          <IconButton
            icon="info"
            label="About Folio (version, build info, updates)"
            onClick={() => run('help.about')}
          />
        </div>
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
            // Move focus to the document rather than blurring to <body>, which
            // would leave the scroll keys with no scrollable element to act on.
            focusViewer();
          } else if (e.key === 'Escape') {
            setValue(String(currentPage));
            focusViewer();
          }
        }}
      />
      <span className="folio-pagebox__total">/ {numPages || 0}</span>
    </span>
  );
}
