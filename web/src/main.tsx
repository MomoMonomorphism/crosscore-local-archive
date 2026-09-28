import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { installStaticGateway } from './staticGateway'
import './styles.css'
import './galleryLayout.css'
import './asmrLayout.css'
import './illustrationLayout.css'
import './galleryTheme.css'

installStaticGateway()
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
