/**
 * Server-rendered admin views.
 *
 * Deliberately NOT a React SPA: that would mean a second build pipeline, a second
 * deploy artefact, CORS, and its own auth dance — for a handful of internal
 * screens used by two or three people. Plain HTML has none of that and cannot
 * drift from the API's own types, because it reads the same Prisma models.
 */

/** Escape every interpolated value. The admin surface renders user-supplied text. */
export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function inr(paise: bigint | number | null | undefined): string {
  if (paise === null || paise === undefined) return '—'
  const n = typeof paise === 'bigint' ? paise : BigInt(Math.round(paise))
  const neg = n < 0n
  const abs = neg ? -n : n
  const whole = (abs / 100n).toString()
  const frac = (abs % 100n).toString().padStart(2, '0')
  const grouped =
    whole.length <= 3
      ? whole
      : whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + whole.slice(-3)
  return `${neg ? '-' : ''}₹${grouped}.${frac}`
}

export function when(d: Date | null | undefined): string {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
}

const CSS = `
:root{--bg:#0F172A;--deep:#0A101F;--surf:#1E293B;--hi:#334155;--line:#334155;
--tx:#E2E8F0;--dim:#94A3B8;--acc:#38BDF8;--ok:#34D399;--warn:#FBBF24;--bad:#F87171}
@media(prefers-color-scheme:light){:root{--bg:#F6F7FB;--deep:#E8ECF5;--surf:#fff;--hi:#F1F5F9;
--line:#E2E8F0;--tx:#0F172A;--dim:#64748B;--acc:#0284C7;--ok:#059669;--warn:#B45309;--bad:#DC2626}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
header{background:var(--deep);border-bottom:1px solid var(--line);padding:.7rem 1.25rem;
display:flex;gap:1.25rem;align-items:center;position:sticky;top:0;z-index:10;flex-wrap:wrap}
header .brand{font-weight:700;letter-spacing:-.02em}
header nav{display:flex;gap:1rem;flex-wrap:wrap}
header .spacer{margin-left:auto}
main{max-width:1180px;margin:0 auto;padding:1.5rem 1.25rem 4rem}
h1{font-size:1.35rem;margin:.2rem 0 1.1rem;letter-spacing:-.02em}
h2{font-size:1.05rem;margin:1.8rem 0 .7rem;letter-spacing:-.01em}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:.85rem;margin-bottom:1.4rem}
.card{background:var(--surf);border:1px solid var(--line);border-radius:12px;padding:.95rem 1.05rem}
.card .k{color:var(--dim);font-size:.74rem;text-transform:uppercase;letter-spacing:.06em}
.card .v{font-size:1.5rem;font-weight:650;margin-top:.3rem;letter-spacing:-.02em}
.card .s{color:var(--dim);font-size:.78rem;margin-top:.2rem}
table{width:100%;border-collapse:collapse;background:var(--surf);border:1px solid var(--line);
border-radius:12px;overflow:hidden}
th,td{padding:.6rem .8rem;text-align:left;border-bottom:1px solid var(--line);vertical-align:middle}
th{background:var(--hi);font-size:.74rem;text-transform:uppercase;letter-spacing:.05em;color:var(--dim)}
tr:last-child td{border-bottom:none}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.tag{display:inline-block;padding:.12rem .5rem;border-radius:999px;font-size:.72rem;border:1px solid var(--line)}
.tag.ok{color:var(--ok);border-color:var(--ok)}
.tag.warn{color:var(--warn);border-color:var(--warn)}
.tag.bad{color:var(--bad);border-color:var(--bad)}
button,.btn{background:var(--acc);color:#04121d;border:0;border-radius:8px;padding:.42rem .8rem;
font-weight:600;font-size:.82rem;cursor:pointer}
button.ghost{background:transparent;color:var(--tx);border:1px solid var(--line)}
button:hover{opacity:.9}
form.inline{display:inline}
input,select{background:var(--bg);color:var(--tx);border:1px solid var(--line);
border-radius:8px;padding:.45rem .6rem;font:inherit}
.login{max-width:360px;margin:12vh auto;background:var(--surf);border:1px solid var(--line);
border-radius:14px;padding:1.6rem}
.login input{width:100%;margin-bottom:.7rem}
.login button{width:100%}
.err{color:var(--bad);margin-bottom:.7rem;font-size:.85rem}
.note{color:var(--dim);font-size:.82rem;margin:.5rem 0 1rem}
code{background:var(--hi);padding:.1rem .35rem;border-radius:5px;font-size:.85em}
.empty{color:var(--dim);padding:1.4rem;text-align:center}
`

export function layout(title: string, activeNav: string, body: string): string {
  const nav = [
    ['/admin', 'Overview'],
    ['/admin/users', 'Users'],
    ['/admin/rules', 'Advisor rules'],
    ['/admin/flags', 'Feature flags'],
    ['/admin/system', 'System'],
    ['/admin/account', 'Account'],
  ]
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · FinCalc Admin</title><style>${CSS}</style></head><body>
<header>
  <span class="brand">FinCalc <span style="color:var(--dim);font-weight:400">Admin</span></span>
  <nav>${nav
    .map(([href, label]) =>
      `<a href="${href}"${activeNav === href ? ' style="font-weight:650;text-decoration:underline"' : ''}>${label}</a>`,
    )
    .join('')}</nav>
  <span class="spacer"></span>
  <form class="inline" method="post" action="/admin/logout">
    <button class="ghost" type="submit">Sign out</button>
  </form>
</header>
<main>${body}</main></body></html>`
}

export function loginPage(error?: string): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>FinCalc Admin</title><style>${CSS}</style></head><body>
<form class="login" method="post" action="/admin/login">
  <h1 style="margin-top:0">FinCalc Admin</h1>
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
  <input name="email" type="email" placeholder="Email" required autofocus autocomplete="username">
  <input name="password" type="password" placeholder="Password" required autocomplete="current-password">
  <button type="submit">Sign in</button>
  <p class="note" style="margin-bottom:0">Only accounts listed in <code>ADMIN_EMAILS</code> may sign in.</p>
</form></body></html>`
}

/**
 * Change your own password.
 *
 * The only way to change an admin password now that scripts/reset-admin.ts is
 * gone. It requires the current password, so a session left open on an
 * unattended machine cannot be turned into a permanent takeover.
 */
export function accountPage(
  session: { email: string; csrf: string },
  error?: string,
  notice?: string,
): string {
  return layout('Account', '/admin/account', `
    <h1>Account</h1>
    <p class="note">Signed in as <code>${esc(session.email)}</code>.</p>

    <h2>Change password</h2>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    ${notice ? `<div class="note" style="color:var(--ok)">${esc(notice)}</div>` : ''}
    <form method="post" action="/admin/account/password" style="max-width:380px">
      <input type="hidden" name="_csrf" value="${esc(session.csrf)}">
      <input name="current" type="password" required placeholder="Current password"
             autocomplete="current-password" style="width:100%;margin-bottom:.7rem">
      <input name="next" type="password" required minlength="10" placeholder="New password"
             autocomplete="new-password" style="width:100%;margin-bottom:.7rem">
      <input name="confirm" type="password" required minlength="10" placeholder="Confirm new password"
             autocomplete="new-password" style="width:100%;margin-bottom:.7rem">
      <button type="submit">Change password</button>
    </form>
    <p class="note">At least 10 characters. Changing it signs out every admin session,
    including this one, and revokes the account's app refresh tokens — so if someone else
    had access, they lose it immediately. You will be asked to sign in again.</p>`)
}

export function card(k: string, v: string, s = ''): string {
  return `<div class="card"><div class="k">${esc(k)}</div><div class="v">${v}</div>${
    s ? `<div class="s">${s}</div>` : ''
  }</div>`
}

export function table(headers: string[], rows: string[]): string {
  if (!rows.length) return `<table><tr><td class="empty">Nothing here yet.</td></tr></table>`
  return `<table><thead><tr>${headers
    .map((h) => `<th${h.startsWith('#') ? ' class="num"' : ''}>${esc(h.replace(/^#/, ''))}</th>`)
    .join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
}
