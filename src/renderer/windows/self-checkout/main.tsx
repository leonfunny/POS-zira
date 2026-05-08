import React from 'react';
import ReactDOM from 'react-dom/client';
import SelfCheckoutApp from './SelfCheckoutApp';
import '../../index.css';

document.documentElement.classList.add('self-checkout-root');
document.body.classList.add('self-checkout-root');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SelfCheckoutApp />
  </React.StrictMode>,
);
