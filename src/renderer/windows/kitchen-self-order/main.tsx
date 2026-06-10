import React from 'react';
import ReactDOM from 'react-dom/client';
import KitchenSelfOrderApp from './KitchenSelfOrderApp';
import '../../index.css';

document.documentElement.classList.add('self-checkout-root');
document.body.classList.add('self-checkout-root');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <KitchenSelfOrderApp />
  </React.StrictMode>,
);
