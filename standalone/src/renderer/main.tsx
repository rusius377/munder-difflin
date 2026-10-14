import './langDefault';
import '@/design/global.css';
import i18n from '@/i18n';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { addDeskStrings } from './strings';
import { App } from './App';

addDeskStrings(i18n);

const root = document.getElementById('root');
if (!root) throw new Error('No root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
