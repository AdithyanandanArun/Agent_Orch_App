import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/app.css';
import './styles/shell.css';
import './styles/select-menu.css';
import './styles/context-menu.css';
import './styles/settings.css';
import './styles/conversation.css';
import { App } from './App';
import { Boundary } from './components/ui';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boundary label="Relay">
      <App />
    </Boundary>
  </StrictMode>,
);
