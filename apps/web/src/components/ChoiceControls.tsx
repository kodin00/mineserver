import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, ChevronDown, MoreVertical } from "lucide-react";

export interface ChoiceOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

function nextEnabledIndex<T extends string>(
  options: ChoiceOption<T>[],
  start: number,
  direction: 1 | -1,
) {
  for (let step = 1; step <= options.length; step += 1) {
    const index = (start + direction * step + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

function edgeEnabledIndex<T extends string>(
  options: ChoiceOption<T>[],
  edge: "first" | "last",
) {
  const start = edge === "first" ? 0 : options.length - 1;
  const direction = edge === "first" ? 1 : -1;
  for (
    let index = start;
    index >= 0 && index < options.length;
    index += direction
  ) {
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

function useDismissablePopup(
  open: boolean,
  setOpen: (open: boolean) => void,
  rootRef: React.RefObject<HTMLElement | null>,
  triggerRef: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    function pointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function keyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", pointerDown);
    document.addEventListener("keydown", keyDown);
    return () => {
      document.removeEventListener("pointerdown", pointerDown);
      document.removeEventListener("keydown", keyDown);
    };
  }, [open, rootRef, setOpen, triggerRef]);
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className = "",
}: {
  value: T;
  options: ChoiceOption<T>[];
  onChange(value: T): void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const typeahead = useRef("");
  const typeaheadTimer = useRef<number | null>(null);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];

  useDismissablePopup(open, setOpen, rootRef, triggerRef);

  useEffect(() => {
    if (!open) return;
    const index =
      selectedIndex >= 0 && !options[selectedIndex]?.disabled
        ? selectedIndex
        : edgeEnabledIndex(options, "first");
    setActiveIndex(index);
    requestAnimationFrame(() => optionRefs.current[index]?.focus());
  }, [open, options, selectedIndex]);

  useEffect(
    () => () => {
      if (typeaheadTimer.current !== null)
        window.clearTimeout(typeaheadTimer.current);
    },
    [],
  );

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function move(index: number) {
    if (index < 0) return;
    setActiveIndex(index);
    optionRefs.current[index]?.focus();
  }

  function typeToOption(key: string) {
    typeahead.current += key.toLocaleLowerCase();
    if (typeaheadTimer.current !== null)
      window.clearTimeout(typeaheadTimer.current);
    typeaheadTimer.current = window.setTimeout(() => {
      typeahead.current = "";
    }, 500);
    const start = Math.max(activeIndex, -1);
    for (let offset = 1; offset <= options.length; offset += 1) {
      const index = (start + offset) % options.length;
      const option = options[index];
      if (
        option &&
        !option.disabled &&
        option.label.toLocaleLowerCase().startsWith(typeahead.current)
      ) {
        move(index);
        return;
      }
    }
  }

  function listKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(
        nextEnabledIndex(
          options,
          activeIndex,
          event.key === "ArrowDown" ? 1 : -1,
        ),
      );
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      move(edgeEnabledIndex(options, event.key === "Home" ? "first" : "last"));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key.length === 1 && /\S/.test(event.key)) {
      typeToOption(event.key);
    }
  }

  return (
    <div className={`choice-control ${className}`.trim()} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="choice-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (
            !open &&
            ["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)
          ) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{selected?.label ?? value}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={id}
          className="choice-popover"
          role="listbox"
          aria-label={ariaLabel}
          onKeyDown={listKeyDown}
        >
          {options.map((option, index) => (
            <button
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              type="button"
              role="option"
              tabIndex={index === activeIndex ? 0 : -1}
              aria-selected={option.value === value}
              disabled={option.disabled}
              className={`choice-option${option.value === value ? " selected" : ""}`}
              key={option.value}
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={15} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Combobox({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder,
}: {
  value: string;
  options: ChoiceOption[];
  onChange(value: string): void;
  ariaLabel: string;
  placeholder?: string;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const filtered = useMemo(() => {
    const query = value.trim().toLocaleLowerCase();
    if (!query) return options;
    const starts = options.filter((option) =>
      option.label.toLocaleLowerCase().startsWith(query),
    );
    const contains = options.filter(
      (option) =>
        !starts.includes(option) &&
        option.label.toLocaleLowerCase().includes(query),
    );
    return [...starts, ...contains];
  }, [options, value]);

  useDismissablePopup(open, setOpen, rootRef, inputRef);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(edgeEnabledIndex(filtered, "first"));
  }, [filtered, open]);

  function choose(index: number) {
    const option = filtered[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function activate(index: number) {
    if (index < 0) return;
    setActiveIndex(index);
    requestAnimationFrame(() =>
      optionRefs.current[index]?.scrollIntoView({ block: "nearest" }),
    );
  }

  function inputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const index = nextEnabledIndex(
        filtered,
        activeIndex,
        event.key === "ArrowDown" ? 1 : -1,
      );
      activate(index);
    } else if (event.key === "Home" && open) {
      event.preventDefault();
      activate(edgeEnabledIndex(filtered, "first"));
    } else if (event.key === "End" && open) {
      event.preventDefault();
      activate(edgeEnabledIndex(filtered, "last"));
    } else if (event.key === "Enter" && open && activeIndex >= 0) {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className="choice-control combobox-control" ref={rootRef}>
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open && filtered.length > 0}
        aria-controls={open && filtered.length > 0 ? id : undefined}
        aria-activedescendant={
          open && filtered.length > 0 && activeIndex >= 0
            ? `${id}-option-${activeIndex}`
            : undefined
        }
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={inputKeyDown}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
      />
      <button
        type="button"
        className="combobox-toggle"
        aria-label={open ? "Hide suggestions" : "Show suggestions"}
        tabIndex={-1}
        onClick={() => {
          setOpen((current) => !current);
          inputRef.current?.focus();
        }}
      >
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && filtered.length > 0 && (
        <div
          id={id}
          className="choice-popover"
          role="listbox"
          aria-label={ariaLabel}
        >
          {filtered.map((option, index) => (
            <button
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              id={`${id}-option-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={option.value === value}
              disabled={option.disabled}
              className={`choice-option${index === activeIndex ? " active" : ""}${option.value === value ? " selected" : ""}`}
              key={option.value}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={15} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface ActionMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onSelect(): void;
}

export function ActionMenu({
  label,
  items,
  className = "",
}: {
  label: string;
  items: ActionMenuItem[];
  className?: string;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const options = items.map((item) => ({
    value: item.id,
    label: item.label,
    ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
  }));

  useDismissablePopup(open, setOpen, rootRef, triggerRef);

  useEffect(() => {
    if (!open) return;
    const index = edgeEnabledIndex(options, "first");
    setActiveIndex(index);
    requestAnimationFrame(() => itemRefs.current[index]?.focus());
  }, [open]);

  function move(index: number) {
    if (index < 0) return;
    setActiveIndex(index);
    itemRefs.current[index]?.focus();
  }

  function activate(index: number) {
    const item = items[index];
    if (!item || item.disabled) return;
    setOpen(false);
    item.onSelect();
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <div className={`action-menu ${className}`.trim()} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="icon-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (
            !open &&
            ["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)
          ) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <MoreVertical size={17} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={id}
          className="action-menu-popover"
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              move(
                nextEnabledIndex(
                  options,
                  activeIndex,
                  event.key === "ArrowDown" ? 1 : -1,
                ),
              );
            } else if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              move(
                edgeEnabledIndex(
                  options,
                  event.key === "Home" ? "first" : "last",
                ),
              );
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              activate(activeIndex);
            }
          }}
        >
          {items.map((item, index) => (
            <button
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              type="button"
              role="menuitem"
              tabIndex={index === activeIndex ? 0 : -1}
              disabled={item.disabled}
              className={`action-menu-item${item.danger ? " danger" : ""}`}
              key={item.id}
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => activate(index)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
