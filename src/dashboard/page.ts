/**
 * The dashboard page. Deliberately dependency-free and build-free: one HTML string with a small
 * vanilla script that renders whatever `/api/state` describes. All controls are created from the
 * field descriptors, so a manifest's schema is the only thing that decides what appears.
 *
 * Client code avoids template literals and uses textContent, so manifest strings are never
 * interpreted as HTML.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>agent-bridge</title>
<style>
  :root { color-scheme: dark; --bg:#0f1115; --panel:#171a21; --line:#262b36; --text:#e6e8ee; --muted:#9aa3b2; --accent:#5b9dff; --warn:#e2b04a; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  header { padding:20px 24px; border-bottom:1px solid var(--line); display:flex; gap:24px; align-items:baseline; flex-wrap:wrap; }
  h1 { font-size:15px; margin:0; letter-spacing:.02em; }
  .meta { color:var(--muted); font-size:12.5px; display:flex; gap:18px; flex-wrap:wrap; }
  code { background:#0b0d11; border:1px solid var(--line); border-radius:5px; padding:1px 6px; font-size:12.5px; }
  main { max-width:760px; margin:0 auto; padding:24px; }
  .tabs { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:18px; }
  .tab { background:var(--panel); border:1px solid var(--line); color:var(--muted); padding:7px 13px; border-radius:7px; cursor:pointer; font-size:13px; }
  .tab.active { border-color:var(--accent); color:var(--text); }
  .caps { color:var(--muted); font-size:12.5px; margin:0 0 18px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:18px; }
  .field { margin-bottom:16px; }
  .field:last-child { margin-bottom:0; }
  label { display:block; font-weight:600; margin-bottom:5px; font-size:13px; }
  .hint { color:var(--muted); font-size:12px; margin-top:4px; }
  input[type=text], input[type=number], select { width:100%; background:#0b0d11; border:1px solid var(--line); color:var(--text); border-radius:7px; padding:9px 11px; font:inherit; }
  input:focus, select:focus { outline:1px solid var(--accent); border-color:var(--accent); }
  .row { display:flex; align-items:center; gap:9px; }
  .badge { color:var(--warn); border:1px solid var(--warn); border-radius:999px; padding:1px 8px; font-size:11px; margin-left:8px; }
  .actions { display:flex; gap:10px; align-items:center; margin-top:18px; }
  button.primary { background:var(--accent); border:0; color:#06122a; font-weight:700; padding:9px 16px; border-radius:7px; cursor:pointer; }
  button.primary[disabled] { opacity:.5; cursor:default; }
  .status { color:var(--muted); font-size:12.5px; }
  .status.err { color:#ff8484; }
  .status.ok { color:#7bd88f; }
  footer { color:var(--muted); font-size:12px; text-align:center; padding:24px; }
</style>
</head>
<body>
<header>
  <h1>agent-bridge</h1>
  <div class="meta">
    <span>harness <code id="active">…</code></span>
    <span>workspace <code id="workspace">…</code></span>
    <span id="extra"></span>
  </div>
</header>
<main>
  <div class="tabs" id="tabs"></div>
  <p class="caps" id="caps"></p>
  <div class="card" id="form"></div>
  <div class="actions">
    <button class="primary" id="save">Save</button>
    <button class="primary" id="restart" disabled>Save &amp; restart</button>
    <span class="status" id="status"></span>
  </div>
</main>
<footer>Saved values live in the config file; environment variables override them.</footer>
<script>
(function () {
  var state = null;
  var el = function (id) { return document.getElementById(id); };
  var status = function (text, kind) { var s = el('status'); s.textContent = text || ''; s.className = 'status' + (kind ? ' ' + kind : ''); };

  function get(path) { return fetch(path).then(function (r) { return r.json(); }); }
  function send(method, path, body) {
    return fetch(path, { method: method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); });
  }

  function current() {
    for (var i = 0; i < state.harnesses.length; i++) {
      if (state.harnesses[i].manifest.id === state.activeHarness) return state.harnesses[i];
    }
    return null;
  }

  function render() {
    el('restart').disabled = !state.restartAvailable;
    el('restart').title = state.restartAvailable ? 'Wait for active work, then restart and apply saved settings' : 'Enable AGENT_BRIDGE_ALLOW_RESTART=true under Kubernetes or another supervisor';
    el('active').textContent = state.activeHarness;
    el('workspace').textContent = state.workspace;
    el('extra').textContent = state.statusLine || '';

    var tabs = el('tabs');
    tabs.textContent = '';
    state.harnesses.forEach(function (h) {
      var b = document.createElement('button');
      b.className = 'tab' + (h.manifest.id === state.activeHarness ? ' active' : '');
      b.textContent = h.manifest.name;
      b.onclick = function () { choose(h.manifest.id); };
      tabs.appendChild(b);
    });

    var h = current();
    el('caps').textContent = h ? capabilityLine(h) : '';
    renderForm(h);
  }

  function capabilityLine(h) {
    var caps = h.manifest.capabilities || {};
    var names = [];
    if (caps.streaming) names.push('streaming');
    if (caps.resume) names.push('resume');
    if (caps.approvals) names.push('approvals');
    if (caps.nativeMcp) names.push('native mcp');
    if (caps.reportsCost) names.push('cost reporting');
    var line = 'v' + h.manifest.version + ' · ' + h.manifest.kind;
    if (names.length) line += ' · ' + names.join(', ');
    if (h.manifest.metadata && h.manifest.metadata.note) line += ' — ' + h.manifest.metadata.note;
    return line;
  }

  function renderForm(h) {
    var form = el('form');
    form.textContent = '';
    if (!h || !h.fields.length) {
      form.textContent = 'This harness has nothing to configure.';
      return;
    }
    h.fields.forEach(function (f) { form.appendChild(field(h, f)); });
  }

  function field(h, f) {
    var wrap = document.createElement('div');
    wrap.className = 'field';

    var label = document.createElement('label');
    label.textContent = f.title;
    if (h.pinned.indexOf(f.key) >= 0) {
      var badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'set by env';
      label.appendChild(badge);
    }
    wrap.appendChild(label);

    var value = h.values[f.key];
    var input;

    if (f.type === 'boolean') {
      var row = document.createElement('div');
      row.className = 'row';
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = value === true;
      row.appendChild(input);
      row.appendChild(document.createTextNode(input.checked ? 'enabled' : 'disabled'));
      input.onchange = function () { row.lastChild.nodeValue = input.checked ? 'enabled' : 'disabled'; };
      wrap.appendChild(row);
    } else if (f.type === 'enum') {
      input = document.createElement('select');
      var hasValue = value !== undefined && value !== null && String(value) !== '';
      if (!hasValue) {
        // Without this, a select shows its first option and a save would persist a value the
        // operator never chose. Blank means "unset", which the server drops.
        var blank = document.createElement('option');
        blank.value = '';
        blank.textContent = 'unset';
        blank.selected = true;
        input.appendChild(blank);
      }
      (f.options || []).forEach(function (opt) {
        var o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        if (String(value) === opt) o.selected = true;
        input.appendChild(o);
      });
      wrap.appendChild(input);
    } else {
      input = document.createElement('input');
      input.type = f.type === 'number' ? 'number' : (f.format === 'password' ? 'password' : 'text');
      input.value = value === undefined || value === null ? '' : String(value);
      wrap.appendChild(input);
    }

    input.dataset.key = f.key;
    input.dataset.type = f.type;

    if (f.description) {
      var hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = f.description;
      wrap.appendChild(hint);
    }
    return wrap;
  }

  function collect() {
    var values = {};
    var nodes = el('form').querySelectorAll('[data-key]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var key = n.dataset.key;
      if (n.dataset.type === 'boolean') values[key] = n.checked;
      else values[key] = n.value;
    }
    return values;
  }

  function choose(id) {
    send('POST', '/api/active', { id: id }).then(function () { return refresh(); });
  }

  function refresh() {
    return get('/api/state').then(function (data) { state = data; render(); });
  }

  el('save').onclick = function () {
    var h = current();
    if (!h) return;
    status('saving…');
    send('PUT', '/api/harnesses/' + encodeURIComponent(h.manifest.id) + '/config', collect()).then(function (res) {
      if (res.errors && res.errors.length) { status(res.errors.join('; '), 'err'); return; }
      status('saved', 'ok');
      refresh();
    }).catch(function (err) { status('failed: ' + err.message, 'err'); });
  };

  el('restart').onclick = function () {
    var h = current(), previous = state.instanceId;
    el('restart').disabled = true;
    status('saving and restarting � waiting for active work�');
    send('PUT', '/api/harnesses/' + encodeURIComponent(h.manifest.id) + '/config', collect()).then(function (res) {
      if (res.errors) throw new Error(res.errors.join('; '));
      return send('POST', '/api/restart', {});
    }).then(function (res) {
      if (res.errors) throw new Error(res.errors.join('; '));
      var attempts = 0;
      function check() {
        get('/api/state').then(function (data) {
          if (data.instanceId === previous) throw new Error('waiting');
          state = data; render(); status('restarted � saved settings applied', 'ok');
        }).catch(function () {
          if (++attempts < 40) setTimeout(check, 3000);
          else { status('Still waiting. Refresh after active work finishes.', 'err'); el('restart').disabled = false; }
        });
      }
      setTimeout(check, 3000);
    }).catch(function (err) { status(err.message, 'err'); el('restart').disabled = false; });
  };

  refresh();
})();
</script>
</body>
</html>
`;
