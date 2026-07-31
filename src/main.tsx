import '@/shims/node';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ErrorBoundary } from '@/components/common';
import { ThemeProvider } from '@/theme/ThemeProvider';

import { App } from './App';

import '@/theme/tokens.css';
import '@/styles/global.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root was not found');

createRoot(rootEl).render(
  <StrictMode>
    {/* Outside ThemeProvider so a throw from the provider itself is caught too;
        the fallback styles off the :root defaults in tokens.css. */}
    <ErrorBoundary>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);
