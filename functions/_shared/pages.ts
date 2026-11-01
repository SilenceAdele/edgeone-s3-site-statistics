/**
 * The two human-facing pages. They used to live in public/, where EdgeOne
 * serves static files before the function runs, so nothing there could be
 * token-gated.
 */

const LANDING = String.raw`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>edgeone-s3-site-statistics</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f6f7f9;
        --card: #fff;
        --fg: #1f2328;
        --muted: #6b7280;
        --line: #e5e7eb;
        --accent: #2563eb;
        --code: #f3f4f6;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #16181d;
          --card: #1f2228;
          --fg: #e6e8eb;
          --muted: #9aa1ac;
          --line: #2e333c;
          --accent: #7aa7ff;
          --code: #262a31;
        }
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        padding: 56px 20px;
        background: var(--bg);
        color: var(--fg);
        font: 15px/1.7 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      main {
        max-width: 720px;
        margin: 0 auto;
      }
      h1 {
        margin: 0 0 4px;
        font-size: 22px;
      }
      p.lead {
        margin: 0 0 28px;
        color: var(--muted);
      }
      section {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 18px 20px;
        margin-bottom: 16px;
      }
      h2 {
        margin: 0 0 10px;
        font-size: 14px;
        font-weight: 600;
        color: var(--muted);
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 14px;
      }
      td {
        padding: 6px 0;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
      }
      tr:last-child td {
        border-bottom: 0;
      }
      td:first-child {
        width: 46%;
        white-space: nowrap;
      }
      code {
        background: var(--code);
        border-radius: 4px;
        padding: 1px 5px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 13px;
      }
      a {
        color: var(--accent);
        text-decoration: none;
      }
      a:hover {
        text-decoration: underline;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>edgeone-s3-site-statistics</h1>
      <p class="lead">站点访问统计 · EdgeOne Pages Edge Function + S3</p>

      <section>
        <h2>入口</h2>
        <table>
          <tr>
            <td><a href="/dashboard.html">/dashboard.html</a></td>
            <td>自检面板，展示当前计数</td>
          </tr>
          <tr>
            <td><a href="/api/health">/api/health</a></td>
            <td>配置检查：缺哪些变量、S3 是否可用</td>
          </tr>
        </table>
      </section>

      <section>
        <h2>接口</h2>
        <table>
          <tr>
            <td><code>POST /api/hit?p=/path/</code></td>
            <td>记录一次访问，返回 204</td>
          </tr>
          <tr>
            <td><code>GET /api/stats?p=/path/</code></td>
            <td>站点与页面计数，JSON</td>
          </tr>
          <tr>
            <td><code>GET /jsonp?callback=X&amp;p=/path/</code></td>
            <td>同上，JSONP 形式</td>
          </tr>
          <tr>
            <td><code>POST /api/aggregate?token=</code></td>
            <td>强制重算聚合（需 STATS_TOKEN）</td>
          </tr>
        </table>
      </section>

      <p class="lead">
        数据存放在你自己的 S3 兼容存储中；访问日志只保留 16 位访客哈希，不存 IP。
      </p>
    </main>
  </body>
</html>
`;

const DASHBOARD = String.raw`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>站点统计 · 自检</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f6f7f9;
        --card: #fff;
        --fg: #1f2328;
        --muted: #6b7280;
        --line: #e5e7eb;
        --accent: #2563eb;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #15181c;
          --card: #1c2025;
          --fg: #e6e8eb;
          --muted: #9aa4b2;
          --line: #2c3238;
          --accent: #6ea8fe;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 32px 20px 64px;
        background: var(--bg);
        color: var(--fg);
        font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
          "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      }
      main { max-width: 860px; margin: 0 auto; }
      h1 { font-size: 20px; margin: 0 0 4px; }
      p.sub { color: var(--muted); margin: 0 0 24px; }
      form { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
      input[type="text"] {
        flex: 1 1 320px;
        padding: 9px 12px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--card);
        color: var(--fg);
        font: inherit;
      }
      button {
        padding: 9px 16px;
        border: 1px solid transparent;
        border-radius: 8px;
        background: var(--accent);
        color: #fff;
        font: inherit;
        cursor: pointer;
      }
      button:active { transform: translateY(1px); }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
      .card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 14px 16px;
      }
      .card .k { color: var(--muted); font-size: 12px; letter-spacing: .02em; }
      .card .v { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
      h2 { font-size: 14px; margin: 28px 0 10px; color: var(--muted); font-weight: 600; }
      pre {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 14px;
        overflow: auto;
        font-size: 12px;
        margin: 0;
      }
      .err { color: #d14343; }
    </style>
  </head>
  <body>
    <main>
      <h1>站点统计 · 自检</h1>
      <p class="sub">
        直接调用 <code>/api/stats</code>，确认部署后的计数是否正常。按回车或点“查询”。
      </p>

      <form id="f">
        <input id="p" type="text" value="/" aria-label="页面路径" />
        <button type="submit">查询</button>
      </form>

      <div class="grid" id="cards"></div>

      <h2>原始响应</h2>
      <pre id="raw">—</pre>
    </main>

    <script>
      const cards = document.getElementById('cards');
      const raw = document.getElementById('raw');
      const input = document.getElementById('p');

      input.value = new URLSearchParams(location.search).get('p') || '/';

      function tile(key, value) {
        const el = document.createElement('div');
        el.className = 'card';
        const k = document.createElement('div');
        k.className = 'k';
        k.textContent = key;
        const v = document.createElement('div');
        v.className = 'v';
        v.textContent = value;
        el.append(k, v);
        return el;
      }

      async function load(path) {
        const started = performance.now();
        cards.replaceChildren();
        raw.className = '';
        raw.textContent = '加载中…';
        try {
          const res = await fetch('/api/stats?p=' + encodeURIComponent(path), {
            headers: { accept: 'application/json' },
          });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
          const ms = Math.round(performance.now() - started);
          cards.append(
            tile('站点访问量', body.site_pv),
            tile('站点访客数', body.site_uv),
            tile('本页访问量', body.page_pv),
            tile('本页访客数', body.page_uv),
            tile('今日站内 PV', body.today.site_pv),
            tile('昨日站内 PV', body.yesterday.site_pv),
          );
          raw.textContent =
            JSON.stringify(body, null, 2) + '\n\n// ' + ms + ' ms · ' + path;
        } catch (e) {
          raw.className = 'err';
          raw.textContent = String(e.message || e);
        }
      }

      document.getElementById('f').addEventListener('submit', (ev) => {
        ev.preventDefault();
        load(input.value.trim() || '/');
      });
      load(input.value || '/');
    </script>
  </body>
</html>
`;

export const pageFor = (path: string): string | null =>
  path === '/' ? LANDING : path === '/dashboard.html' ? DASHBOARD : null;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const esc = (value: string): string => value.replace(/[&<>"']/g, (c) => ESCAPES[c]);

const GATE_STYLE = `
    *{box-sizing:border-box}
    :root{--brand:#409eff;--ink:#2c3e50;--muted:#5b6674}
    body{margin:0;min-height:100vh;display:grid;place-items:center;overflow:hidden;
         background:radial-gradient(60% 60% at 20% 20%,#bfdcff 0,transparent 60%),
                    radial-gradient(55% 55% at 85% 25%,#ded2ff 0,transparent 62%),
                    radial-gradient(60% 60% at 50% 95%,#c9f0dd 0,transparent 60%),#e9f0f8;
         color:var(--ink);font:15px/1.7 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}
    body::before{content:'';position:fixed;inset:-20%;pointer-events:none;opacity:.75;
         background:radial-gradient(35% 35% at 30% 40%,#9dc6ff 0,transparent 70%),
                    radial-gradient(30% 30% at 75% 60%,#e2c8ff 0,transparent 70%);
         filter:blur(46px)}
    form{position:relative;width:min(400px,calc(100vw - 40px));padding:30px 28px 26px;
         background:rgba(255,255,255,.62);border:1px solid rgba(255,255,255,.8);border-radius:16px;
         box-shadow:0 24px 60px rgba(44,62,80,.18);
         -webkit-backdrop-filter:blur(18px) saturate(160%);backdrop-filter:blur(18px) saturate(160%)}
    h1{margin:0 0 6px;font-size:19px}
    p.lead{margin:0 0 20px;color:var(--muted);font-size:13px}
    .error{margin:0 0 16px;padding:8px 12px;border-radius:8px;background:rgba(214,69,69,.1);
           border:1px solid rgba(214,69,69,.25);color:#b03030;font-size:13px}
    .error:empty{display:none}
    label{display:block;margin-bottom:8px;font-size:12px;color:var(--muted);
          letter-spacing:.04em;text-transform:uppercase}
    .field{display:flex;gap:8px;align-items:center}
    input{flex:1;min-width:0;padding:11px 12px;border:1px solid rgba(44,62,80,.18);
          border-radius:10px;background:rgba(255,255,255,.85);color:var(--ink);font:inherit;outline:none}
    input:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(64,158,255,.18)}
    .peek{display:grid;place-items:center;width:40px;height:40px;padding:0;
          border:1px solid rgba(44,62,80,.18);border-radius:10px;
          background:rgba(255,255,255,.85);color:var(--muted);cursor:pointer}
    .peek:hover{color:var(--ink)}
    .peek svg{width:17px;height:17px}
    .peek .eye-off{display:none}
    .peek.shown .eye{display:none}
    .peek.shown .eye-off{display:block}
    button.go{width:100%;margin-top:16px;padding:11px;border:0;border-radius:10px;
          background:var(--brand);color:#fff;font:inherit;font-weight:600;cursor:pointer;
          box-shadow:0 8px 20px rgba(64,158,255,.35)}
    button.go:hover{filter:brightness(1.05)}
    p.meta{margin:14px 0 0;color:var(--muted);font-size:12px;text-align:center}`;

/** The token prompt shown for "/" and "/dashboard.html". */
export function gatePage(action: string, error: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>需要访问令牌</title>
<style>${GATE_STYLE}
</style>
</head>
<body>
<form method="get" action="${esc(action)}">
  <h1>需要访问令牌</h1>
  <p class="lead">输入管理员令牌后查看访问统计。</p>
  <div class="error">${error ? esc(error) : ''}</div>
  <label for="token">管理员令牌</label>
  <div class="field">
    <input id="token" name="token" type="password" placeholder="TOKEN" autocomplete="current-password"
           autocapitalize="off" spellcheck="false" autofocus>
    <button type="button" class="peek" id="peek" aria-label="显示令牌" title="显示令牌">
      <svg class="eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
      <svg class="eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg>
    </button>
  </div>
  <button type="submit" class="go">进入</button>
  <p class="meta">令牌即 STATS_ACCESS_TOKEN；未配置时本页无需令牌。</p>
</form>
<script>
  var input = document.getElementById('token');
  var peek = document.getElementById('peek');
  peek.addEventListener('click', function () {
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    peek.classList.toggle('shown', show);
    peek.setAttribute('aria-label', show ? '隐藏令牌' : '显示令牌');
    peek.title = show ? '隐藏令牌' : '显示令牌';
    input.focus();
  });
</script>
</body>
</html>`;
}
