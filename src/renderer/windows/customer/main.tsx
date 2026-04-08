import React from 'react';
import ReactDOM from 'react-dom/client';
import CustomerApp from './CustomerApp';
import '../../index.css';

document.documentElement.classList.add('customer-display-root');
document.body.classList.add('customer-display-root');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CustomerApp />
  </React.StrictMode>
);
