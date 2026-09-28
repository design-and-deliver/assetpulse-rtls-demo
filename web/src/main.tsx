import { createClient } from '@assetpulse/client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { resolveHospitalId, socketUrl } from './hospital';
import { createPager } from './pager';
import { createConsoleStore } from './store';
import './theme.css';

// Two sockets per page — the console and the tech pager — created outside React so StrictMode's
// double effects never open four.
const hospitalId = resolveHospitalId();
const url = socketUrl();
const store = createConsoleStore(createClient({ url, hospitalId, topics: ['floor', 'role:ops'] }));
const pager = createPager(createClient({ url, hospitalId, topics: ['role:tech'] }));

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');
createRoot(root).render(
  <StrictMode>
    <App store={store} pager={pager} hospitalId={hospitalId} />
  </StrictMode>,
);
