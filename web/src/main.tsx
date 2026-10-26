import { createClient } from '@assetpulse/client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { resolveHospitalId, socketUrl } from './hospital';
import { createConsoleStore } from './store';
import './theme.css';

// The console's socket, created outside React so StrictMode's double effects never open two.
// The tech's phone (an iframe of /tech) opens its own.
const hospitalId = resolveHospitalId();
const url = socketUrl();
const store = createConsoleStore(createClient({ url, hospitalId, topics: ['floor', 'role:ops'] }));
const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App store={store} hospitalId={hospitalId} />
  </StrictMode>,
);
