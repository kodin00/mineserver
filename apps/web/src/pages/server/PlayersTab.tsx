import { useCallback, useEffect, useRef, useState } from "react";
import {
  Ban,
  ChevronDown,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import type {
  OnlinePlayers,
  PlayerAction,
  PlayerActionResult,
  ServerSummary,
  WhitelistAction,
} from "@mineserver/shared";
import { api, jsonBody } from "../../api";
import {
  ConfirmationDialog,
  EmptyState,
  ErrorBanner,
} from "../../components/Layout";

type Pending =
  | { kind: "player"; action: PlayerAction; title: string; body: string }
  | { kind: "whitelist"; action: WhitelistAction; title: string; body: string };

const playerNamePattern = /^[A-Za-z0-9_]{1,16}$/;

function actionLabel(action: PlayerAction["action"]): string {
  switch (action) {
    case "whitelist-add":
      return "Add to whitelist";
    case "whitelist-remove":
      return "Remove from whitelist";
    case "pardon":
      return "Pardon";
    case "deop":
      return "Remove operator";
    case "op":
      return "Make operator";
    case "kick":
      return "Kick";
    case "ban":
      return "Ban";
  }
}

function PlayerActionMenu({
  player,
  disabled,
  onAction,
}: {
  player: string;
  disabled: boolean;
  onAction(action: PlayerAction["action"]): void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = `player-actions-${player}`;
  const actions: PlayerAction["action"][] = [
    "kick",
    "ban",
    "whitelist-add",
    "whitelist-remove",
    "op",
    "deop",
  ];

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  function closeAndRestore() {
    setOpen(false);
    window.setTimeout(() => trigger.current?.focus());
  }

  function moveFocus(index: number) {
    items.current[(index + actions.length) % actions.length]?.focus();
  }

  return (
    <div className="player-action-menu" ref={root}>
      <button
        ref={trigger}
        className="button ghost"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            window.setTimeout(() => moveFocus(0));
          }
        }}
      >
        Manage <ChevronDown size={15} />
      </button>
      {open && (
        <div
          className="player-menu"
          id={menuId}
          role="menu"
          aria-label={`Actions for ${player}`}
          onKeyDown={(event) => {
            const index = items.current.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            if (event.key === "Escape") {
              event.preventDefault();
              closeAndRestore();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              moveFocus(index + 1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveFocus(index - 1);
            } else if (event.key === "Home") {
              event.preventDefault();
              moveFocus(0);
            } else if (event.key === "End") {
              event.preventDefault();
              moveFocus(actions.length - 1);
            }
          }}
        >
          {actions.map((action, index) => (
            <button
              key={action}
              ref={(node) => {
                items.current[index] = node;
              }}
              role="menuitem"
              className={action === "ban" ? "danger-item" : ""}
              onClick={() => {
                setOpen(false);
                onAction(action);
              }}
            >
              {actionLabel(action)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function PlayersTab({ server }: { server: ServerSummary }) {
  const [players, setPlayers] = useState<OnlinePlayers | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [target, setTarget] = useState("");
  const [reasonFor, setReasonFor] = useState<"kick" | "ban" | null>(null);
  const [reasonTarget, setReasonTarget] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const available = server.state === "running";

  const load = useCallback(async () => {
    if (!available) {
      setPlayers(null);
      return;
    }
    setLoading(true);
    setError("");
    try {
      setPlayers(await api<OnlinePlayers>(`/api/servers/${server.id}/players`));
    } catch (caught) {
      setPlayers(null);
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to load online players",
      );
    } finally {
      setLoading(false);
    }
  }, [available, server.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function execute(item: Pending) {
    setPending(null);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const path =
        item.kind === "player"
          ? `/api/servers/${server.id}/players/actions`
          : `/api/servers/${server.id}/whitelist/actions`;
      const result = await api<PlayerActionResult>(path, {
        method: "POST",
        ...jsonBody(item.action),
      });
      if (result.players) setPlayers(result.players);
      else if (item.kind === "player") await load();
      setNotice(result.output || `${item.title} completed.`);
      setTarget("");
      setReason("");
      setReasonFor(null);
      setReasonTarget("");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Player action failed",
      );
    } finally {
      setBusy(false);
    }
  }

  function preparePlayerAction(action: PlayerAction["action"], player: string) {
    if (action === "kick" || action === "ban") {
      setReasonFor(action);
      setReasonTarget(player);
      setReason("");
      return;
    }
    const destructive = action === "deop" || action === "whitelist-remove";
    setPending({
      kind: "player",
      action: { action, player } as PlayerAction,
      title: actionLabel(action),
      body: destructive
        ? `${player} will immediately lose ${action === "deop" ? "operator permissions" : "whitelist access"}.`
        : `${actionLabel(action)} for ${player}?`,
    });
  }

  function prepareWhitelist(action: WhitelistAction["action"]) {
    setPending({
      kind: "whitelist",
      action: { action },
      title:
        action === "on"
          ? "Enable whitelist"
          : action === "off"
            ? "Disable whitelist"
            : "Reload whitelist",
      body:
        action === "off"
          ? "Anyone who can authenticate with this server may join after the whitelist is disabled."
          : action === "on"
            ? "Only players in Minecraft's live whitelist will be allowed to join."
            : "Reload the live whitelist from disk now?",
    });
  }

  const validTarget = playerNamePattern.test(target);

  return (
    <div className="tab-stack">
      <ConfirmationDialog
        open={pending !== null}
        title={pending?.title ?? "Confirm player action"}
        body={pending?.body ?? ""}
        confirmLabel={pending?.title ?? "Confirm"}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending) void execute(pending);
        }}
      />

      {reasonFor && (
        <dialog
          className="confirmation-dialog"
          open
          aria-labelledby="player-reason-title"
          onCancel={(event) => {
            event.preventDefault();
            setReasonFor(null);
          }}
        >
          <form
            className="dialog-card player-reason-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              const action: PlayerAction = {
                action: reasonFor,
                player: reasonTarget,
                ...(reason.trim() ? { reason: reason.trim() } : {}),
              };
              setReasonFor(null);
              setPending({
                kind: "player",
                action,
                title: actionLabel(action.action),
                body: `${actionLabel(action.action)} ${reasonTarget}${reason.trim() ? ` with reason “${reason.trim()}”` : ""}?`,
              });
            }}
          >
            <h2 id="player-reason-title">
              {actionLabel(reasonFor)} {reasonTarget}
            </h2>
            <label>
              Reason (optional)
              <input
                autoFocus
                value={reason}
                maxLength={300}
                placeholder="Shown to the player"
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <div className="dialog-actions">
              <button
                type="button"
                className="button ghost"
                onClick={() => setReasonFor(null)}
              >
                Cancel
              </button>
              <button type="submit" className="button danger">
                Review {reasonFor}
              </button>
            </div>
          </form>
        </dialog>
      )}

      {error && <ErrorBanner message={error} />}
      {notice && (
        <p className="notice-banner" role="status">
          {notice}
        </p>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {loading
          ? "Refreshing players"
          : players
            ? `${players.online} players online`
            : ""}
      </span>

      <section className="panel player-summary-panel">
        <div>
          <span className="metric-icon purple">
            <Users size={19} />
          </span>
          <div>
            <small>Online now</small>
            <strong>
              {players
                ? `${players.online} / ${players.max}`
                : available
                  ? "—"
                  : "Offline"}
            </strong>
          </div>
        </div>
        <div className="button-row">
          <button
            className="button ghost"
            disabled={!available || loading || busy}
            onClick={() => void load()}
          >
            {loading ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <RefreshCw size={16} />
            )}
            Refresh
          </button>
          <button
            className="button ghost"
            disabled={!available || busy}
            onClick={() => prepareWhitelist("on")}
          >
            <ShieldCheck size={16} /> Whitelist on
          </button>
          <button
            className="button danger-outline"
            disabled={!available || busy}
            onClick={() => prepareWhitelist("off")}
          >
            <ShieldOff size={16} /> Whitelist off
          </button>
          <button
            className="button ghost"
            disabled={!available || busy}
            onClick={() => prepareWhitelist("reload")}
          >
            <RefreshCw size={16} /> Reload list
          </button>
        </div>
      </section>

      {!available ? (
        <EmptyState
          icon={<Users size={26} />}
          title="Player controls unavailable"
          body="Run the game server and wait for RCON to become ready before managing players."
        />
      ) : (
        <>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Online players</h2>
                <p>Actions run through validated RCON commands.</p>
              </div>
            </div>
            <div className="player-list">
              {loading && !players && (
                <p className="muted player-list-empty">Loading players…</p>
              )}
              {!loading && players?.players.length === 0 && (
                <p className="muted player-list-empty">Nobody is online.</p>
              )}
              {players?.players.map(({ name }) => (
                <div className="player-row" key={name}>
                  <span className="player-avatar" aria-hidden="true">
                    {name.slice(0, 1).toUpperCase()}
                  </span>
                  <strong>{name}</strong>
                  <PlayerActionMenu
                    player={name}
                    disabled={busy}
                    onAction={(action) => preparePlayerAction(action, name)}
                  />
                </div>
              ))}
            </div>
          </section>

          <section className="panel player-manual-panel">
            <div className="panel-heading">
              <div>
                <h2>Manage any player</h2>
                <p>
                  Pardon, whitelist, or change operator access by exact name.
                </p>
              </div>
            </div>
            <label>
              Minecraft player name
              <input
                value={target}
                maxLength={16}
                placeholder="Steve"
                autoComplete="off"
                onChange={(event) => setTarget(event.target.value.trim())}
              />
            </label>
            {target && !validTarget && (
              <small className="player-field-error">
                Use 1–16 letters, numbers, or underscores.
              </small>
            )}
            <div className="button-row">
              <button
                className="button ghost"
                disabled={!validTarget || busy}
                onClick={() => preparePlayerAction("pardon", target)}
              >
                <UserPlus size={16} /> Pardon
              </button>
              <button
                className="button ghost"
                disabled={!validTarget || busy}
                onClick={() => preparePlayerAction("whitelist-add", target)}
              >
                <ShieldCheck size={16} /> Add to whitelist
              </button>
              <button
                className="button ghost"
                disabled={!validTarget || busy}
                onClick={() => preparePlayerAction("op", target)}
              >
                <UserPlus size={16} /> Make operator
              </button>
              <button
                className="button danger-outline"
                disabled={!validTarget || busy}
                onClick={() => preparePlayerAction("whitelist-remove", target)}
              >
                <UserMinus size={16} /> Remove from whitelist
              </button>
              <button
                className="button danger-outline"
                disabled={!validTarget || busy}
                onClick={() => preparePlayerAction("deop", target)}
              >
                <UserMinus size={16} /> Remove operator
              </button>
              <button
                className="button danger-outline"
                disabled={!validTarget || busy}
                onClick={() => preparePlayerAction("ban", target)}
              >
                <Ban size={16} /> Ban
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
