import { useId, type ReactNode } from "react";
import clsx from "clsx";

const INPUT_CLASS =
  "selectable h-8 w-full rounded-[var(--radius-sm)] border bg-[var(--surface-base)] px-2.5 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)]";

export function Label({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-[12px] text-[var(--text-secondary)]">
      {children}
    </label>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  error?: string | null;
  placeholder?: string;
  type?: "text" | "password" | "time";
  inputMode?: "text" | "numeric";
  autoFocus?: boolean;
  optional?: boolean;
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  placeholder,
  type = "text",
  inputMode,
  autoFocus,
  optional,
}: TextFieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>
        {label}
        {optional && <span className="text-[var(--text-faint)]"> (optional)</span>}
      </Label>
      <input
        id={id}
        type={type}
        value={value}
        inputMode={inputMode}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? noteId : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={clsx(
          INPUT_CLASS,
          error
            ? "border-[var(--danger)]"
            : "border-[var(--border-default)] focus:border-[var(--accent)]",
        )}
      />
      {note && <Note id={noteId} error={error !== null && error !== undefined}>{note}</Note>}
    </div>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  hint,
  placeholder,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  placeholder?: string;
  rows?: number;
}) {
  const id = useId();
  const noteId = `${id}-note`;

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <textarea
        id={id}
        rows={rows}
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        aria-describedby={hint ? noteId : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={clsx(
          INPUT_CLASS,
          "h-auto resize-y py-1.5 font-mono leading-6",
          "border-[var(--border-default)] focus:border-[var(--accent)]",
        )}
      />
      {hint && <Note id={noteId}>{hint}</Note>}
    </div>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  hint?: ReactNode;
}) {
  const id = useId();
  const noteId = `${id}-note`;

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={value}
        aria-describedby={hint ? noteId : undefined}
        onChange={(event) => onChange(event.target.value as T)}
        className={clsx(INPUT_CLASS, "border-[var(--border-default)] focus:border-[var(--accent)]")}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && <Note id={noteId}>{hint}</Note>}
    </div>
  );
}

export function CheckField({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Drawn and inert, rather than left out: a setting that vanishes is one the
   * reader goes looking for, and the hint beside it is where the reason it
   * cannot be turned on is written. */
  disabled?: boolean;
}) {
  const id = useId();
  const noteId = `${id}-note`;

  return (
    <div className={clsx("flex gap-2", disabled && "opacity-[var(--disabled-opacity)]")}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? noteId : undefined}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        {hint && <Note id={noteId}>{hint}</Note>}
      </div>
    </div>
  );
}

export function Note({
  id,
  error,
  children,
}: {
  id?: string;
  error?: boolean;
  children: ReactNode;
}) {
  return (
    <p
      id={id}
      role={error ? "alert" : undefined}
      className={clsx(
        "text-[11px]",
        error ? "text-[var(--danger)]" : "text-[var(--text-muted)]",
      )}
    >
      {children}
    </p>
  );
}

export function PrimaryButton({
  children,
  disabled,
  type = "submit",
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  type?: "submit" | "button";
  onClick?: () => void;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className="h-8 rounded-[var(--radius-sm)] bg-[var(--accent)] px-3 text-[12px] font-medium text-[var(--text-inverse)] hover:bg-[var(--accent-hover)] disabled:opacity-[var(--disabled-opacity)]"
    >
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  label,
  disabled,
  onClick,
}: {
  children: ReactNode;
  /** For a button whose text repeats down a list, so each one is still named
   * by what it acts on. Must contain the visible text. */
  label?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="h-8 rounded-[var(--radius-sm)] border border-[var(--border-default)] px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-[var(--disabled-opacity)]"
    >
      {children}
    </button>
  );
}

export function LinkButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-[var(--radius-sm)] text-[12px] text-[var(--accent)] hover:text-[var(--accent-hover)] hover:underline"
    >
      {children}
    </button>
  );
}

export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-[var(--border-subtle)] pt-4">
      <h3 className="text-[10px] font-semibold tracking-[0.09em] text-[var(--text-muted)] uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}
