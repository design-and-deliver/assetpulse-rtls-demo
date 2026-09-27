import { createClient } from '@assetpulse/client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { resolveHospitalId, socketUrl } from './hospital';
import { createConsoleStore } from './store';
import { TechFallback } from './TechFallback';
import './theme.css';

// `/tech` is the fallback tech view until the Expo build is served there (Phase 4).
const isTech = /^\/tech\/?$/.test(window.location.pathname);

// One socket per page, created outside React so StrictMode's double effects never open two.
const hospitalId = resolveHospitalId();
const client = createClient({
  url: socketUrl(),
  hospitalId,
  topics: isTech ? ['role:tech'] : ['floor', 'role:ops'],
});
const store = createConsoleStore(client);
const techId = `tech-${Math.floor(1000 + Math.random() * 9000)}`;

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');
createRoot(root).render(
  <StrictMode>
    {isTech ? (
      <TechFallback store={store} techId={techId} />
    ) : (
      <App store={store} hospitalId={hospitalId} />
    )}
  </StrictMode>,
);
