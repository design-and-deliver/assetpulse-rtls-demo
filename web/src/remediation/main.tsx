import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { resolveHospitalId } from '../hospital';
import '../theme.css';
import { createRemediationApi } from './api';
import { RemediationPage } from './RemediationPage';

// Same sandbox id as the console (`?h=`): the customer whose devices this page shows.
const hospitalId = resolveHospitalId();
const api = createRemediationApi(hospitalId);
const root = document.getElementById('root');
if (!root) throw new Error('#root missing from riskradar/index.html');

createRoot(root).render(
  <StrictMode>
    <RemediationPage api={api} hospitalId={hospitalId} />
  </StrictMode>,
);
