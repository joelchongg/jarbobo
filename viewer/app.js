(() => {
  const $ = (s) => document.querySelector(s);
  const form = $('#repo-form'), input = $('#repo-url'), app = $('#app'), welcome = $('#welcome');
  const list = $('#diagram-list'), status = $('#status'), frame = $('#diagram-frame');
  let repo, tree = new Set(), selectedPath;
  // Load the shared renderer once. Diagram payloads are sent to it after the
  // GitHub tree has been fetched and the first .jarbobo file is selected.
  frame.src = 'diagram.html';

  function parseRepo(value) {
    const u = new URL(value.includes('://') ? value : `https://${value}`);
    if (u.hostname !== 'github.com') throw new Error('Use a github.com repository URL.');
    const [owner, name, marker, ref] = u.pathname.split('/').filter(Boolean);
    if (!owner || !name) throw new Error('A repository URL needs an owner and repository name.');
    return { owner, name: name.replace(/\.git$/, ''), ref: marker === 'tree' && ref ? ref : 'HEAD' };
  }
  function appUrl(r) { return `${location.origin}${location.pathname}?repo=${encodeURIComponent(`https://github.com/${r.owner}/${r.name}${r.ref !== 'HEAD' ? `/tree/${r.ref}` : ''}`)}`; }
  async function github(path) {
    const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}${path}`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(res.status === 404 ? 'Repository or revision not found, or it is private.' : `GitHub returned ${res.status}.`);
    return res.json();
  }
  function parseDiagram(text) { return JSON.parse(text.replace(/^\uFEFF?(?:[ \t]*\/\/[^\n]*\r?\n)*/, '')); }
  function diagramAt(data) { return Array.isArray(data.versions) ? data.versions[data.versions.length - 1] : data; }
  async function raw(path) {
    const res = await fetch(`https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.ref}/${path}`);
    if (!res.ok) throw new Error(`Could not load ${path}.`);
    return res.text();
  }
  function resolvePath(value) {
    if (!value) return null;
    const clean = value.replace(/^\.\//, '');
    if (tree.has(clean)) return clean;
    const suffix = `/${clean.split('/').filter(Boolean).slice(-4).join('/')}`;
    const candidates = [...tree].filter((p) => p.endsWith(suffix));
    return candidates.length === 1 ? candidates[0] : null;
  }
  async function openSource(message) {
    const path = resolvePath(message.file || message.path);
    if (!path) { status.textContent = `Source not found in this repository: ${message.file || message.path}`; return; }
    try {
      const text = await raw(path), focus = Number(message.line || message.ranges?.[0]?.start || 1);
      $('#source-path').textContent = `${path}:${focus}`;
      $('#source-code').innerHTML = text.split(/\r?\n/).map((line, i) => `<span class="line ${i + 1 === focus ? 'focus' : ''}">${String(i + 1).padStart(5)}  ${escapeHtml(line)}</span>`).join('');
      $('#source').hidden = false;
      $('#source-code').querySelector('.focus')?.scrollIntoView({ block: 'center' });
    } catch (err) { status.textContent = err.message; }
  }
  async function snippets(message) {
    const results = await Promise.all(message.refs.map(async (ref) => {
      const path = resolvePath(ref.path || ref.file);
      if (!path) return { ok: false, err: 'Referenced source is not in this repository.' };
      try {
        const lines = (await raw(path)).split(/\r?\n/), line = Number(ref.line || ref.ranges?.[0]?.start || 1);
        const ranges = (ref.ranges?.length ? ref.ranges : [{ start: line }]).map((r) => ({ start: Math.max(1, r.start), end: Math.min(lines.length, r.end || r.start) }));
        const chunks = ranges.map((r) => { const start = Math.max(1, r.start - 2), end = Math.min(lines.length, r.end + 2); return { start, text: lines.slice(start - 1, end).join('\n') }; });
        return { ok:true, lang:path.split('.').pop(), focusLine:line, chunks, refRanges:ranges, impliedRanges:ranges, impliedLine:line };
      } catch (err) { return { ok:false, err:String(err) }; }
    }));
    frame.contentWindow.postMessage({ type:'snippets', reqId:message.reqId, results }, location.origin);
  }
  function escapeHtml(s) { const e = document.createElement('span'); e.textContent = s; return e.innerHTML; }
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.data?.source !== 'jarbobo-renderer') return;
    const m = event.data.message;
    if (m.type === 'open') openSource(m); else if (m.type === 'snippets') snippets(m);
  });
  async function select(path, button) {
    try {
      selectedPath = path; list.querySelectorAll('.diagram').forEach((x) => x.classList.toggle('active', x === button));
      const d = diagramAt(parseDiagram(await raw(path))); frame.contentWindow.postMessage({ type:'render', diagram:d }, location.origin);
      status.textContent = path;
    } catch (err) { status.textContent = err.message; }
  }
  async function load(value) {
    try {
      repo = parseRepo(value); input.value = `https://github.com/${repo.owner}/${repo.name}${repo.ref !== 'HEAD' ? `/tree/${repo.ref}` : ''}`;
      history.replaceState(null, '', appUrl(repo)); welcome.hidden = true; app.hidden = false; $('#repo-name').textContent = `${repo.owner}/${repo.name}`; status.textContent = 'Finding diagrams…'; list.replaceChildren(); $('#source').hidden = true;
      const data = await github(`/git/trees/${encodeURIComponent(repo.ref)}?recursive=1`);
      tree = new Set(data.tree.filter((x) => x.type === 'blob').map((x) => x.path));
      const diagrams = [...tree].filter((p) => p.endsWith('.jarbobo')).sort();
      if (!diagrams.length) { status.textContent = 'No .jarbobo diagrams found in this revision.'; return; }
      status.textContent = `${diagrams.length} diagram${diagrams.length === 1 ? '' : 's'} found`;
      const buttons = diagrams.map((path) => { const b = document.createElement('button'); b.className = 'diagram'; b.innerHTML = `${escapeHtml(path.split('/').pop())}<small>${escapeHtml(path)}</small>`; b.onclick = () => select(path, b); list.append(b); return b; });
      await select(diagrams[0], buttons[0]);
    } catch (err) { welcome.hidden = false; app.hidden = true; alert(err.message); }
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); load(input.value); });
  $('#close-source').onclick = () => { $('#source').hidden = true; };
  frame.addEventListener('load', () => { if (selectedPath) select(selectedPath, list.querySelector('.active')); });
  const param = new URLSearchParams(location.search).get('repo'); if (param) load(param);
})();
