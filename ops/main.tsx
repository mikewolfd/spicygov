import { createRoot } from 'react-dom/client';
import { SourceCatalog } from '../components/source-catalog';
import '../app/globals.css';
import './style.css';
const loopback = ['localhost','127.0.0.1','[::1]'].includes(location.hostname);
createRoot(document.getElementById('root')!).render(loopback ? <main className="sources-content"><h1>Local source operations</h1><p>Read-only local holdings, verification evidence and planned work.</p><SourceCatalog internal manifestUrl="/__source-catalog-internal/manifest.json" /></main> : <p>Local source operations require a loopback connection.</p>);
