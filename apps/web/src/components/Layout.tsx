import { useEffect, useId, useRef, type ReactNode } from "react";
import { LogOut, Settings } from "lucide-react";
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
            <img
              src={`${import.meta.env.BASE_URL}mineserver-logo.webp`}
              alt=""
              width="35"
              height="35"
            />
          </span>
          <span>Mineserver</span>
        </Link>
        <div className="top-actions">
          <span className="role-label">
            {auth.role === "admin" ? "Administrator" : "Player"}
          </span>
          {import.meta.env.VITE_DEMO === "true" && (
            <button
              className="button ghost"
              onClick={() =>
                void auth
                  .login("demo", auth.role === "admin" ? "player" : "admin")
                  .then(() => navigate("/"))
              }
            >
              Switch to {auth.role === "admin" ? "player" : "admin"}
            </button>
          )}
          {auth.role === "admin" && (
            <Link
              className="icon-button"
              aria-label="Account settings"
              title="Account settings"
              to="/account"
            >
              <Settings size={18} />
            </Link>
          )}
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
      {import.meta.env.VITE_DEMO === "true" && (
        <div className="demo-banner" role="status">
          Demo mode · Sample data only; no real servers are controlled.
        </div>
      )}
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
  return (
    <div className="error-banner" role="alert">
      {message}
    </div>
  );
}

export function ConfirmationDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Several dialogs can share a page, so ids must be unique per instance.
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="confirmation-dialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="dialog-card">
        <h2 id={titleId}>{title}</h2>
        <p id={bodyId}>{body}</p>
        <div className="dialog-actions">
          <button className="button ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="button danger" onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function StatusDot({ state }: { state: string }) {
  return <span className={`status-dot status-${state}`} aria-hidden="true" />;
}
