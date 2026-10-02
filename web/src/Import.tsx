import { useState, type FormEvent } from 'react';
import { Logo } from './App';

type Action = 'created' | 'updated' | 'unchanged' | 'failed';
interface ImportRun {
  id: string;
  sourceUrl: string;
  dryRun: boolean;
  mapping: { fields: Record<string, string>; source: 'aliases' | 'model' };
  counts: Record<Action, number>;
  rows: { row: number; sku: string | null; action: Action; errors?: string[] }[];
}

// The demo file in the public repository (see README). Any public CSV/JSON/Google Sheets link works.
const DEMO_URL =
  'https://raw.githubusercontent.com/maheenur13/ai-assesment/main/fixtures/import/products.csv';
const ACTIONS: Action[] = ['created', 'updated', 'unchanged', 'failed'];
const SHOWN_ROWS = 200;

/** Operator bulk import: paste a link, preview what would change, then import. */
export function Import() {
  const [token, setToken] = useState('');
  const [url, setUrl] = useState('');
  const [report, setReport] = useState<ImportRun>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(dryRun: boolean) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/v1/imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url, dryRun }),
      });
      const json: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const p = json as { title?: string; detail?: string };
        throw new Error([p.title ?? `HTTP ${res.status}`, p.detail].filter(Boolean).join(' · '));
      }
      setReport(json as ImportRun);
    } catch (err) {
      setReport(undefined);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function preview(e: FormEvent) {
    e.preventDefault();
    void run(true);
  }

  // Import only what was just previewed: editing the link invalidates the preview.
  const previewed = report?.dryRun === true && report.sourceUrl === url;
  const changes = report ? report.counts.created + report.counts.updated : 0;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <div>
            <div className="brand-name">BluBird</div>
            <div className="brand-sub">Catalog import</div>
          </div>
        </div>
        <div className="actions">
          <a className="ghost back" href="#">
            ← Back to shop
          </a>
        </div>
      </header>

      <main className="log">
        <div className="import-page">
          <section className="import-intro">
            <Logo large />
            <h1>Import products from a link</h1>
            <p>
              Paste a public CSV or JSON link, or a Google Sheet shared as “anyone with the link”.
              Products are matched by SKU: new ones are created, existing ones updated.
            </p>
          </section>

          <form className="panel" onSubmit={preview}>
            <label className="field">
              Operator token
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value.trim())}
                placeholder="Demo token: see the README"
                autoComplete="off"
                required
              />
            </label>
            <label className="field">
              Link to your product list
              <span className="field-row">
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value.trim())}
                  placeholder="https://docs.google.com/spreadsheets/d/…"
                  required
                />
                <button type="button" className="secondary" onClick={() => setUrl(DEMO_URL)}>
                  Use demo file
                </button>
              </span>
            </label>
            <div className="import-actions">
              <button className="secondary" disabled={busy || !token || !url}>
                {busy ? 'Working…' : '1. Preview'}
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || !previewed || changes === 0}
                onClick={() => void run(false)}
              >
                2. Import {previewed ? `${changes} product${changes === 1 ? '' : 's'}` : ''}
              </button>
            </div>
          </form>

          {error && (
            <div className="alert" role="alert">
              {error}
            </div>
          )}

          {report && (
            <section className="panel" aria-live="polite">
              <h2>
                {report.dryRun ? 'Preview — nothing has been changed yet' : 'Import finished'}
              </h2>
              <div className="stats">
                {ACTIONS.map((a) => (
                  <div key={a} className="stat">
                    <div className={`stat-value ${a}`}>{report.counts[a]}</div>
                    <div className="stat-label">
                      {report.dryRun && (a === 'created' || a === 'updated') ? `to be ${a}` : a}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mapping">
                Columns{' '}
                {report.mapping.source === 'model'
                  ? '(suggested by the model)'
                  : '(matched by name)'}
                :{' '}
                {Object.entries(report.mapping.fields).map(([field, column]) => (
                  <span key={field}>
                    {field} ← <code>{column}</code>{' '}
                  </span>
                ))}
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>SKU</th>
                      <th>Result</th>
                      <th>Problems</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.slice(0, SHOWN_ROWS).map((r) => (
                      <tr key={r.row}>
                        <td>{r.row}</td>
                        <td className="mono">{r.sku ?? '—'}</td>
                        <td className={`action ${r.action}`}>{r.action}</td>
                        <td>{r.errors?.join('; ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {report.rows.length > SHOWN_ROWS && (
                <div className="footnote">
                  Showing {SHOWN_ROWS} of {report.rows.length} rows. The full report is at
                  /api/v1/imports/{report.id}.
                </div>
              )}
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
