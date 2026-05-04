import { createRoot } from 'react-dom/client';
import FloatingHUD from './components/FloatingHUD';
import './components/FloatingHUD.css';

const container = document.getElementById('hud-root');
if (!container) throw new Error('#hud-root element not found');
createRoot(container).render(<FloatingHUD />);
