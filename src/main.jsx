import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import AdminDashboard from './AdminDashboard.jsx';
import './styles.css';
import './admin-dashboard.css';

const isAdminRoute = window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/');

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isAdminRoute ? <AdminDashboard /> : <App />}
  </StrictMode>,
);
