import { createClient } from '@assetpulse/client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { resolveHospitalId, socketUrl } from './hospital';
import { createPager, PAGER_TECH_ID } from './pager';
import { createConsoleStore } from './store';
import { deviceKey, fetchTechName } from './techName';
import './theme.css';

// Two sockets per page — the console and the tech pager — created outside React so StrictMode's
// double effects never open four.
const hospitalId = resolveHospitalId();
const url = socketUrl();
const store = createConsoleStore(createClient({ url, hospitalId, topics: ['floor', 'role:ops'] }));
const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

// The pager's "Tech N" name comes first (one same-origin round trip), so every accept carries it.
void fetchTechName('', hospitalId, deviceKey('assetpulse.pagerDevice'), PAGER_TECH_ID).then(
  (techId) => {
    const pager = createPager(createClient({ url, hospitalId, topics: ['role:tech'] }), techId);
    createRoot(root).render(
      <StrictMode>
        <App store={store} pager={pager} hospitalId={hospitalId} />
      </StrictMode>,
    );
  },
);
