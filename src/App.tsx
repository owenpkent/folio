import { useEffect } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';

import { SkipLink } from '@/a11y/SkipLink';
import { useKeyboardShortcuts } from '@/a11y/useKeyboardShortcuts';
import { registerDefaultCommands } from '@/commands';
import { ToastHost } from '@/components/common';
import { SearchBar } from '@/components/Search/SearchBar';
import { Sidebar } from '@/components/Sidebar/Sidebar';
import { Toolbar } from '@/components/Toolbar/Toolbar';
import { PdfViewer } from '@/components/Viewer/PdfViewer';
import { isTauri, readPath } from '@/core/document/openDocument';
import { registerAnnotationCommands } from '@/features/annotations';
import { activateBuiltinPlugins } from '@/plugins';
import { loadSource } from '@/state/actions';
import { useViewerStore } from '@/state/viewerStore';

export function App() {
  const sidebarOpen = useViewerStore((s) => s.sidebarOpen);
  const searchOpen = useViewerStore((s) => s.searchOpen);

  useKeyboardShortcuts();

  // Register commands and activate built-in plugins once.
  useEffect(() => {
    registerDefaultCommands();
    registerAnnotationCommands();
    void activateBuiltinPlugins();
  }, []);

  // Native desktop drag-and-drop of PDF files.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        const payload = event.payload as { type: string; paths?: string[] };
        if (payload.type !== 'drop' || !payload.paths) return;
        const path = payload.paths.find((p) => p.toLowerCase().endsWith('.pdf'));
        if (path) await loadSource(await readPath(path));
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  return (
    <div className="folio-app">
      <SkipLink />
      <Toolbar />
      <div className="folio-body">
        {sidebarOpen && <Sidebar />}
        <main id="folio-main" className="folio-main" tabIndex={-1} aria-label="Document">
          <PdfViewer />
        </main>
      </div>
      {searchOpen && <SearchBar />}
      <ToastHost />
    </div>
  );
}
