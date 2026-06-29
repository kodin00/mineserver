import type { ReactNode } from "react";
import { Box, LogOut, Settings } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";

export function Layout({
  children,
  title,
  subtitle,
  actions,
}: {
  children: ReactNode;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  const auth = useAuth();
  const navigate = useNavigate();
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" to="/">
          <span className="brand-mark">
            <Box size={20} />
          </span>
          <span>Mineserver</span>
        </Link>
        <div className="top-actions">
          <Link
            className="icon-button"
            aria-label="Account settings"
            title="Account settings"
            to="/account"
          >
            <Settings size={18} />
          </Link>
          <button
            className="icon-button"
            aria-label="Sign out"
            title="Sign out"
            onClick={() => void auth.logout().then(() => navigate("/login"))}
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>
      <main className="page">
        <div className="page-heading">
          <div>
            <h1>{title}</h1>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions && <div className="heading-actions">{actions}</div>}
        </div>
        {children}
      </main>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return <div className="error-banner">{message}</div>;
}

export function StatusDot({ state }: { state: string }) {
  return <span className={`status-dot status-${state}`} aria-hidden="true" />;
}
