import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useId,
  useState,
} from "react";
import { Check, ChevronRight, Minus, Plus } from "lucide-react";

interface ToggleProps {
  checked: boolean;
  onChange(next: boolean): void;
  children: ReactNode;
  disabled?: boolean;
  /** Class applied to the wrapping label (keeps existing row layouts). */
  className?: string;
  /** Render the control before the label text instead of after it. */
  controlFirst?: boolean;
  required?: boolean;
  invalid?: boolean;
}

function ToggleControl({
  role,
  checked,
  onChange,
  children,
  disabled = false,
  className = "",
  controlFirst = false,
  required = false,
  invalid = false,
}: ToggleProps & { role: "checkbox" | "switch" }) {
  const control = (
    <button
      type="button"
      role={role}
      className={role === "switch" ? "switch-control" : "checkbox-control"}
      aria-checked={checked}
      aria-required={required || undefined}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      {role === "switch" ? (
        <span className="switch-thumb" aria-hidden="true" />
      ) : (
        <Check size={13} strokeWidth={3} aria-hidden="true" />
      )}
    </button>
  );
  const text = <span className="toggle-text">{children}</span>;
  return (
    // The label wraps the button, so clicking the text activates it.
    <label
      className={`toggle-label${disabled ? " disabled" : ""} ${className}`.trim()}
    >
      {controlFirst ? control : text}
      {controlFirst ? text : control}
    </label>
  );
}

export function Checkbox(props: ToggleProps) {
  return <ToggleControl role="checkbox" {...props} />;
}

export function Switch(props: ToggleProps) {
  return <ToggleControl role="switch" {...props} />;
}

function clampNumber(value: number, min?: number, max?: number) {
  let next = value;
  if (min !== undefined) next = Math.max(min, next);
  if (max !== undefined) next = Math.min(max, next);
  return next;
}

function formatStepped(value: number) {
  return String(Number(value.toFixed(10)));
}

/**
 * Text-based number input. The raw text is owned by the parent so a field can
 * be emptied and retyped; parsing and validation happen on submit.
 */
export function NumberField({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled = false,
  ariaLabel,
  decimal = false,
}: {
  value: string;
  onChange(text: string): void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  ariaLabel?: string;
  decimal?: boolean;
}) {
  const allowNegative = min === undefined || min < 0;
  const pattern = new RegExp(
    `^${allowNegative ? "-?" : ""}\\d*${decimal ? "\\.?\\d*" : ""}$`,
  );
  const parsed = value.trim() === "" ? Number.NaN : Number(value);
  const canDecrease =
    !disabled && (Number.isNaN(parsed) || min === undefined || parsed > min);
  const canIncrease =
    !disabled && (Number.isNaN(parsed) || max === undefined || parsed < max);

  function stepBy(direction: 1 | -1) {
    const base = Number.isNaN(parsed) ? (min ?? 0) - direction * step : parsed;
    const next = clampNumber(base + direction * step, min, max);
    onChange(formatStepped(next));
  }

  function keyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      stepBy(event.key === "ArrowUp" ? 1 : -1);
    }
  }

  return (
    <span className={`number-field${disabled ? " disabled" : ""}`}>
      <input
        type="text"
        role="spinbutton"
        inputMode={decimal ? "decimal" : "numeric"}
        autoComplete="off"
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number.isNaN(parsed) ? undefined : parsed}
        disabled={disabled}
        value={value}
        onKeyDown={keyDown}
        onChange={(event) => {
          if (pattern.test(event.target.value)) onChange(event.target.value);
        }}
      />
      <button
        type="button"
        className="number-step"
        tabIndex={-1}
        aria-label="Decrease"
        disabled={!canDecrease}
        // Keep focus in the input while stepping.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => stepBy(-1)}
      >
        <Minus size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="number-step"
        tabIndex={-1}
        aria-label="Increase"
        disabled={!canIncrease}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => stepBy(1)}
      >
        <Plus size={14} aria-hidden="true" />
      </button>
    </span>
  );
}

export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className = "",
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`disclosure${open ? " open" : ""} ${className}`.trim()}>
      <button
        type="button"
        className="disclosure-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRight size={14} aria-hidden="true" />
        <span>{summary}</span>
      </button>
      <div id={id} className="disclosure-panel" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
