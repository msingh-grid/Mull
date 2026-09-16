import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyHudTheme } from './theme'
import './tokens.css'
import './hud.css'

// The window is transparent and click-through; only the panel paints.
document.body.classList.add('hud-window')

// The HUD has its own appearance rule — "a page in the dark" keeps the panel
// paper-light while the rest of the desk goes lamplit (docs/DESIGN.md §6.8).
void window.mull?.settings.get().then(applyHudTheme)
window.mull?.settings.onChanged(applyHudTheme)

const container = document.getElementById('root')
if (!container) {
  throw new Error('renderer: #root element missing')
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
