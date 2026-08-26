import { useState, type FormEvent } from "react";
import { ChevronDown, LoaderCircle, Save } from "lucide-react";
import {
  ServerConfigSchema,
  difficulties,
  gameModes,
  serverTypes,
  type ServerConfig,
} from "@mineserver/shared";
import { Combobox, Select } from "./ChoiceControls";
import { ErrorBanner } from "./Layout";

export const defaultServerConfig: ServerConfig = ServerConfigSchema.parse({
  name: "My Minecraft Server",
  type: "PAPER",
  version: "LATEST",
  port: 25565,
  serverIconUrl: null,
  initMemory: "1G",
  maxMemory: "4G",
});

function recordText(record: Record<string, string>) {
  return Object.entries(record)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function parseRecord(value: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const rawLine of value.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`Expected KEY=value: ${line}`);
    output[line.slice(0, separator).trim()] = line.slice(separator + 1);
  }
  return output;
}

export function ServerForm({
  initial,
  submitLabel,
  requireEula,
  versionSuggestions = [],
  onSubmit,
}: {
  initial: ServerConfig;
  submitLabel: string;
  requireEula?: boolean;
  versionSuggestions?: string[];
  onSubmit(value: ServerConfig, acceptEula: boolean): Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [advancedEnv, setAdvancedEnv] = useState(
    recordText(initial.advancedEnv),
  );
  const [customProperties, setCustomProperties] = useState(
    recordText(initial.customProperties),
  );
  const [acceptEula, setAcceptEula] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(
    Object.keys(initial.advancedEnv).length > 0 ||
      Object.keys(initial.customProperties).length > 0,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function set<K extends keyof ServerConfig>(key: K, next: ServerConfig[K]) {
    setValue((current) => ({ ...current, [key]: next }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const parsed = ServerConfigSchema.parse({
        ...value,
        advancedEnv: parseRecord(advancedEnv),
        customProperties: parseRecord(customProperties),
      });
      await onSubmit(parsed, acceptEula);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to save server",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={submit}>
      {error && <ErrorBanner message={error} />}
      <section className="form-section">
        <div className="section-heading">
          <h2>Server identity</h2>
          <p>The version and runtime used when this world starts.</p>
        </div>
        <div className="form-grid">
          <label className="span-2">
            Server name
            <input
              value={value.name}
              onChange={(event) => set("name", event.target.value)}
              required
              maxLength={64}
              placeholder="Survival with friends"
            />
          </label>
          <label>
            Server type
            <Select
              value={value.type}
              options={serverTypes.map((type) => ({
                value: type,
                label: type,
              }))}
              ariaLabel="Server type"
              onChange={(next) => set("type", next)}
            />
          </label>
          <label>
            Minecraft version
            <Combobox
              value={value.version}
              options={[
                { value: "LATEST", label: "LATEST" },
                { value: "SNAPSHOT", label: "SNAPSHOT" },
                ...versionSuggestions.map((version) => ({
                  value: version,
                  label: version,
                })),
              ].filter(
                (option, index, all) =>
                  all.findIndex((entry) => entry.value === option.value) ===
                  index,
              )}
              ariaLabel="Minecraft version"
              onChange={(next) => set("version", next)}
              placeholder="LATEST or 1.21.5"
            />
          </label>
          <label>
            Host port
            <input
              type="number"
              min={1024}
              max={65535}
              value={value.port}
              onChange={(event) => set("port", Number(event.target.value))}
            />
          </label>
          <label>
            Server icon URL
            <input
              value={value.serverIconUrl ?? ""}
              onChange={(event) =>
                set("serverIconUrl", event.target.value || null)
              }
              placeholder="https://example.com/server-icon.png"
            />
            <small>
              Optional picture shown in the Minecraft multiplayer server list.
            </small>
          </label>
          <label>
            Java image override
            <input
              value={value.javaTag ?? ""}
              onChange={(event) => set("javaTag", event.target.value || null)}
              placeholder="Automatic"
            />
            <small>Leave empty to choose from the Minecraft version.</small>
          </label>
        </div>
      </section>

      <section className="form-section">
        <div className="section-heading">
          <h2>Performance</h2>
          <p>Memory and world distance limits for the Java process.</p>
        </div>
        <div className="form-grid">
          <label>
            Initial RAM
            <input
              value={value.initMemory}
              onChange={(event) => set("initMemory", event.target.value)}
            />
          </label>
          <label>
            Maximum RAM
            <input
              value={value.maxMemory}
              onChange={(event) => set("maxMemory", event.target.value)}
            />
          </label>
          <label>
            View distance
            <input
              type="number"
              min={2}
              max={64}
              value={value.viewDistance}
              onChange={(event) =>
                set("viewDistance", Number(event.target.value))
              }
            />
          </label>
          <label>
            Simulation distance
            <input
              type="number"
              min={2}
              max={64}
              value={value.simulationDistance}
              onChange={(event) =>
                set("simulationDistance", Number(event.target.value))
              }
            />
          </label>
          <label>
            Maximum players
            <input
              type="number"
              min={1}
              max={1000}
              value={value.maxPlayers}
              onChange={(event) =>
                set("maxPlayers", Number(event.target.value))
              }
            />
          </label>
        </div>
      </section>

      <section className="form-section">
        <div className="section-heading">
          <h2>On-demand server</h2>
          <p>
            Keep a lightweight Minecraft listener online while the game
            container sleeps.
          </p>
        </div>
        <div className="form-grid">
          <label className="toggle-row span-2">
            <span>Sleep when nobody is playing and wake on join</span>
            <input
              type="checkbox"
              checked={value.autoSleep.enabled}
              onChange={(event) =>
                set("autoSleep", {
                  ...value.autoSleep,
                  enabled: event.target.checked,
                })
              }
            />
          </label>
          <label>
            Empty server timeout (minutes)
            <input
              type="number"
              min={1}
              max={7 * 24 * 60}
              disabled={!value.autoSleep.enabled}
              value={value.autoSleep.idleMinutes}
              onChange={(event) =>
                set("autoSleep", {
                  ...value.autoSleep,
                  idleMinutes: Number(event.target.value),
                })
              }
            />
            <small>
              The first join wakes the server. Startup can take up to a minute.
            </small>
          </label>
        </div>
      </section>

      <section className="form-section">
        <div className="section-heading">
          <h2>World and gameplay</h2>
          <p>Player-facing rules written into server.properties.</p>
        </div>
        <div className="form-grid">
          <label className="span-2">
            Message of the day
            <input
              value={value.motd}
              onChange={(event) => set("motd", event.target.value)}
              maxLength={300}
            />
          </label>
          <label>
            Game mode
            <Select
              value={value.gameMode}
              options={gameModes.map((mode) => ({
                value: mode,
                label: mode,
              }))}
              ariaLabel="Game mode"
              onChange={(next) => set("gameMode", next)}
            />
          </label>
          <label>
            Difficulty
            <Select
              value={value.difficulty}
              options={difficulties.map((difficulty) => ({
                value: difficulty,
                label: difficulty,
              }))}
              ariaLabel="Difficulty"
              onChange={(next) => set("difficulty", next)}
            />
          </label>
          <label className="span-2">
            World seed
            <input
              value={value.seed}
              onChange={(event) => set("seed", event.target.value)}
              placeholder="Random"
            />
          </label>
          <div className="toggle-grid span-2">
            {[
              ["pvp", "Player vs player", value.pvp],
              ["onlineMode", "Online authentication", value.onlineMode],
              ["allowFlight", "Allow flight", value.allowFlight],
            ].map(([key, label, checked]) => (
              <label className="toggle-row" key={String(key)}>
                <span>{String(label)}</span>
                <input
                  type="checkbox"
                  checked={Boolean(checked)}
                  onChange={(event) =>
                    set(
                      key as keyof ServerConfig,
                      event.target.checked as never,
                    )
                  }
                />
              </label>
            ))}
          </div>
        </div>
      </section>

      <section className="form-section">
        <div className="section-heading">
          <h2>Backups</h2>
          <p>Consistent local archives coordinated through RCON.</p>
        </div>
        <div className="form-grid">
          <label className="toggle-row span-2">
            <span>Enable scheduled backups</span>
            <input
              type="checkbox"
              checked={value.backups.enabled}
              onChange={(event) =>
                set("backups", {
                  ...value.backups,
                  enabled: event.target.checked,
                })
              }
            />
          </label>
          <label>
            Cron schedule
            <input
              value={value.backups.cron}
              onChange={(event) =>
                set("backups", { ...value.backups, cron: event.target.value })
              }
              placeholder="0 4 * * *"
            />
          </label>
          <label>
            Retain days
            <input
              type="number"
              min={1}
              value={value.backups.retainDays}
              onChange={(event) =>
                set("backups", {
                  ...value.backups,
                  retainDays: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            Retain count
            <input
              type="number"
              min={1}
              value={value.backups.retainCount}
              onChange={(event) =>
                set("backups", {
                  ...value.backups,
                  retainCount: Number(event.target.value),
                })
              }
            />
          </label>
        </div>
      </section>

      <section className="form-section advanced-section">
        <button
          type="button"
          className="advanced-toggle"
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <span>
            <strong>Advanced configuration</strong>
            <small>
              Validated image variables and custom server properties.
            </small>
          </span>
          <ChevronDown className={advancedOpen ? "rotate" : ""} size={18} />
        </button>
        {advancedOpen && (
          <div className="form-grid advanced-fields">
            <label>
              Image environment
              <textarea
                rows={7}
                value={advancedEnv}
                onChange={(event) => setAdvancedEnv(event.target.value)}
                placeholder={"SPAWN_PROTECTION=0\nUSE_AIKAR_FLAGS=true"}
              />
            </label>
            <label>
              Custom server properties
              <textarea
                rows={7}
                value={customProperties}
                onChange={(event) => setCustomProperties(event.target.value)}
                placeholder={"resource-pack-required=true"}
              />
            </label>
          </div>
        )}
      </section>

      {requireEula && (
        <label className="eula-check">
          <input
            type="checkbox"
            checked={acceptEula}
            onChange={(event) => setAcceptEula(event.target.checked)}
          />
          <span>
            I accept the{" "}
            <a
              href="https://aka.ms/MinecraftEULA"
              target="_blank"
              rel="noreferrer"
            >
              Minecraft End User License Agreement
            </a>
            .
          </span>
        </label>
      )}
      <div className="form-footer">
        <button
          className="button primary"
          disabled={saving || (requireEula && !acceptEula)}
        >
          {saving ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <Save size={17} />
          )}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
