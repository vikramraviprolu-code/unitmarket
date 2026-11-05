'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { barState, fieldControls, hrefWith, withField, withoutChip } from '../lib/filter-bar-view';
import type { BarContext, RawMap } from '../lib/filter-bar-view';
import './ops/ops-b.css';

export interface BarPreset {
  id: string;
  label: string;
  href: string;
  current: boolean;
}

// INT-OPS-B / OPS-B.1: the shared filter bar. It paints what lib/filter-bar-view.ts returns and decides nothing:
// which fields exist for the role, how a URL becomes chips, how a chip is removed. State lives in the URL, so a
// filtered page can be bookmarked and the back button works. BUY and SEL reuse it with their own context.
export function FilterBar({
  ctx,
  raw,
  basePath,
  presets,
  label,
}: {
  ctx: BarContext;
  raw: RawMap;
  basePath: string;
  presets: readonly BarPreset[];
  label: string;
}) {
  const router = useRouter();
  const state = barState(ctx, raw);
  const controls = fieldControls(ctx);
  const [field, setField] = useState(controls[0]?.field ?? '');
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState('');
  const control = controls.find((c) => c.field === field) ?? controls[0];

  const add = (e: FormEvent): void => {
    e.preventDefault();
    const next = withField(ctx, raw, field, value);
    if (JSON.stringify(next) === JSON.stringify(state.map)) {
      setProblem(
        value.trim() === ''
          ? 'Type or choose a value first.'
          : 'That value does not fit this filter.',
      );
      return;
    }
    setProblem('');
    setValue('');
    router.push(hrefWith(basePath, next));
  };

  return (
    <section className="fb" aria-label={label} data-testid="filter-bar">
      {presets.length > 0 ? (
        <nav aria-label="Saved views">
          <ul className="fb-views">
            {presets.map((p) => (
              <li key={p.id}>
                <Link href={p.href} aria-current={p.current ? 'true' : undefined}>
                  {p.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      <ul aria-label="Active filters" data-testid="filter-chips">
        {state.chips.length === 0 ? <li className="txn-note">No filters are on.</li> : null}
        {state.chips.map((c) => (
          <li key={`${c.field}:${c.value}`} className="fb-chip">
            <span>{c.text}</span>
            <Link
              href={hrefWith(basePath, withoutChip(ctx, raw, c.field, c.value))}
              aria-label={`Remove filter ${c.text}`}
            >
              Remove
            </Link>
          </li>
        ))}
      </ul>
      <form className="fb-add" aria-label="Add a filter" onSubmit={add}>
        <div>
          <label htmlFor="fb-field">Filter by</label>
          <select
            id="fb-field"
            value={field}
            onChange={(e) => {
              setField(e.target.value);
              setValue('');
              setProblem('');
            }}
          >
            {controls.map((c) => (
              <option key={c.field} value={c.field}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="fb-value">Value</label>
          {control?.type === 'select' ? (
            <select id="fb-value" value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="">Choose</option>
              {(control.options ?? []).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="fb-value"
              type={control?.type === 'date' ? 'date' : 'text'}
              inputMode={control?.type === 'amount' ? 'decimal' : undefined}
              placeholder={control?.placeholder}
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </div>
        <button type="submit" className="btn">
          Add filter
        </button>
        {state.chips.length > 0 ? <Link href={basePath}>Clear all filters</Link> : null}
      </form>
      <p role="status" className={problem === '' ? 'visually-hidden' : 'fb-problem'}>
        {problem}
      </p>
    </section>
  );
}
