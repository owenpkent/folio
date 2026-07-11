import '@/shims/node';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ThemeProvider } from '@/theme/ThemeProvider';

import { App } from './App';

import '@/theme/tokens.css';
import '@/styles/global.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root was not found');

createRoot(rootEl).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
