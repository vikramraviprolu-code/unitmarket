'use client';
import type { ReactNode } from 'react';
import './pk-forms.css';

// Small pieces the three publisher forms share (PUB-UI-FORMS). Each field keeps its own label, id and name;
// the help line sits under the field in muted text, and an answer from the route sits beside the field it is
// about, as text with role alert, tied to the field by aria-describedby.

/** The words of one problem beside its field. The element has an id so a field can point to it. */
export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="pk-field-error" role="alert">
      {children}
    </p>
  );
}

/** One text field: label, help under it, the problem beside it. The input is drawn by the caller. */
export function Field({
  id,
  label,
  help,
  error,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  error?: string | null;
  children: (a: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': boolean;
  }) => ReactNode;
}) {
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [help ? helpId : '', error ? errorId : ''].filter((x) => x !== '').join(' ');
  return (
    <div className="field pk-field">
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        'aria-describedby': describedBy === '' ? undefined : describedBy,
        'aria-invalid': Boolean(error),
      })}
      {help ? (
        <p id={helpId} className="pk-help">
          {help}
        </p>
      ) : null}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}

export interface OptionRowData {
  option: string;
  offeredLabel: string;
  priceLabel: string;
  optionName: string;
}

/** The option rows shared by the create and the change forms: a tick, a price with its currency in front. */
export function OptionRows({
  rows,
  offered,
  prices,
  onOffered,
  onPrice,
  prefix,
  rangeHelp,
  help,
  bad,
  error,
  optionsError,
}: {
  rows: OptionRowData[];
  offered: Record<string, boolean>;
  prices: Record<string, string>;
  onOffered: (option: string, on: boolean) => void;
  onPrice: (option: string, text: string) => void;
  /** The three letter code shown in front of each price. */
  prefix: string;
  rangeHelp: string;
  help: (option: string) => string;
  /** The options whose typed price was refused. */
  bad: string[];
  /** The problem with the prices as a whole, shown under the rows. */
  error: string | null;
  optionsError: string | null;
}) {
  return (
    <>
      {rows.map((r) => {
        const on = offered[r.option] === true;
        const hintId = `price-hint-${r.option}`;
        const helpId = `offered-help-${r.option}`;
        const refused = bad.includes(r.option);
        const tickDescribedBy = [
          help(r.option) === '' ? '' : helpId,
          optionsError === null ? '' : 'options-error',
        ]
          .filter((x) => x !== '')
          .join(' ');
        const describedBy = [hintId, error !== null && refused ? 'price-error' : '']
          .filter((x) => x !== '')
          .join(' ');
        return (
          <fieldset key={r.option} className="pk-option">
            <legend className="visually-hidden">{r.optionName}</legend>
            <label className="check">
              <input
                type="checkbox"
                checked={on}
                aria-describedby={tickDescribedBy === '' ? undefined : tickDescribedBy}
                aria-invalid={optionsError !== null}
                onChange={(e) => onOffered(r.option, e.target.checked)}
              />
              <span>{r.offeredLabel}</span>
            </label>
            {help(r.option) === '' ? null : (
              <p id={helpId} className="pk-help pk-help-indent">
                {help(r.option)}
              </p>
            )}
            <div className="field pk-field">
              <label htmlFor={`price-${r.option}`}>{r.priceLabel}</label>
              <div className="pk-money">
                <span className="pk-money-prefix" aria-hidden="true">
                  {prefix}
                </span>
                <input
                  id={`price-${r.option}`}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  aria-describedby={describedBy}
                  aria-invalid={refused}
                  disabled={!on}
                  value={prices[r.option] ?? ''}
                  onChange={(e) => onPrice(r.option, e.target.value)}
                />
              </div>
              <p id={hintId} className="pk-help">
                {rangeHelp}
              </p>
            </div>
          </fieldset>
        );
      })}
      {error ? <FieldError id="price-error">{error}</FieldError> : null}
      {optionsError ? <FieldError id="options-error">{optionsError}</FieldError> : null}
    </>
  );
}

/** The rights tick, with its help line and its problem. The label text is the pinned sentence. */
export function AttestBox({
  label,
  help,
  checked,
  onChange,
  error,
}: {
  label: string;
  help: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  error: string | null;
}) {
  const describedBy = ['attest-help', error ? 'attest-error' : '']
    .filter((x) => x !== '')
    .join(' ');
  return (
    <div className="pk-field">
      <label className="check">
        <input
          type="checkbox"
          checked={checked}
          aria-describedby={describedBy}
          aria-invalid={Boolean(error)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{label}</span>
      </label>
      <p id="attest-help" className="pk-help pk-help-indent">
        {help}
      </p>
      {error ? <FieldError id="attest-error">{error}</FieldError> : null}
    </div>
  );
}
