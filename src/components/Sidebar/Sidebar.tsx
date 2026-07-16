import { useRef } from 'react';

import { Icon, type IconName } from '@/components/common';
import { AnnotationsPanel } from '@/features/annotations';
import { SignaturesPanel } from '@/features/signatures';
import { useContributionStore } from '@/plugins';
import { useViewerStore } from '@/state/viewerStore';

import { Outline } from './Outline';
import { PluginPanel } from './PluginPanel';
import { Thumbnails } from './Thumbnails';

const CORE_TABS: { id: string; title: string; icon: IconName }[] = [
  { id: 'thumbnails', title: 'Thumbnails', icon: 'image' },
  { id: 'outline', title: 'Outline', icon: 'list' },
  { id: 'annotations', title: 'Annotations', icon: 'highlighter' },
  { id: 'signatures', title: 'Signatures', icon: 'signature' },
];

export function Sidebar() {
  const tab = useViewerStore((s) => s.sidebarTab);
  const setTab = useViewerStore((s) => s.setSidebarTab);
  const panels = useContributionStore((s) => s.sidebarPanels);
  const railRef = useRef<HTMLDivElement>(null);

  const activePanel = panels.find((p) => p.id === tab);
  const tabIds = [...CORE_TABS.map((t) => t.id), ...panels.map((p) => p.id)];

  /**
   * Arrow-key navigation for the tab rail.
   *
   * A tablist uses a roving tabindex: only the selected tab is in the tab
   * sequence, so `Tab` moves past the whole rail rather than through it. That
   * makes the arrow keys the *only* way to reach the other tabs — without this
   * handler every unselected panel is unreachable by keyboard, which is a WCAG
   * 2.2 SC 2.1.1 (Keyboard, Level A) failure.
   *
   * Selection follows focus, which the ARIA practices allow when showing a panel
   * is cheap, and all of these are already-mounted local state.
   */
  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const current = tabIds.indexOf(tab);
    if (current === -1) return;

    let next: number;
    switch (e.key) {
      // The rail is vertical, so up/down are the primary keys. Left/right are
      // accepted too: the arrow a user reaches for follows their mental model
      // of the rail, not our aria-orientation.
      case 'ArrowDown':
      case 'ArrowRight':
        next = (current + 1) % tabIds.length;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        next = (current - 1 + tabIds.length) % tabIds.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = tabIds.length - 1;
        break;
      default:
        return;
    }

    // Claim the key before the global shortcuts see it: ArrowLeft/ArrowRight are
    // bound to page navigation, and Home/End would scroll the document.
    e.preventDefault();
    setTab(tabIds[next]);
    // The newly selected tab becomes the one focusable element in the rail, so
    // focus has to follow it or it would be stranded on a tabIndex={-1} button.
    railRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <aside className="folio-sidebar" aria-label="Document tools">
      {/* The handler sits on each tab rather than the rail: the tabs are the
          focusable elements, so that is where the keys actually land. */}
      <div ref={railRef} className="folio-sidebar__rail" role="tablist" aria-orientation="vertical">
        {CORE_TABS.map((t) => (
          <TabButton
            key={t.id}
            icon={t.icon}
            label={t.title}
            active={tab === t.id}
            onClick={() => setTab(t.id)}
            onKeyDown={onTabKeyDown}
          />
        ))}
        {panels.map((p) => (
          <TabButton
            key={p.id}
            icon={(p.icon as IconName) ?? 'note'}
            label={p.title}
            active={tab === p.id}
            onClick={() => setTab(p.id)}
            onKeyDown={onTabKeyDown}
          />
        ))}
      </div>

      <div className="folio-sidebar__body" role="tabpanel" aria-label={tab}>
        {tab === 'thumbnails' && <Thumbnails />}
        {tab === 'outline' && <Outline />}
        {tab === 'annotations' && <AnnotationsPanel />}
        {tab === 'signatures' && <SignaturesPanel />}
        {activePanel && <PluginPanel panel={activePanel} />}
      </div>
    </aside>
  );
}

interface TabButtonProps {
  icon: IconName;
  label: string;
  active: boolean;
  onClick: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
}

function TabButton({ icon, label, active, onClick, onKeyDown }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={label}
      title={label}
      // Roving tabindex: the rail is one stop in the tab sequence and the arrow
      // keys move within it, which is why onKeyDown above is not optional.
      tabIndex={active ? 0 : -1}
      className={`folio-sidebar__tab${active ? ' is-active' : ''}`}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <Icon name={icon} />
    </button>
  );
}
