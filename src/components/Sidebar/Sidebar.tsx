import { Icon, type IconName } from '@/components/common';
import { AnnotationsPanel } from '@/features/annotations';
import { useContributionStore } from '@/plugins';
import { useViewerStore } from '@/state/viewerStore';

import { Outline } from './Outline';
import { PluginPanel } from './PluginPanel';
import { Thumbnails } from './Thumbnails';

const CORE_TABS: { id: string; title: string; icon: IconName }[] = [
  { id: 'thumbnails', title: 'Thumbnails', icon: 'image' },
  { id: 'outline', title: 'Outline', icon: 'list' },
  { id: 'annotations', title: 'Annotations', icon: 'highlighter' },
];

export function Sidebar() {
  const tab = useViewerStore((s) => s.sidebarTab);
  const setTab = useViewerStore((s) => s.setSidebarTab);
  const panels = useContributionStore((s) => s.sidebarPanels);

  const activePanel = panels.find((p) => p.id === tab);

  return (
    <aside className="folio-sidebar" aria-label="Document tools">
      <div className="folio-sidebar__rail" role="tablist" aria-orientation="vertical">
        {CORE_TABS.map((t) => (
          <TabButton
            key={t.id}
            icon={t.icon}
            label={t.title}
            active={tab === t.id}
            onClick={() => setTab(t.id)}
          />
        ))}
        {panels.map((p) => (
          <TabButton
            key={p.id}
            icon={(p.icon as IconName) ?? 'note'}
            label={p.title}
            active={tab === p.id}
            onClick={() => setTab(p.id)}
          />
        ))}
      </div>

      <div className="folio-sidebar__body" role="tabpanel" aria-label={tab}>
        {tab === 'thumbnails' && <Thumbnails />}
        {tab === 'outline' && <Outline />}
        {tab === 'annotations' && <AnnotationsPanel />}
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
}

function TabButton({ icon, label, active, onClick }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={label}
      title={label}
      tabIndex={active ? 0 : -1}
      className={`folio-sidebar__tab${active ? ' is-active' : ''}`}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}
