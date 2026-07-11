import { useEffect, useRef } from 'react';

import type { SidebarPanel } from '@/plugins';

/**
 * Hosts a plugin-provided sidebar panel. Plugins render imperatively into a
 * plain DOM node (so they aren't coupled to React); we handle mount/cleanup.
 */
export function PluginPanel({ panel }: { panel: SidebarPanel }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cleanup = panel.render(el);
    return () => {
      if (typeof cleanup === 'function') cleanup();
      el.replaceChildren();
    };
  }, [panel]);

  return <div ref={ref} className="folio-plugin-panel" />;
}
