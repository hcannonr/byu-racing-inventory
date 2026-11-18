import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
import './styles.css';
import { Gate } from './components/Gate';
import { ScanPage } from './components/ScanPage';

const scan = location.pathname.match(/^\/scan\/([^/]+)\/?$/);
createRoot(document.getElementById('root')!).render(
  <StrictMode>{scan ? <ScanPage id={decodeURIComponent(scan[1])} /> : <Gate join={/^\/join\/?$/.test(location.pathname)} />}</StrictMode>,
);
