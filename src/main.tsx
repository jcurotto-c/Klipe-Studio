import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { ensureFontsReady } from './overlays/fonts';

// Warm the self-hosted card/overlay fonts at startup so they're decoded before
// the first Pixi text render (and well before any export).
void ensureFontsReady();

const container = document.getElementById('root');
if (!container) throw new Error('#root element not found');
createRoot(container).render(<App />);
