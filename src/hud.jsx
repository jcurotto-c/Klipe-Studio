import React from 'react';
import { createRoot } from 'react-dom/client';
import FloatingHUD from './components/FloatingHUD.jsx';
import './components/FloatingHUD.css';

createRoot(document.getElementById('hud-root')).render(<FloatingHUD />);
