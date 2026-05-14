import { NavLink } from 'react-router-dom';

export default function BottomNav() {
  return (
    <nav className="bottom-nav" aria-label="PWA navigation">
      <NavLink to="/" end>
        <span className="nav-icon home-icon" />
        <span>Главная</span>
      </NavLink>
      <NavLink to="/" className="qr-link">
        <span className="qr-button">QR</span>
        <span>QR</span>
      </NavLink>
      <NavLink to="/success">
        <span className="nav-icon receipt-icon" />
        <span>Чеки</span>
      </NavLink>
      <NavLink to="/admin">
        <span className="nav-icon menu-icon" />
        <span>Меню</span>
      </NavLink>
    </nav>
  );
}
