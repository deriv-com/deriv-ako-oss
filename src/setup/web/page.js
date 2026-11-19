// The browser setup page. One self-contained document: its script and styles
// carry the per-request nonce the Content-Security-Policy allows, and every
// string from the setup is inserted as text, never as HTML.
//
// The terminal setup is a transcript; this page is a control room. A band at
// the top shows the setup as a pipeline of parts, ticked off as they pass. The
// main column asks one question at a time, with what the question needs to
// know (the notes since the last answer) in the card, and keeps a log of
// everything AKO did below it. Beside it, release-flow.yaml as AKO last saved
// it, with what changed marked. The setup reports which part is running (see
// `runSteps`), so going back to an earlier part moves the pipeline back too.

export function setupPageHtml({ nonce, title }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">${STYLES}</style>
<script nonce="${nonce}">try { const theme = localStorage.getItem("ako-theme"); if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme; } catch {}</script>
</head>
<body>
<div class="shell">
  <div class="band">
    <header class="top">
      <p class="brand"><span class="logo" aria-hidden="true">AKO</span><span>Deriv AKO</span><span class="slash" aria-hidden="true">/</span><span class="crumb">release setup</span></p>
      <div class="top-right">
        <p class="status" id="status" data-state="connecting" role="status"><span class="dot" aria-hidden="true"></span><strong id="status-text">Connecting</strong><span class="status-detail" id="status-detail">to the setup…</span></p>
        <button type="button" class="theme" id="theme" aria-label="Switch to dark mode">${THEME_ICONS}</button>
      </div>
    </header>
    <section class="pipeline" aria-label="Setup progress">
      <p class="where" id="where">Pipeline · starting</p>
      <ol class="steps" id="steps"></ol>
    </section>
  </div>
  <div class="body">
    <main class="main">
      <section class="card" id="card" aria-live="polite"><p class="muted">Loading…</p></section>
      <section class="log" id="log" aria-label="What AKO did so far"></section>
    </main>
    <aside class="file" aria-label="release-flow.yaml as AKO last saved it">
      <div class="file-head">
        <span class="file-name">${FILE_ICON}release-flow.yaml</span>
        <span class="badge" id="file-badge">LIVE</span>
      </div>
      <div class="file-lines" id="file-lines"></div>
      <p class="file-foot">Secrets go in <code>.env</code>, never here.</p>
    </aside>
  </div>
  <footer class="foot">AKO serves this page from your computer and stops it when the setup ends. Your answers go into <code>.env</code> and <code>release-flow.yaml</code> in the folder you ran it from.</footer>
</div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

// The toggle shows the mode it switches to: a moon in light mode, a sun in dark.
const THEME_ICONS = `<svg class="icon-moon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg><svg class="icon-sun" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;

const FILE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>`;

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Dark mode: a maroon band over a navy slate, so the band stands apart from
// the page. Small text takes a light rose from the maroon, which stays
// readable on navy where maroon itself wouldn't. It follows the system until the toggle picks one (data-theme).
const DARK = `
  --ground: #1b2029; --surface: #222833; --option: #1e242e; --rule: #2f3643; --rule-strong: #3d4554;
  --ink: #eef1f5; --muted: #a8b0bd; --faint: #808a99;
  --accent: #f28a98; --accent-hover: #f8b0ba; --fill: #8e1a2e; --fill-hover: #a3223a; --on-fill: #ffffff;
  --tint: rgba(242, 138, 152, .10); --line: rgba(242, 138, 152, .5);
  --warn: #f0c062; --warn-tint: rgba(240, 192, 98, .12); --bad: #ff8b97; --bad-tint: rgba(242, 138, 152, .12); --code: #262d39;
  color-scheme: dark;
`;

// Only system fonts: the page loads nothing from anywhere else, so the
// design's typefaces are used where they're installed.
const STYLES = `
:root {
  --band: #6b1020; --band-muted: #f3d6dc; --signal: #ffffff;
  --ground: #f1f3f7; --surface: #ffffff; --option: #ffffff; --rule: #dce1e9; --rule-strong: #c4cbd7;
  --ink: #1a1f28; --muted: #556072; --faint: #737d8e;
  --accent: #8e1a2e; --accent-hover: #6b1020; --fill: #7a1325; --fill-hover: #5e0e1c; --on-fill: #ffffff;
  --tint: rgba(122, 19, 37, .06); --line: rgba(122, 19, 37, .4);
  --warn: #8a5a00; --warn-tint: #fbf1dc; --bad: #a50f25; --bad-tint: #fdecee; --code: #eef1f5;
  --font: "Space Grotesk", "Avenir Next", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme=light]) {${DARK}}
  :root:not([data-theme=light]) .theme .icon-sun { display: block; }
  :root:not([data-theme=light]) .theme .icon-moon { display: none; }
}
:root[data-theme=dark] {${DARK}}
:root[data-theme=dark] .theme .icon-sun { display: block; }
:root[data-theme=dark] .theme .icon-moon { display: none; }
/* Switching modes cross-fades instead of flashing. */
.theming, .theming * { transition: background-color .3s, color .3s, border-color .3s, box-shadow .3s !important; }
* { box-sizing: border-box; }
html, body { background: var(--ground); }
body { margin: 0; color: var(--ink); font: 15px/1.5 var(--font); -webkit-font-smoothing: antialiased; }
.shell { min-height: 100vh; display: flex; flex-direction: column; }
code { font: .9em var(--mono); background: var(--code); padding: 1px 6px; border-radius: 5px; overflow-wrap: anywhere; }
a { color: var(--accent); text-underline-offset: 3px; }
a:hover { color: var(--accent-hover); }
[hidden] { display: none !important; }

/* The band: who's running, the connection, and the pipeline. */
.band { background: var(--band); color: #ffffff; }
.band a { color: #ffffff; }
.top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 24px; padding: 16px 32px; border-bottom: 1px solid rgba(255, 255, 255, .18); }
.brand { margin: 0; display: flex; align-items: center; gap: 12px; font-weight: 600; font-size: 17px; }
.logo { display: grid; place-items: center; width: 34px; height: 30px; border-radius: 6px; background: #ffffff; color: var(--band); font: 600 12px/1 var(--mono); }
.slash { color: var(--band-muted); font-weight: 400; }
.crumb { font: 400 13px/1 var(--mono); color: var(--band-muted); }
.top-right { display: flex; align-items: center; gap: 12px; }
.status { margin: 0; display: flex; align-items: center; gap: 8px; padding: 6px 14px; border: 1px solid rgba(255, 255, 255, .35); border-radius: 999px; font-size: 13px; color: var(--band-muted); }
.status strong { color: #ffffff; font-weight: 600; }
.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--band-muted); box-shadow: 0 0 0 3px rgba(255, 255, 255, .18); }
.status[data-state=on] .dot { background: var(--signal); }
.status[data-state=off] .dot { background: #ffd166; }
.status[data-state=connecting] .dot { animation: blink 1s ease-in-out infinite; }
.theme { flex: none; display: grid; place-items: center; width: 44px; height: 44px; min-height: 0; padding: 0; border-radius: 10px; border: 1px solid rgba(255, 255, 255, .4); background: transparent; color: #ffffff; }
.theme:hover { border-color: #ffffff; background: rgba(255, 255, 255, .12); }
.theme:focus-visible { outline-color: #ffffff; }
.theme .icon-sun { display: none; }
.theme.spin svg { animation: turn .45s cubic-bezier(.3, 1.4, .5, 1); }

.pipeline { display: flex; flex-direction: column; gap: 18px; padding: 26px 32px 30px; }
.where { margin: 0; font: 400 12px/1.4 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--band-muted); }
.where-name { display: none; }
.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 20px 0; }
.step { flex: 1 1 170px; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.track { display: flex; align-items: center; }
.mark { position: relative; flex: none; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; border: 2px dashed rgba(255, 255, 255, .55); }
.wire { flex: 1; height: 0; border-top: 2px dashed rgba(255, 255, 255, .45); }
.label { padding-right: 20px; }
.step-name { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.3; color: var(--band-muted); }
.step-sub { margin: 2px 0 0; font: 400 12px/1.4 var(--mono); color: var(--band-muted); overflow-wrap: anywhere; }
.step.done .mark, .step.stopped .mark { border: 0; background: #ffffff; }
.step.done .mark::after { content: ""; width: 5px; height: 10px; margin-top: -3px; border: solid var(--band); border-width: 0 3px 3px 0; transform: rotate(45deg); }
.step.stopped .mark::after { content: "✕"; color: var(--band); font-weight: 800; font-size: 12px; }
.step.done .wire, .step.stopped .wire { border-top-style: solid; border-top-color: #ffffff; }
.step.done .step-name, .step.stopped .step-name { color: #ffffff; }
.step.now .mark { border: 2.5px solid #ffffff; box-shadow: 0 0 0 6px rgba(255, 255, 255, .2); }
.step.now .mark::after { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #ffffff; }
.step.now .step-name { color: #ffffff; font-weight: 700; }
.step.now .step-sub { color: #ffffff; font-weight: 600; }
.step.skipped .mark { opacity: .55; }
.step.skipped .step-name { opacity: .7; }
.step.just-done .mark { animation: pop .45s cubic-bezier(.3, 1.6, .5, 1) both; }
.step.check { flex: 1 1 150px; }
.step.check .mark { border-radius: 5px; border-style: solid; }
.step.check .step-name { font: 500 14px/1.3 var(--mono); color: #ffffff; }
.step.check.next .mark { border-color: #ffffff; background: #ffffff; box-shadow: 0 0 0 6px rgba(255, 255, 255, .2); }
.step.check.next .step-sub { color: #ffffff; font-weight: 600; }

/* The body: the question and the log, beside the flow file. */
.body { flex: 1; width: 100%; max-width: 1440px; margin: 0 auto; display: flex; flex-wrap: wrap; align-items: flex-start; gap: 24px; padding: 28px 32px 32px; }
.main { flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
.card { display: flex; flex-direction: column; gap: 24px; padding: 32px; border-radius: 14px; border: 1px solid var(--rule); background: var(--surface); }
.q-head { display: flex; flex-direction: column; gap: 10px; }
.eyebrow { margin: 0; font: 400 12px/1.4 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--accent); overflow-wrap: anywhere; }
.q-label { margin: 0; font-size: 42px; line-height: 1.1; font-weight: 600; letter-spacing: -.01em; text-wrap: balance; overflow-wrap: anywhere; }
.q-label code { font-size: .5em; vertical-align: .25em; }
.card.forward { animation: from-right .28s cubic-bezier(.2, .8, .2, 1) both; }
.card.back { animation: from-left .28s cubic-bezier(.2, .8, .2, 1) both; }
.muted { margin: 0; color: var(--muted); }

/* What the question needs to know: AKO's notes since the last answer. */
.brief { display: flex; flex-direction: column; gap: 10px; }
.brief:empty { display: none; }
.lead { margin: 0; font-size: 16px; color: var(--muted); overflow-wrap: anywhere; }
.sub { margin: 4px 0 0; font-size: 16px; font-weight: 600; }
.item { position: relative; margin: 0; padding-left: 18px; overflow-wrap: anywhere; }
.item::before { content: "–"; position: absolute; left: 0; color: var(--accent); }
.done-line { margin: 0; display: flex; gap: 10px; overflow-wrap: anywhere; }
.done-line::before { content: "✓"; flex: none; color: var(--accent); font-weight: 700; }
.callout { margin: 0; display: flex; gap: 10px; padding: 12px 14px; border-radius: 10px; overflow-wrap: anywhere; }
.callout::before { flex: none; font: 700 13px/1.6 var(--mono); }
.callout.warn { background: var(--warn-tint); color: var(--warn); }
.callout.warn::before { content: "!"; }
.callout.error { background: var(--bad-tint); color: var(--bad); }
.callout.error::before { content: "✗"; }
.link-note { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 12px 14px; border: 1px dashed var(--rule-strong); border-radius: 10px; color: var(--muted); }
.link-note a { font-weight: 600; }
.fresh { animation: arrive .35s cubic-bezier(.2, .8, .2, 1) both; }

form { display: flex; flex-direction: column; gap: 20px; }
input[type=text], input[type=password], input[type=search] {
  width: 100%; font: inherit; font-size: 17px; padding: 12px 16px; border-radius: 10px;
  border: 1.5px solid var(--rule-strong); background: var(--option); color: var(--ink);
}
input[type=search] { font-size: 15px; padding: 10px 14px; }
input::placeholder { color: var(--faint); }
input[type=text]:focus, input[type=password]:focus, input[type=search]:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 4px var(--tint); }
input[aria-invalid=true] { border-color: var(--bad); }
.field { display: flex; gap: 10px; }
.field input { flex: 1; min-width: 0; }
.options { display: flex; flex-direction: column; gap: 10px; max-height: 440px; overflow-y: auto; padding: 4px; margin: -4px; }
.options.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); }
.option { display: flex; align-items: flex-start; gap: 14px; padding: 16px 18px; border-radius: 12px; border: 1.5px solid var(--rule); background: var(--option); cursor: pointer; transition: border-color .15s, background-color .15s, transform .1s; }
.option:hover { border-color: var(--rule-strong); }
.option:active { transform: scale(.99); }
.option:has(input:checked) { border-color: var(--accent); background: var(--tint); }
.option input { flex: none; width: 18px; height: 18px; margin: 3px 0 0; accent-color: var(--accent); }
.option input:focus-visible { outline: none; }
.option:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 3px; }
.option-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; overflow-wrap: anywhere; }
.option-title { font-size: 17px; font-weight: 600; line-height: 1.35; }
.option-desc { color: var(--muted); }
.tag { margin-left: 8px; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--accent); font: 500 11px/1.4 var(--mono); letter-spacing: .04em; vertical-align: .15em; white-space: nowrap; }

.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
button { display: inline-flex; align-items: center; gap: 10px; min-height: 46px; padding: 0 22px; border-radius: 10px; border: 1px solid var(--rule-strong); background: transparent; color: var(--ink); font: 600 16px/1 var(--font); cursor: pointer; transition: transform .1s, background-color .15s, border-color .15s, color .15s; }
button:hover { border-color: var(--muted); }
button:active { transform: scale(.97); }
button.primary { padding: 0 24px; background: var(--fill); border-color: var(--fill); color: var(--on-fill); }
button.primary:hover { background: var(--fill-hover); border-color: var(--fill-hover); }
button.back { margin-left: auto; padding: 0 14px; border-color: transparent; color: var(--muted); font-weight: 500; }
button.back:hover { color: var(--ink); border-color: transparent; }
button.small { min-height: 38px; padding: 0 16px; font-size: 14px; }
button:disabled { opacity: .55; cursor: wait; }
button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
kbd { flex: none; font: 500 12px/1 var(--mono); padding: 4px 7px; border-radius: 5px; border: 1px solid var(--rule-strong); color: var(--muted); }
button.primary kbd { padding: 3px 6px; border-color: currentColor; color: inherit; opacity: .75; }

.working { display: flex; flex-direction: column; gap: 14px; }
.bar { position: relative; width: min(320px, 100%); height: 4px; border-radius: 4px; overflow: hidden; background: var(--tint); }
.bar::after { content: ""; position: absolute; inset: 0; width: 40%; border-radius: inherit; background: var(--accent); animation: slide 1.1s ease-in-out infinite; }

/* The log: everything AKO did, newest last. */
.log { display: flex; flex-direction: column; gap: 8px; max-height: 300px; overflow-y: auto; padding: 16px 20px; border-radius: 14px; border: 1px solid var(--rule); font: 13px/1.5 var(--mono); }
.log:empty { display: none; }
.log-line { margin: 0; display: flex; gap: 12px; }
.log-step { flex: none; width: 72px; color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-mark { flex: none; width: 1ch; text-align: center; }
.log-text { min-width: 0; overflow-wrap: anywhere; }
.log-line[data-kind=text] .log-mark, .log-line[data-kind=link] .log-mark { color: var(--accent); }
.log-line[data-kind=text] .log-text, .log-line[data-kind=item] .log-text { color: var(--muted); }
.log-line[data-kind=warn] .log-mark, .log-line[data-kind=warn] .log-text { color: var(--warn); }
.log-line[data-kind=error] .log-mark, .log-line[data-kind=error] .log-text { color: var(--bad); }
.log-line[data-kind=sub] .log-text { font-weight: 600; }
.log code { background: none; padding: 0; font-size: 1em; color: var(--ink); }

/* The flow file, as AKO last saved it. */
.file { flex: 1 1 360px; min-width: 0; position: sticky; top: 24px; display: flex; flex-direction: column; max-height: calc(100vh - 48px); border-radius: 14px; border: 1px solid var(--rule); background: var(--surface); overflow: hidden; }
.file-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--rule); }
.file-name { display: flex; align-items: center; gap: 10px; font: 13px/1.4 var(--mono); }
.file-name svg { color: var(--muted); }
.badge { padding: 3px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--accent); font: 600 11px/1.2 var(--mono); letter-spacing: .08em; }
.file-lines { flex: 1; min-height: 120px; overflow: auto; padding: 14px 0; font: 13px/1.8 var(--mono); }
/* Long lines wrap rather than run past the panel; the indentation stays. */
.file-line { display: grid; grid-template-columns: 44px minmax(0, 1fr); }
.file-line > span:last-child { white-space: pre-wrap; overflow-wrap: anywhere; }
.file-line .ln { padding-right: 16px; text-align: right; color: var(--faint); user-select: none; }
.file-line.changed { background: var(--tint); }
.file-line.changed .ln { color: var(--accent); }
.file-line .k { color: var(--muted); }
.file-line .c { color: var(--faint); }
.file-empty { margin: 0; padding: 0 18px; font: 14px/1.5 var(--font); color: var(--muted); white-space: normal; }
.file-foot { margin: 0; padding: 12px 18px; border-top: 1px solid var(--rule); font-size: 13px; color: var(--muted); }
.file-foot code, .foot code { background: none; padding: 0; color: var(--ink); }

.foot { width: 100%; max-width: 1440px; margin: 0 auto; padding: 0 32px 28px; font-size: 13px; color: var(--muted); }

/* The end: one stamp, what was saved, and what to run next. */
.finale { display: flex; flex-direction: column; gap: 20px; align-items: flex-start; }
.finale > * { max-width: 100%; }
.stamp { position: relative; display: grid; place-items: center; width: 72px; height: 72px; border-radius: 50%; background: var(--fill); animation: stamp .55s cubic-bezier(.3, 1.5, .5, 1) both; }
.stamp::after { content: ""; width: 14px; height: 28px; margin-top: -8px; border: solid var(--on-fill); border-width: 0 6px 6px 0; transform: rotate(45deg); }
.stamp.alert::after, .stamp.stopped::after { width: auto; height: auto; margin: 0; border: 0; transform: none; color: var(--on-fill); font: 700 34px/1 var(--font); }
.stamp.alert::after { content: "!"; }
.stamp.stopped::after { content: "✕"; font-size: 28px; }
.finale h2 { margin: 0; font-size: 38px; line-height: 1.1; font-weight: 600; letter-spacing: -.01em; }
.finale h3 { margin: 4px 0 0; font-size: 17px; font-weight: 600; }
.finale .list { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.finale .list:empty { display: none; }
.command { display: flex; align-items: center; gap: 14px; padding: 6px 6px 6px 18px; border-radius: 12px; border: 1px solid var(--rule); background: var(--option); }
.command code { padding: 0; background: none; font-size: 15px; }

@keyframes pop { from { transform: scale(.4); } }
@keyframes turn { from { transform: rotate(-90deg) scale(.6); } }
@keyframes blink { 50% { opacity: .3; } }
@keyframes arrive { from { opacity: 0; transform: translateY(6px); } }
@keyframes from-right { from { opacity: 0; transform: translateX(24px); } }
@keyframes from-left { from { opacity: 0; transform: translateX(-24px); } }
@keyframes stamp { from { opacity: 0; transform: scale(1.8) rotate(-12deg); } }
@keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(250%); } }

/* On a phone the pipeline is a row of marks, and the part's name sits above it. */
@media (max-width: 720px) {
  .top { padding: 12px 16px; }
  .crumb, .slash, .status-detail { display: none; }
  .pipeline { padding: 16px 16px 20px; gap: 14px; }
  .where-name { display: inline; }
  .steps { flex-wrap: nowrap; }
  .step { flex: 1 1 0; }
  .step .label, .step.check { display: none; }
  .step.final { flex: none; }
  .step.final .wire { display: none; }
  .body { padding: 16px; gap: 16px; }
  .card { padding: 22px 18px; gap: 20px; }
  .q-label { font-size: 28px; }
  .finale h2 { font-size: 30px; }
  .log { padding: 14px 16px; }
  .log-step { width: 58px; }
  .file { position: static; max-height: none; }
  .file-lines { max-height: 360px; }
  .foot { padding: 0 16px 24px; }
}
@media (hover: none) { .option kbd, button kbd { display: none; } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;

const SCRIPT = `
(() => {
  const token = new URLSearchParams(location.search).get("token") || "";
  const $ = (id) => document.getElementById(id);
  const card = $("card");
  const log = $("log");
  const stepList = $("steps");
  const where = $("where");
  const status = $("status");
  const fileLines = $("file-lines");
  const fileBadge = $("file-badge");
  let current = null;
  let renderedAt = 0;
  let finished = false;
  let direction = "forward";
  // Animations wait until the replay that follows each connection is over.
  let settled = false;

  // The setup's parts, once it sends them, and which one is running: -1
  // before the first, steps.length after the last. Without a plan (a setup
  // run that names no parts), each heading starts a part.
  let plan = null;
  let steps = [];
  let at = -1;
  const intro = [];
  const closing = [];
  // What AKO said since the last answer: the card shows it with the next question.
  let fresh = [];
  let brief = null;
  let eyebrow = null;
  let fileText = null;

  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
  };

  // Turns URLs in setup text into links and \`code\` into code. Everything else stays text.
  const withLinks = (text) => {
    const parts = String(text).split(/(https?:\\/\\/[^\\s]+|\`[^\`]+\`)/g);
    return parts.filter(Boolean).map((part) => {
      if (/^https?:\\/\\//.test(part)) {
        return el("a", { href: part, target: "_blank", rel: "noreferrer noopener", text: part.length > 80 ? part.slice(0, 77) + "…" : part });
      }
      if (/^\`[^\`]+\`$/.test(part)) return el("code", { text: part.slice(1, -1) });
      return document.createTextNode(part);
    });
  };

  // "AI (optional)" is the part "AI", with "optional" as a hint.
  const split = (label) => {
    const match = /^(.*\\S)\\s+\\(([^()]+)\\)$/.exec(label);
    return match ? [match[1], match[2]] : [label, ""];
  };

  // "Direct release: no QA step…" reads as a title and a description, and
  // "Create a new app (recommended)" as a title with a tag.
  const optionText = (label) => {
    const named = /^([^:]{2,32}):\\s+(.+)$/.exec(label);
    if (named) return [el("span", { class: "option-title", text: named[1] }), el("span", { class: "option-desc", text: named[2].charAt(0).toUpperCase() + named[2].slice(1) })];
    const [text, hint] = split(label);
    return [el("span", { class: "option-title" }, [text, hint ? el("span", { class: "tag", text: hint }) : null])];
  };

  const setStatus = (text, detail, state) => {
    $("status-text").textContent = text;
    $("status-detail").textContent = detail;
    status.dataset.state = state;
  };

  // ---- Light or dark: the system's choice until the toggle is used ----

  const root = document.documentElement;
  const themeButton = $("theme");
  const darkSystem = matchMedia("(prefers-color-scheme: dark)");
  const theme = () => root.dataset.theme || (darkSystem.matches ? "dark" : "light");
  const labelTheme = () => {
    const label = theme() === "dark" ? "Switch to light mode" : "Switch to dark mode";
    themeButton.setAttribute("aria-label", label);
    themeButton.title = label;
  };
  themeButton.addEventListener("click", () => {
    const next = theme() === "dark" ? "light" : "dark";
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      root.classList.add("theming");
      setTimeout(() => root.classList.remove("theming"), 350);
      themeButton.classList.remove("spin");
      void themeButton.offsetWidth;
      themeButton.classList.add("spin");
    }
    root.dataset.theme = next;
    // Kept for reloads of this setup's page; each setup runs on a new port.
    try { localStorage.setItem("ako-theme", next); } catch {}
    labelTheme();
  });
  darkSystem.addEventListener("change", labelTheme);
  labelTheme();

  // ---- The pipeline ----

  // After the last part, the one thing left to run, in the terminal.
  const check = el("li", { class: "step check" }, [
    el("div", { class: "track" }, el("span", { class: "mark", "aria-hidden": "true" })),
    el("div", { class: "label" }, [el("p", { class: "step-name", text: "npx ako check" }), el("p", { class: "step-sub", text: "after setup" })]),
  ]);

  function resetPipeline() {
    stepList.replaceChildren(check);
    check.className = "step check";
    check.querySelector(".step-sub").textContent = "after setup";
  }

  function makeStep(name) {
    const [title, hint] = split(name);
    const sub = el("p", { class: "step-sub" });
    const li = el("li", { class: "step pending" }, [
      el("div", { class: "track" }, [el("span", { class: "mark", "aria-hidden": "true" }), el("span", { class: "wire", "aria-hidden": "true" })]),
      el("div", { class: "label" }, [el("p", { class: "step-name", text: title }), sub]),
    ]);
    stepList.insertBefore(li, check);
    stepList.querySelectorAll(".step.final").forEach((node) => node.classList.remove("final"));
    li.classList.add("final");
    return { name, title, hint, li, sub, notes: [], part: "", state: "pending", visited: false };
  }

  // "passed · 3 done, 1 warning": what a finished part did.
  function summarize(notes) {
    const count = (kind) => notes.filter((note) => note.kind === kind).length;
    const parts = [];
    const ok = count("ok");
    const warn = count("warn");
    const error = count("error");
    if (ok) parts.push(ok + " done");
    if (warn) parts.push(warn + (warn === 1 ? " warning" : " warnings"));
    if (error) parts.push(error + (error === 1 ? " problem" : " problems"));
    return parts.length ? "passed · " + parts.join(", ") : "passed";
  }

  function subFor(step) {
    if (step.state === "done") return summarize(step.notes);
    if (step.state === "now") return "running" + (step.part ? " · " + step.part.toLowerCase() : "");
    if (step.state === "skipped") return "skipped";
    if (step.state === "stopped") return "stopped";
    return "queued" + (step.hint ? " · " + step.hint : "");
  }

  function setState(step, state, delay = 0) {
    const was = step.state;
    step.state = state;
    const final = step.li.classList.contains("final");
    step.li.className = "step " + state + (final ? " final" : "") + (settled && state === "done" && was !== "done" ? " just-done" : "");
    step.li.querySelector(".mark").style.animationDelay = delay ? delay + "ms" : "";
    if (state === "now") step.li.setAttribute("aria-current", "step");
    else step.li.removeAttribute("aria-current");
    step.sub.textContent = subFor(step);
  }

  function showWhere() {
    const name = at >= 0 && at < steps.length ? steps[at].title : "";
    let text = "Pipeline · starting";
    if (finished) text = "Pipeline · " + (at >= steps.length ? "finished" : "stopped");
    else if (at >= steps.length && steps.length) text = "Pipeline · finishing up";
    else if (at >= 0 && plan) text = "Pipeline · step " + (at + 1) + " of " + steps.length;
    else if (at >= 0) text = "Pipeline";
    where.replaceChildren(text, name ? el("span", { class: "where-name", text: " · " + name }) : "");
    if (eyebrow) eyebrow.textContent = eyebrowText();
  }

  function moveTo(index) {
    at = index;
    steps.forEach((step, i) => setState(step, i < at ? (step.visited ? "done" : "skipped") : i === at ? "now" : "pending"));
    showWhere();
  }

  // "Projects · Slack": the part running, and the piece of it, for the card.
  function eyebrowText() {
    if (finished) return "Setup";
    if (at < 0 || !steps.length) return "Getting started";
    if (at >= steps.length) return "Finishing up";
    const step = steps[at];
    return step.title + (step.part ? " · " + step.part : "");
  }

  // ---- What AKO says ----

  const OK = /^(Connected|Created|Saved|Added|Signed in|Installed|Found|Wrote)/;

  function classify(event) {
    let kind = event.kind;
    let text = String(event.text);
    if (kind === "warn") text = text.replace(/^!\\s*/, "");
    else if (kind === "error") text = text.replace(/^✗\\s*/, "");
    else if (kind === "text" && text.startsWith("- ")) { kind = "item"; text = text.slice(2); }
    else if (kind === "text" && OK.test(text)) kind = "ok";
    return { kind, text };
  }

  // Where a note belongs: the part running, the start, or the closing summary.
  const bucket = () => (at < 0 ? intro : at >= steps.length ? closing : steps[at].notes);
  const stepTag = () => (at < 0 ? "setup" : at >= steps.length ? "done" : steps[at].title.toLowerCase());

  const hostOf = (url) => { try { return new URL(url).host; } catch { return "a page"; } };

  // A note as the card shows it.
  function noteNode(note) {
    if (note.kind === "text") return el("p", { class: "lead" }, withLinks(note.text));
    if (note.kind === "sub") return el("p", { class: "sub", text: note.text });
    if (note.kind === "ok") return el("p", { class: "done-line" }, withLinks(note.text));
    if (note.kind === "item") return el("p", { class: "item" }, withLinks(note.text));
    if (note.kind === "link") {
      return el("p", { class: "link-note" }, [
        el("span", { text: "AKO opened " + hostOf(note.text) + " in a new tab." }),
        el("a", { href: note.text, target: "_blank", rel: "noreferrer noopener", text: "Open it again" }),
      ]);
    }
    return el("p", { class: "callout " + (note.kind === "error" ? "error" : "warn") }, withLinks(note.text));
  }

  // A note as the log shows it: the part, a mark, the text.
  const MARKS = { ok: "✓", warn: "!", error: "✗", text: "›", item: "–", link: "↗", sub: "#" };
  function logNode(note, tag) {
    const text = note.kind === "link"
      ? [el("span", { text: "Opened " + hostOf(note.text) + " · " }), el("a", { href: note.text, target: "_blank", rel: "noreferrer noopener", text: "open again" })]
      : withLinks(note.text);
    return el("p", { class: "log-line", "data-kind": note.kind }, [
      el("span", { class: "log-step", text: tag }),
      el("span", { class: "log-mark", "aria-hidden": "true", text: MARKS[note.kind] || "›" }),
      el("span", { class: "log-text" }, text),
    ]);
  }

  // What belongs in the card: everything but the ticks, which the log keeps,
  // and the names of a part's pieces, which the eyebrow shows.
  const briefWorthy = (note) => note.kind !== "ok" && note.kind !== "sub";

  function addNote(note) {
    const notes = bucket();
    notes.push(note);
    const step = at >= 0 && at < steps.length ? steps[at] : null;
    if (step) {
      step.visited = true;
      if (note.kind === "sub") {
        step.part = note.text;
        step.sub.textContent = subFor(step);
        if (eyebrow) eyebrow.textContent = eyebrowText();
      }
    }
    if (notes === closing) return;
    const line = logNode(note, stepTag());
    if (settled) line.classList.add("fresh");
    log.append(line);
    log.scrollTop = log.scrollHeight;
    if (!briefWorthy(note)) return;
    fresh.push(note);
    // While AKO works, what it says shows up in the card as it comes.
    if (!current && brief) {
      const node = noteNode(note);
      if (settled) node.classList.add("fresh");
      brief.append(node);
    }
  }

  function heading(name) {
    if (!plan) {
      // Nothing said which parts there are: each heading starts one.
      steps.push(makeStep(name));
      moveTo(steps.length - 1);
      steps[at].visited = true;
      return;
    }
    const step = steps[at];
    if (step && step.name === name) {
      // The part starts (again, after going back): what it said before is replaced,
      // and what the last part said after its last question isn't this one's news.
      step.notes.length = 0;
      step.part = "";
      step.visited = true;
      fresh = [];
      if (!current && brief) brief.replaceChildren();
      step.sub.textContent = subFor(step);
      if (eyebrow) eyebrow.textContent = eyebrowText();
      return;
    }
    if (at >= steps.length) return; // the closing summary's own heading
    addNote({ kind: "sub", text: name });
  }

  function addLog(event) {
    if (event.kind === "heading") heading(event.text);
    else addNote(classify(event));
  }

  function progress(event) {
    if (!plan || plan.join("\\n") !== event.steps.join("\\n")) {
      plan = event.steps;
      resetPipeline();
      steps = plan.map(makeStep);
    }
    moveTo(event.at);
  }

  // ---- The flow file ----

  // A YAML line as text, with its key and any comment set apart.
  function yamlLine(line) {
    const comment = /^(\\s*)(#.*)$/.exec(line);
    if (comment) return [comment[1], el("span", { class: "c", text: comment[2] })];
    const keyed = /^(\\s*(?:- )?)([A-Za-z0-9_.-]+:)(.*)$/.exec(line);
    if (keyed) return [keyed[1], el("span", { class: "k", text: keyed[2] }), keyed[3]];
    return [line];
  }

  // The first version the page gets is the file as it was; later ones mark what changed.
  function showFile(text) {
    const before = fileText === null ? null : new Set(fileText.split("\\n"));
    fileText = text;
    const lines = text.replace(/\\n$/, "").split("\\n");
    if (!text.trim()) {
      fileLines.replaceChildren(el("p", { class: "file-empty", text: "Nothing yet. Each project shows up here as soon as AKO adds it." }));
      return;
    }
    let first = null;
    const rows = lines.map((line, i) => {
      // Lines that weren't there in the last version AKO saved.
      const changed = before !== null && !before.has(line);
      const row = el("div", { class: "file-line" + (changed ? " changed" : "") }, [el("span", { class: "ln", text: String(i + 1) }), el("span", {}, yamlLine(line))]);
      if (changed && !first) first = row;
      return row;
    });
    fileLines.replaceChildren(...rows);
    if (first) fileLines.scrollTop = Math.max(0, first.offsetTop - fileLines.offsetTop - 24);
  }

  // ---- The question ----

  async function answer(value, back = false) {
    const id = current && current.id;
    // A second Enter pressed just as the next question appears must not answer it.
    if (!id || performance.now() - renderedAt < 350) return;
    direction = back ? "back" : "forward";
    for (const control of card.querySelectorAll("button, input")) control.disabled = true;
    try {
      const res = await fetch("/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AKO-Token": token },
        body: JSON.stringify(back ? { id, back: true } : { id, value }),
      });
      if (!res.ok && res.status !== 409) throw new Error("HTTP " + res.status);
    } catch {
      setStatus("Disconnected", "check the terminal that started the setup is still running", "off");
      for (const control of card.querySelectorAll("button, input")) control.disabled = false;
    }
  }

  const key = (text) => el("kbd", { text, "aria-hidden": "true" });

  function enter() {
    card.classList.remove("forward", "back");
    if (settled) {
      void card.offsetWidth;
      card.classList.add(direction);
    }
    // Only when the question's top is out of sight: the pipeline above it stays in view otherwise.
    if (card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: "start" });
  }

  // The card's top: the part running, and what AKO said since the last
  // answer. A question with nothing new shows the part's own introduction.
  function cardHead(label) {
    eyebrow = el("p", { class: "eyebrow", text: eyebrowText() });
    const head = el("div", { class: "q-head" }, [eyebrow]);
    if (label) head.append(el("h1", { class: "q-label", id: "q-label" }, withLinks(label)));
    const step = at >= 0 && at < steps.length ? steps[at] : null;
    const introduction = step ? step.notes.filter((note) => note.kind === "text").slice(0, 1) : intro.filter(briefWorthy);
    const shown = fresh.length || !label ? fresh : introduction;
    brief = el("div", { class: "brief" }, shown.map(noteNode));
    return [head, brief];
  }

  function render(q) {
    current = q;
    renderedAt = performance.now();
    if (at >= 0 && at < steps.length) steps[at].visited = true;
    card.className = "card";
    card.replaceChildren(...cardHead(q.label));
    if (q.problem) card.append(el("p", { class: "callout error problem", id: "q-problem", role: "alert", text: q.problem }));

    const form = el("form", { "aria-labelledby": "q-label" });
    const actions = el("div", { class: "actions" });
    const proceed = () => el("button", { class: "primary", type: "submit" }, ["Continue", key("↵")]);
    let focus = null;

    if (q.kind === "text" || q.kind === "secret") {
      const input = el("input", {
        type: q.kind === "secret" ? "password" : "text",
        autocomplete: "off",
        spellcheck: "false",
        value: q.value ?? "",
        placeholder: q.kind === "secret" && q.hasDefault ? "Leave blank to keep the current one" : q.optional ? "Optional" : "",
        "aria-labelledby": "q-label",
        "aria-describedby": q.problem ? "q-problem" : null,
        "aria-invalid": q.problem ? "true" : null,
      });
      const field = el("div", { class: "field" }, input);
      if (q.kind === "secret") {
        const toggle = el("button", { type: "button", class: "small", text: "Show" });
        toggle.addEventListener("click", () => {
          input.type = input.type === "password" ? "text" : "password";
          toggle.textContent = input.type === "password" ? "Show" : "Hide";
        });
        field.append(toggle);
      }
      form.append(field);
      actions.append(proceed());
      if (q.optional && !q.hasDefault) {
        const skip = el("button", { type: "button", text: "Skip" });
        skip.addEventListener("click", () => answer(""));
        actions.append(skip);
      }
      form.addEventListener("submit", (e) => { e.preventDefault(); answer(input.value); });
      focus = input;
    } else if (q.kind === "confirm") {
      const yes = el("button", { type: "button", class: q.default ? "primary" : "" }, ["Yes", key("Y")]);
      const no = el("button", { type: "button", class: q.default ? "" : "primary" }, ["No", key("N")]);
      yes.addEventListener("click", () => answer(true));
      no.addEventListener("click", () => answer(false));
      actions.append(yes, no);
      focus = q.default ? yes : no;
    } else if (q.kind === "choose" || q.kind === "chooseMany") {
      const many = q.kind === "chooseMany";
      const name = "q" + q.id;
      const numbered = q.options.length <= 8;
      // A single choice with only one option needs no picking.
      const defaults = !many && q.default < 0 && q.options.length === 1 ? [0] : [].concat(q.default ?? []);
      // Short names sit side by side as tiles; sentences get a row each.
      const tiles = q.options.length >= 3 && q.options.every((label) => label.length <= 28 && !label.includes(":"));
      const box = el("div", { class: "options" + (tiles ? " tiles" : ""), role: many ? "group" : "radiogroup", "aria-labelledby": "q-label" });
      const rows = q.options.map((label, index) => {
        const input = el("input", { type: many ? "checkbox" : "radio", name, value: String(index), checked: defaults.includes(index) });
        return el("label", { class: "option" }, [input, el("span", { class: "option-text" }, optionText(label)), numbered ? key(String(index + 1)) : null]);
      });
      if (!numbered) {
        const filter = el("input", { type: "search", placeholder: "Filter", "aria-label": "Filter the options" });
        filter.addEventListener("input", () => {
          const term = filter.value.trim().toLowerCase();
          rows.forEach((row) => { row.hidden = term !== "" && !row.textContent.toLowerCase().includes(term); });
        });
        form.append(filter);
      }
      box.append(...rows);
      form.append(box);
      if (many && q.min) form.append(el("p", { class: "muted", text: q.min === 1 ? "Pick one or more." : "Pick at least " + q.min + "." }));
      actions.append(proceed());
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const picked = [...form.querySelectorAll("input[name=" + name + "]:checked")].map((input) => Number(input.value));
        if (!many && picked.length === 0) {
          form.querySelector(".problem")?.remove();
          form.prepend(el("p", { class: "callout error problem", role: "alert", text: "Pick one of the options." }));
          return;
        }
        answer(many ? picked : picked[0]);
      });
      focus = box.querySelector("input:checked") || box.querySelector("input");
    } else if (q.kind === "pause") {
      actions.append(proceed());
      form.addEventListener("submit", (e) => { e.preventDefault(); answer(true); });
      focus = actions.firstChild;
    }

    if (q.canGoBack) {
      const back = el("button", { type: "button", class: "back", "aria-keyshortcuts": "Escape" }, ["Back", key("Esc")]);
      back.addEventListener("click", () => answer(undefined, true));
      actions.append(back);
    }
    form.append(actions);
    card.append(form);
    if (focus) focus.focus({ preventScroll: true });
    enter();
  }

  // Esc goes back, as in the terminal. Away from a text field, 1 to 8 pick an
  // option, Y and N answer a yes-or-no question, and Enter continues.
  document.addEventListener("keydown", (e) => {
    if (!current || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target || {};
    if (e.key === "Escape") {
      if (!current.canGoBack || (target.type === "search" && target.value)) return;
      e.preventDefault();
      answer(undefined, true);
      return;
    }
    if (target.type === "text" || target.type === "password" || target.type === "search") return;
    if (current.kind === "confirm" && (e.key === "y" || e.key === "n")) {
      e.preventDefault();
      answer(e.key === "y");
    } else if (/^[1-8]$/.test(e.key) && (current.kind === "choose" || current.kind === "chooseMany") && current.options.length <= 8) {
      const input = card.querySelectorAll(".option input")[Number(e.key) - 1];
      if (!input) return;
      e.preventDefault();
      input.checked = input.type === "radio" ? true : !input.checked;
      input.focus();
    } else if (e.key === "Enter" && (target.type === "radio" || target.type === "checkbox")) {
      e.preventDefault();
      card.querySelector("form")?.requestSubmit();
    }
  });

  function working() {
    current = null;
    fresh = [];
    card.className = "card";
    card.replaceChildren(...cardHead(null), el("div", { class: "working" }, [el("span", { class: "bar", "aria-hidden": "true" }), el("p", { class: "muted", text: "Working…" })]));
  }

  // ---- The end ----

  function copyButton(text) {
    const button = el("button", { type: "button", class: "small primary", text: "Copy" });
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
      } catch {
        getSelection()?.selectAllChildren(button.previousSibling);
        button.textContent = "Press Ctrl+C to copy";
      }
    });
    return button;
  }

  const command = (text) => el("div", { class: "command" }, [el("code", { text }), copyButton(text)]);

  function end(event) {
    const stoppedAt = event.type === "error" && at >= 0 && at < steps.length ? at : -1;
    finished = true;
    current = null;
    brief = null;
    eyebrow = null;
    steps.forEach((step, i) => setState(step, i === stoppedAt ? "stopped" : step.visited ? "done" : "skipped", stoppedAt < 0 ? i * 90 : 0));
    if (event.type === "done") {
      check.className = "step check next";
      check.querySelector(".step-sub").textContent = "run this next";
      at = steps.length;
    }
    showWhere();
    fileBadge.textContent = "SAVED";
    // The setup's closing summary: what it saved, what the final check found and what's left.
    const notes = plan ? closing : steps.length ? steps[steps.length - 1].notes : [];
    const kinds = (kind) => notes.filter((note) => note.kind === kind);
    const finale = el("div", { class: "finale" });

    if (event.type === "done") {
      const problems = kinds("error");
      const todo = kinds("item");
      if (problems.length) {
        finale.append(
          el("div", { class: "stamp alert", "aria-hidden": "true" }),
          el("h2", { text: problems.length === 1 ? "Saved, with 1 problem to fix" : "Saved, with " + problems.length + " problems to fix" }),
          el("div", { class: "list" }, problems.map(noteNode)),
          el("p", {}, [(problems.length === 1 ? "Fix it" : "Fix them") + " in ", el("code", { text: "release-flow.yaml" }), ", then test the setup from your terminal:"]),
          command("npx ako check"),
        );
      } else {
        finale.append(
          el("div", { class: "stamp", "aria-hidden": "true" }),
          el("h2", { text: "Setup finished" }),
          el("div", { class: "list" }, [...kinds("ok"), ...kinds("warn")].map(noteNode)),
        );
        if (todo.length) finale.append(el("h3", { text: "Still to do" }), el("div", { class: "list" }, todo.map(noteNode)));
        finale.append(el("p", { text: (todo.length ? "Then test" : "Next, test") + " every connection from your terminal:" }), command("npx ako check"));
      }
      finale.append(el("p", { class: "muted", text: "You can close this tab." }));
    } else {
      finale.append(
        el("div", { class: "stamp stopped", "aria-hidden": "true" }),
        el("h2", { text: "The setup stopped" }),
        el("p", { class: "callout error", text: event.message || "Something went wrong." }),
        el("p", { class: "muted", text: "Fix the problem, then run the setup again. Everything saved so far is kept." }),
      );
    }
    card.className = "card";
    card.replaceChildren(finale);
    direction = "forward";
    enter();
    setStatus("Ended", "the setup has stopped serving this page", "ended");
    source.close();
  }

  const source = new EventSource("/events?token=" + encodeURIComponent(token));
  source.addEventListener("open", () => {
    // The server replays everything on each connection.
    settled = false;
    setTimeout(() => { settled = true; }, 400);
    plan = null;
    steps = [];
    at = -1;
    intro.length = 0;
    closing.length = 0;
    fresh = [];
    brief = null;
    eyebrow = null;
    fileText = null;
    resetPipeline();
    log.replaceChildren();
    showFile("");
    fileText = null;
    showWhere();
    setStatus("Connected", "· keep the terminal open", "on");
  });
  source.addEventListener("error", () => {
    if (!finished) setStatus("Reconnecting", "lost the connection to the setup", "off");
  });
  source.addEventListener("message", (message) => {
    const event = JSON.parse(message.data);
    if (event.type === "progress") progress(event);
    else if (event.type === "log") addLog(event);
    else if (event.type === "file") showFile(event.text);
    else if (event.type === "question") render(event);
    else if (event.type === "answered") {
      if (current && current.id === event.id) working();
      else fresh = []; // replayed: what came before it belongs to an earlier question
    }
    else if (event.type === "done" || event.type === "error") end(event);
  });
})();
`;
