import { useEffect } from 'react';
import { Route, Routes } from 'react-router-dom';
import AdminPage from './pages/AdminPage.jsx';
import ArchitecturePage from './pages/ArchitecturePage.jsx';
import PaymentPage from './pages/PaymentPage.jsx';
import SuccessPage from './pages/SuccessPage.jsx';

export default function App() {
  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  return (
    <Routes>
      <Route path="/" element={<PaymentPage />} />
      <Route path="/success" element={<SuccessPage />} />
      <Route path="/admin" element={<AdminPage />} />
      <Route path="/architecture" element={<ArchitecturePage />} />
    </Routes>
  );
}
