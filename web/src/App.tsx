import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

interface Money {
  amount: number;
  currency: string;
}
interface Line {
  productId: string;
  productName: string;
  quantity: number;
  lineTotal: Money;
}
interface Product {
  id: string;
  name: string;
  category: string;
  price: Money;
  stock: number;
}
interface Proposal {
  id: string;
  items: Line[];
  total: Money;
  expiresAt: string;
}
interface Order {
  id: string;
  items: Line[];
  total: Money;
}
interface ChatResponse {
  conversationId: string;
  reply: string;
  products: Product[];
  proposal?: Proposal;
  order?: Order;
}
interface Problem {
  title: string;
  detail?: string;
}

type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; res: ChatResponse }
  | { kind: 'order'; order: Order }
  | { kind: 'error'; text: string };

// The seeded demo customers (see README). Any other customer token can be pasted instead.
const DEMO_USERS = [
  { name: 'Alice', token: 'shop_demo_alice_0000000000000000000000000000000000000000' },
  { name: 'Bob', token: 'shop_demo_bob_00000000000000000000000000000000000000000000' },
  { name: 'Carol', token: 'shop_demo_carol_000000000000000000000000000000000000000000' },
];

const SUGGESTIONS = {
  anonymous: [
    'Do you have noise cancelling headphones?',
    'Show me keyboards under $100',
    'Is the Portable SSD 1TB in stock?',
    'I want to buy a Smart LED Bulb',
  ],
  customer: [
    'What did I order last?',
    'I want to buy 2 Braided USB-C Cable 2m',
    'Find me a smartwatch',
    'Show me my orders',
  ],
};

const money = (m: Money) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: m.currency }).format(
    m.amount / 100,
  );

/** `**bold**` → <strong>, everything else plain text. Model output is never parsed as HTML. */
function richText(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .map((part, i) =>
      part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : (
        part.replaceAll('**', '')
      ),
    );
}

async function api<T>(path: string, token: string, body?: object): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      ...(body && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const p = json as Partial<Problem>;
    throw new Error([p.title ?? `HTTP ${res.status}`, p.detail].filter(Boolean).join(' · '));
  }
  return json as T;
}

export function App() {
  const [token, setToken] = useState('');
  const [conversationId, setConversationId] = useState<string>();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries, busy]);

  const add = (e: Entry) => setEntries((list) => [...list, e]);
  const user = DEMO_USERS.find((u) => u.token === token);
  const who = user?.name ?? (token ? 'Custom token' : 'Guest');

  function newChat() {
    setConversationId(undefined);
    setEntries([]);
    inputRef.current?.focus();
  }

  function switchUser(next: string) {
    // Conversations are bound to the caller, so a new identity starts a new conversation.
    setToken(next);
    newChat();
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setDraft('');
    add({ kind: 'user', text: message });
    setBusy(true);
    try {
      const res = await api<ChatResponse>('/api/v1/chat', token, { conversationId, message });
      setConversationId(res.conversationId);
      add({ kind: 'assistant', res });
    } catch (err) {
      add({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  async function confirm(proposal: Proposal) {
    setBusy(true);
    try {
      // Customers are identified by their token; guests by the conversation they ordered in.
      const order = await api<Order>(
        `/api/v1/order-proposals/${proposal.id}/confirm`,
        token,
        token ? undefined : { conversationId },
      );
      setConfirmed((s) => new Set(s).add(proposal.id));
      add({ kind: 'order', order });
    } catch (err) {
      add({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <div>
            <div className="brand-name">BluBird</div>
            <div className="brand-sub">Shopping assistant</div>
          </div>
        </div>
        <div className="actions">
          <a className="ghost" href="#import" title="Operator: bulk import products">
            Import
          </a>
          <button className="ghost" onClick={newChat} disabled={entries.length === 0}>
            <PlusIcon /> New chat
          </button>
          <div className="account">
            <button
              className="account-btn"
              onClick={() => setMenuOpen((o) => !o)}
              aria-expanded={menuOpen}
            >
              <Avatar name={who} guest={!token} />
              <span className="account-name">{token ? who : 'Sign in'}</span>
              <ChevronIcon />
            </button>
            {menuOpen && (
              <div className="menu" role="menu">
                <div className="menu-label">Shop as</div>
                <MenuItem
                  active={!token}
                  onClick={() => {
                    switchUser('');
                    setMenuOpen(false);
                  }}
                  name="Guest"
                  note="Order without an account"
                  guest
                />
                {DEMO_USERS.map((u) => (
                  <MenuItem
                    key={u.name}
                    active={u.token === token}
                    onClick={() => {
                      switchUser(u.token);
                      setMenuOpen(false);
                    }}
                    name={u.name}
                    note="Demo customer"
                  />
                ))}
                <div className="menu-label">Or paste a customer token</div>
                <input
                  className="token-input"
                  type="password"
                  placeholder="shop_…"
                  value={user ? '' : token}
                  onChange={(e) => switchUser(e.target.value.trim())}
                  aria-label="Customer token"
                />
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="log" ref={logRef} aria-live="polite" onClick={() => setMenuOpen(false)}>
        <div className="log-inner">
          {entries.length === 0 && (
            <section className="welcome">
              <Logo large />
              <h1>
                {token
                  ? `Hi ${user?.name ?? 'there'}, what can I find for you?`
                  : 'How can I help you shop today?'}
              </h1>
              <p>
                {token
                  ? 'Ask about products, check your orders, or order something. I’ll always ask before placing an order.'
                  : 'Ask about products, prices and stock, or order as a guest. Sign in (top right) to see your order history.'}
              </p>
              <div className="suggestions">
                {SUGGESTIONS[token ? 'customer' : 'anonymous'].map((s) => (
                  <button key={s} className="chip" onClick={() => void send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </section>
          )}

          {entries.map((entry, i) => {
            switch (entry.kind) {
              case 'user':
                return (
                  <div key={i} className="row user">
                    <div className="bubble">{entry.text}</div>
                  </div>
                );
              case 'error':
                return (
                  <div key={i} className="row bot">
                    <BotAvatar />
                    <div className="bubble error">
                      <AlertIcon /> {entry.text}
                    </div>
                  </div>
                );
              case 'order':
                return (
                  <div key={i} className="row bot">
                    <BotAvatar />
                    <OrderCard order={entry.order} />
                  </div>
                );
              case 'assistant': {
                const { reply, products, proposal, order } = entry.res;
                const showProducts = products.length > 0 && !proposal && !order;
                return (
                  <div key={i} className="row bot">
                    <BotAvatar />
                    <div className="stack">
                      <div className="bubble">{richText(reply)}</div>
                      {showProducts && (
                        <div className="products">
                          {products.map((p) => (
                            <article key={p.id} className="product">
                              <div className="product-cat">{p.category}</div>
                              <div className="product-name">{p.name}</div>
                              <div className="product-foot">
                                <span className="price">{money(p.price)}</span>
                                <span className={`stock ${p.stock > 0 ? 'in' : 'out'}`}>
                                  {p.stock > 0 ? `${p.stock} in stock` : 'Sold out'}
                                </span>
                              </div>
                            </article>
                          ))}
                        </div>
                      )}
                      {proposal && (
                        <ProposalCard
                          proposal={proposal}
                          done={confirmed.has(proposal.id)}
                          busy={busy}
                          onConfirm={() => void confirm(proposal)}
                        />
                      )}
                      {order && <OrderCard order={order} />}
                    </div>
                  </div>
                );
              }
            }
          })}

          {busy && (
            <div className="row bot">
              <BotAvatar />
              <div className="bubble typing" aria-label="Assistant is typing">
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
        </div>
      </main>

      <footer className="composer-wrap">
        <form
          className="composer"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void send(draft);
          }}
        >
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={2000}
            placeholder={token ? 'Ask about products or your orders…' : 'Ask about our products…'}
            aria-label="Message"
            autoFocus
          />
          <button className="send" disabled={busy || !draft.trim()} aria-label="Send">
            <SendIcon />
          </button>
        </form>
        <div className="fineprint">
          Prices and stock come straight from the catalog. Orders are placed only after you confirm.
        </div>
      </footer>
    </div>
  );
}

function ProposalCard(props: {
  proposal: Proposal;
  done: boolean;
  busy: boolean;
  onConfirm: () => void;
}) {
  const { proposal, done, busy, onConfirm } = props;
  const expires = new Date(proposal.expiresAt);
  return (
    <div className="card proposal">
      <div className="card-head">
        <CartIcon />
        <div>
          <div className="card-title">Review your order</div>
          <div className="card-sub">
            Valid until {expires.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      </div>
      <Lines items={proposal.items} total={proposal.total} />
      <button className="primary" disabled={busy || done} onClick={onConfirm}>
        {done ? (
          <>
            <CheckIcon /> Order placed
          </>
        ) : (
          <>Place order · {money(proposal.total)}</>
        )}
      </button>
      {!done && <div className="card-note">Or just reply “yes” to confirm.</div>}
    </div>
  );
}

function OrderCard({ order }: { order: Order }) {
  return (
    <div className="card placed">
      <div className="card-head">
        <span className="check-badge">
          <CheckIcon />
        </span>
        <div>
          <div className="card-title">Order placed</div>
          <div className="card-sub mono">#{order.id.slice(0, 8)}</div>
        </div>
      </div>
      <Lines items={order.items} total={order.total} />
    </div>
  );
}

function Lines({ items, total }: { items: Line[]; total: Money }) {
  return (
    <div className="lines">
      {items.map((l) => (
        <div key={l.productId} className="line">
          <span className="qty">{l.quantity}×</span>
          <span className="line-name">{l.productName}</span>
          <span className="line-total">{money(l.lineTotal)}</span>
        </div>
      ))}
      <div className="line total">
        <span>Total</span>
        <span>{money(total)}</span>
      </div>
    </div>
  );
}

function MenuItem(props: {
  name: string;
  note: string;
  active: boolean;
  guest?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`menu-item ${props.active ? 'active' : ''}`}
      role="menuitem"
      onClick={props.onClick}
    >
      <Avatar name={props.name} guest={props.guest ?? false} />
      <span>
        <span className="menu-name">{props.name}</span>
        <span className="menu-note">{props.note}</span>
      </span>
      {props.active && <CheckIcon />}
    </button>
  );
}

function Avatar({ name, guest }: { name: string; guest: boolean }) {
  return <span className={`avatar ${guest ? 'guest' : ''}`}>{guest ? '?' : name[0]}</span>;
}

const BotAvatar = () => (
  <span className="bot-avatar" aria-hidden>
    <Logo />
  </span>
);

/* Inline icons (no icon font or CDN, so the strict CSP stays intact). */
const Icon = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d={d} />
  </svg>
);
const SendIcon = () => <Icon d="M5 12h14M13 6l6 6-6 6" size={18} />;
const PlusIcon = () => <Icon d="M12 5v14M5 12h14" />;
const ChevronIcon = () => <Icon d="M6 9l6 6 6-6" size={14} />;
const CheckIcon = () => <Icon d="M5 12l5 5L20 7" />;
const AlertIcon = () => (
  <Icon d="M12 8v5M12 16.5v.01M10.3 3.9L2 18a2 2 0 001.7 3h16.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
);
const CartIcon = () => (
  <span className="cart-badge">
    <Icon d="M3 4h2l2.4 11.2a2 2 0 002 1.6h7.7a2 2 0 002-1.5L21 8H6M9 21h.01M18 21h.01" />
  </span>
);

export function Logo({ large = false }: { large?: boolean }) {
  return (
    <svg className={large ? 'logo large' : 'logo'} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="bb" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#38bdf8" />
          <stop offset="1" stopColor="#4f46e5" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#bb)" />
      <path
        d="M8 19c3.5 0 5-2.5 6.5-5.5S18 9 22 9c1.6 0 2.6.8 3 1.8l-2.3.7c.2 3.9-2.6 9.5-9.7 9.5H8z"
        fill="#fff"
      />
      <circle cx="21.3" cy="11.6" r="0.9" fill="#4f46e5" />
    </svg>
  );
}
