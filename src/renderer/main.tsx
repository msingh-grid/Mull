import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './tokens.css'
import './hud.css'

// The window is transparent and click-through; only the panel paints.
document.body.classList.add('hud-window')

const container = document.getElementById('root')
if (!container) {
  throw new Error('renderer: #root element missing')
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
