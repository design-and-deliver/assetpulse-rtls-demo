import { createClient } from '@assetpulse/client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { resolveHospitalId, socketUrl } from './hospital';
import { createConsoleStore } from './store';
import './theme.css';

// One socket per page, created outside React so StrictMode's double effects never open two.
const hospitalId = resolveHospitalId();
const client = createClient({ url: socketUrl(), hospitalId, topics: ['floor', 'role:ops'] });
const store = createConsoleStore(client);

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');
createRoot(root).render(
  <StrictMode>
    <App store={store} hospitalId={hospitalId} />
  </StrictMode>,
);
