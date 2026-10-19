/* jarbobo webview renderer: graph (cytoscape), sequence + class diagrams (SVG). */
(function () {
  'use strict';

  // Hosts can provide a tiny VS Code-shaped bridge before this script loads.
  // That lets the same renderer power the standalone web viewer without
  // giving it access to a desktop extension host.
  const vscodeApi = typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : window.__jarboboHostApi
    ? window.__jarboboHostApi
    : {
        postMessage: (m) => {
          console.log('[jarbobo dev] postMessage', m);
          // dev harness: fake the extension's snippet response so the detail
          // panel's code preview can be exercised without an extension host
          if (m.type === 'snippets') {
            setTimeout(() => window.postMessage({
              type: 'snippets', reqId: m.reqId,
              results: m.refs.map((r) => {
                // mirror readSnippet: referenced ranges + 2 lines of context
                // around each (merged when the padding makes them touch)
                const refRanges = (r.ranges || []).map((rg) => ({ start: rg.start, end: rg.end || rg.start }));
                const padded = refRanges.length
                  ? refRanges.map((rg) => ({ start: Math.max(1, rg.start - 2), end: rg.end + 2 }))
                  : [{ start: Math.max(1, (r.line || 4) - 3), end: (r.line || 4) + 3 }];
                const merged = [];
                padded.forEach((rg) => {
                  const last = merged[merged.length - 1];
                  if (last && rg.start <= last.end + 1) { last.end = Math.max(last.end, rg.end); }
                  else { merged.push({ start: rg.start, end: rg.end }); }
                });
                // simulate drift: the "current file" moved everything down 3 lines
                const drift = 3;
                const impliedRanges = refRanges.map((rg) => ({ start: rg.start + drift, end: rg.end + drift }));
                return {
                  ok: true, lang: 'javascript', focusLine: (r.line ?? (refRanges[0] && refRanges[0].start) ?? 1) + drift,
                  refRanges: impliedRanges, impliedRanges,
                  impliedLine: r.line !== undefined ? r.line + drift : undefined,
                  chunks: merged.map((rg) => ({
                    start: rg.start + drift,
                    text: Array.from({ length: rg.end - rg.start + 1 },
                      (_, i) => (rg.start + i) % 3 === 0
                        ? '  return demo(' + (rg.start + i) + '); // ' + r.file.split('/').pop()
                        : 'function line' + (rg.start + i) + '(x) { /* dev */ }').join('\n'),
                  })),
                };
              }),
            }, '*'), 60);
          }
        },
        getState: () => null,
        setState: () => {},
      };

  const $ = (s) => document.querySelector(s);
  const stage = $('#stage');
  const tip = $('#tooltip');
  const detail = $('#detail');

  let currentDiagram = null;   // for "reset layout" (full re-render)
  let openTarget = 'main';     // where code refs open: 'main' window vs 'here' (jarbobo's group)
  let zoomSensitivity = 100;   // percent of the default zoom rate; set in the titlebar
  let lastClassPositions = null; // class-box centers from the latest renderClass, for transpose

  // ---------------------------------------------------------------- theme

  let FG = '#d4d4d4', BG = '#1e1e1e', ACCENT = '#569cd6', BORDER = '#3c3c3c', MUTED = '#9d9d9d';
  function readTheme() {
    const cs = getComputedStyle(document.body);
    const v = (name, fb) => (cs.getPropertyValue(name) || '').trim() || fb;
    FG = v('--vscode-editor-foreground', FG);
    BG = v('--vscode-editor-background', BG);
    ACCENT = v('--vscode-charts-blue', v('--vscode-textLink-foreground', ACCENT));
    BORDER = v('--vscode-panel-border', BORDER);
    MUTED = v('--vscode-descriptionForeground', MUTED);
  }

  // ---------------------------------------------------------------- text measurement

  const mctx = document.createElement('canvas').getContext('2d');
  const UI_FONT = "13px -apple-system, 'Segoe UI', sans-serif";
  const UI_FONT_BOLD = "600 13px -apple-system, 'Segoe UI', sans-serif";
  const SMALL_FONT = "12px -apple-system, 'Segoe UI', sans-serif";
  const MONO_FONT = '12px Menlo, Consolas, monospace';
  function tw(text, font) { mctx.font = font || SMALL_FONT; return mctx.measureText(text || '').width; }

  // ---------------------------------------------------------------- layout format
  // The saved arrangement (_layout) is a *versioned, namespaced envelope* so
  // that future additions never break older builds:
  //     { v: 2, nodes: { id: {x,y} }, edgeLabels: { key: {t} } }
  // Rules that keep it forward/backward compatible:
  //   • Readers only touch the sub-keys they understand and ignore the rest —
  //     so a file written by a NEWER build (with extra keys) still loads here.
  //   • New data goes under a fresh sub-key; existing keys keep their meaning,
  //     so we bump `v` only for a genuinely breaking change.
  //   • Legacy saves were a bare { id:{x,y} } map (no `v`); normalizeLayout
  //     upgrades those in memory, so old diagrams keep their positions.
  const LAYOUT_V = 2;
  // Edge-label positions are keyed by a stable identity (endpoints + label),
  // not by array index, so a saved position survives edits that reorder or
  // insert edges. JSON.stringify gives an unambiguous, printable key.
  const edgeKey = (from, to, label) => JSON.stringify([from || '', to || '', label || '']);
  function normalizeLayout(raw) {
    if (!raw || typeof raw !== 'object') { return null; }
    if (typeof raw.v === 'number' && raw.nodes && typeof raw.nodes === 'object') {
      return { v: raw.v, nodes: raw.nodes, edgeLabels: raw.edgeLabels || {} };
    }
    return { v: LAYOUT_V, nodes: raw, edgeLabels: {} }; // legacy flat map
  }
  const emptyLayout = () => ({ v: LAYOUT_V, nodes: {}, edgeLabels: {} });

  // ---------------------------------------------------------------- tooltip + detail panel

  function escHtml(s) {
    const el = document.createElement('div');
    el.textContent = s == null ? '' : String(s);
    return el.innerHTML;
  }

  // ---------------------------------------------------------------- code references
  // An element carries an ORDERED list of code references: `refs` (first =
  // primary, the ctrl/cmd+click target), with legacy `file`+`line` still
  // accepted as a single-ref shorthand. Each ref may carry `ranges` — line
  // ranges highlighted in the editor on open and previewed in the panel.
  function getRefs(item) {
    if (!item) { return []; }
    if (Array.isArray(item.refs) && item.refs.length) {
      return item.refs
        .filter((r) => r && (r.path || r.file))
        .map((r) => ({ ...r, file: r.path || r.file }));
    }
    // legacy single-ref shorthand; _anchor is the server's text snapshot for drift recovery
    return item.path || item.file ? [{ file: item.path || item.file, path: item.path, line: item.line, _anchor: item._anchor }] : [];
  }
  function refLine(r) { return r.line || (r.ranges && r.ranges.length ? r.ranges[0].start : 0); }
  // compact location: ranges as "245-252,260-262" (single-line ranges collapse
  // to one number), else the bare `line`
  function refLoc(r) {
    if (r.ranges && r.ranges.length) {
      return r.ranges.map((rg) => rg.end && rg.end !== rg.start ? rg.start + '-' + rg.end : String(rg.start)).join(',');
    }
    return r.line ? String(r.line) : '';
  }
  function refDisplay(r) { const loc = refLoc(r); return r.file + (loc ? ':' + loc : ''); }
  // Open reference r in the editor. `all` (optional) is the element's FULL ref
  // list: every ref's ranges become the active highlight set — the editor
  // highlights each referenced file as the user visits it, persisting until
  // they return to a jarbobo tab. A ref without ranges highlights its line.
  // opts.follow: open beside the diagram WITHOUT taking focus, so keyboard
  // stepping through a sequence keeps working while the code follows along.
  function openRef(r, all, opts) {
    const hl = (all && all.length ? all : [r]).map((x) => ({
      file: x.file,
      ranges: x.ranges && x.ranges.length ? x.ranges : (x.line ? [{ start: x.line }] : []),
      anchor: x._anchor, // text snapshot: highlights re-anchor if the file drifted
    })).filter((x) => x.ranges.length);
    vscodeApi.postMessage({
      type: 'open', file: r.file, line: r.line, ranges: r.ranges, anchor: r._anchor, highlights: hl, target: openTarget,
      follow: !!(opts && opts.follow),
    });
  }

  let hoverRef = null; // {item, x, y} while a tooltip is visible — lets Ctrl re-style it live

  function showItemTip(item, x, y, ctrl) {
    const hasTip = item && item.tooltip;
    const refs = getRefs(item);
    if (!hasTip && !refs.length) { return; }
    const parts = [];
    if (hasTip) { parts.push('<div>' + escHtml(item.tooltip) + '</div>'); }
    if (refs.length) {
      parts.push('<div class="ref' + (ctrl ? ' bold' : '') + '">'
        + escHtml(refDisplay(refs[0]))
        + (refs.length > 1 ? ' <span class="moreRefs">+' + (refs.length - 1) + ' more</span>' : '')
        + '</div>');
    }
    tip.innerHTML = parts.join('');
    tip.style.display = 'block';
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(x + 14, window.innerWidth - r.width - 8) + 'px';
    tip.style.top = Math.min(y + 14, window.innerHeight - r.height - 8) + 'px';
    hoverRef = { item, x, y };
  }
  function hideTip() { tip.style.display = 'none'; hoverRef = null; }

  // hold Ctrl while hovering → the code reference line goes bold
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Control' && hoverRef) { showItemTip(hoverRef.item, hoverRef.x, hoverRef.y, true); }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Control' && hoverRef) { showItemTip(hoverRef.item, hoverRef.x, hoverRef.y, false); }
  });

  let detailLocked = false;
  let detailOpenedAt = 0;
  let snippetReq = 0; // stale-response guard: only the latest request renders

  // Split hljs-highlighted HTML into per-line HTML with balanced span tags
  // (hljs spans can cross newlines, e.g. block comments). hljs escapes < > &,
  // so the only tags present are its own <span class="...">…</span>.
  function splitHighlighted(html) {
    const lines = [];
    const stack = [];
    let cur = '';
    const re = /(<span class="[^"]*">)|(<\/span>)|(\n)|([^<\n]+|<)/g;
    let m;
    while ((m = re.exec(html))) {
      if (m[1]) { stack.push(m[1]); cur += m[1]; }
      else if (m[2]) { stack.pop(); cur += m[2]; }
      else if (m[3]) { cur += '</span>'.repeat(stack.length); lines.push(cur); cur = stack.join(''); }
      else { cur += m[0]; }
    }
    lines.push(cur + '</span>'.repeat(stack.length));
    return lines;
  }
  function highlightLines(text, lang) {
    try {
      if (window.hljs) {
        const res = lang && hljs.getLanguage(lang)
          ? hljs.highlight(text, { language: lang })
          : hljs.highlightAuto(text);
        return splitHighlighted(res.value);
      }
    } catch (e) { /* fall through to plain */ }
    return text.split('\n').map(escHtml);
  }
  function renderSnippet(pre, res) {
    pre.innerHTML = '';
    pre.classList.remove('err');
    if (!res || !res.ok) {
      pre.textContent = (res && res.err) || 'could not read file';
      pre.classList.add('err');
      return;
    }
    // referenced lines get the editor's yellow wash; the focus tint only
    // applies when the ref has no ranges (bare `line` + context)
    const refRanges = res.refRanges || [];
    const inRef = (n) => refRanges.some((rg) => n >= rg.start && n <= (rg.end || rg.start));
    (res.chunks || []).forEach((ch, idx) => {
      if (idx) {
        const gap = document.createElement('div');
        gap.className = 'refGap';
        gap.textContent = '⋯';
        pre.appendChild(gap);
      }
      highlightLines(ch.text, res.lang).forEach((lineHtml, j) => {
        const n = ch.start + j;
        const row = document.createElement('div');
        row.className = 'refLine' + (inRef(n) ? ' hl' : (!refRanges.length && n === res.focusLine ? ' focus' : ''));
        row.innerHTML = '<span class="ln">' + n + '</span><span class="lc">' + (lineHtml || '&nbsp;') + '</span>';
        pre.appendChild(row);
      });
    });
  }

  function openDetail(item, label, kind) {
    detailOpenedAt = Date.now();
    $('#detailKind').textContent = kind || '';
    $('#detailTitle').textContent = label || '';
    $('#detailBody').textContent = item.detail || item.tooltip || '';
    const refs = getRefs(item);
    // ordered reference list, each with a clickable header + code preview
    // (the actual referenced lines, fetched from disk and syntax-highlighted)
    const refsBox = $('#detailRefs');
    if (refsBox) {
      refsBox.innerHTML = '';
      const reqId = ++snippetReq;
      refs.forEach((r, i) => {
        const div = document.createElement('div');
        div.className = 'refItem';
        const head = document.createElement('button');
        head.className = 'refHead';
        const loc = refLoc(r);
        const base = r.file.split('/').pop() || r.file;
        // the loc span shows ORIGINAL numbers until the snippet response
        // replaces them with the IMPLIED (re-anchored) ones
        head.innerHTML = (r.label ? '<span class="refRole">' + escHtml(r.label) + '</span>' : '')
          + '<span class="refLoc" id="refloc-' + reqId + '-' + i + '">' + escHtml(base + (loc ? ':' + loc : '')) + '</span>'
          + '<span class="refGo">↗</span>';
        head.title = 'Open ' + refDisplay(r);
        head.onclick = () => openRef(r, refs); // jump to THIS ref, highlight the full set (like ctrl/cmd+click)
        div.appendChild(head);
        if (r.note) {
          const note = document.createElement('div');
          note.className = 'refNote';
          note.textContent = r.note;
          div.appendChild(note);
        }
        const pre = document.createElement('pre');
        pre.className = 'refCode';
        pre.id = 'snip-' + reqId + '-' + i;
        pre.textContent = '…';
        pre.title = 'Open ' + refDisplay(r);
        // click the snippet → jump to THIS ref, highlight the FULL set (like ctrl/cmd+click).
        // a drag (text selection) is not treated as a click.
        pre.onclick = () => { if (String(getSelection())) { return; } openRef(r, refs); };
        div.appendChild(pre);
        refsBox.appendChild(div);
      });
      if (refs.length) { vscodeApi.postMessage({ type: 'snippets', reqId, refs }); }
    }
    const actions = $('#detailActions');
    actions.innerHTML = '';
    if (refs.length) {
      const b = document.createElement('button');
      const ln = refLine(refs[0]);
      b.textContent = 'Go to source' + (ln ? ` :${ln}` : '');
      b.title = refDisplay(refs[0]);
      b.onclick = () => openRef(refs[0], refs); // primary jump = full highlight set
      actions.appendChild(b);
    }
    if (item.href) {
      const b = document.createElement('button');
      b.textContent = 'Open link';
      b.onclick = () => vscodeApi.postMessage({ type: 'openUrl', url: item.href });
      actions.appendChild(b);
    }
    detail.hidden = false;
  }
  function closeDetail() { detail.hidden = true; }
  $('#closeDetail').addEventListener('click', closeDetail); // ✕ closes even when locked

  const lockBtn = $('#lockDetail');
  function updateLockBtn() {
    if (!lockBtn) { return; }
    lockBtn.textContent = detailLocked ? '🔒' : '🔓';
    lockBtn.title = detailLocked
      ? 'Locked: click-outside and Esc will not close this panel'
      : 'Unlocked: clicking outside the panel closes it';
  }
  if (lockBtn) {
    lockBtn.addEventListener('click', () => { detailLocked = !detailLocked; updateLockBtn(); });
    updateLockBtn();
  }

  // click anywhere outside the detail panel closes it (unless locked)
  document.addEventListener('mousedown', (e) => {
    if (detail.hidden || detailLocked) { return; }
    if (e.button !== 0) { return; }                       // right-drag pan shouldn't close it
    if (detail.contains(e.target)) { return; }
    if (Date.now() - detailOpenedAt < 200) { return; }    // ignore the click that opened it
    closeDetail();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!detailLocked) { closeDetail(); }
      hideTip();
    }
  });

  // ---------------------------------------------------------------- component card
  // A diagram's `card` — purpose, the whole component as pseudocode, I/O,
  // what to black-box, reading order, check questions — in a collapsible
  // panel on the left. Pseudocode lines with a `step` focus that message;
  // anything with refs opens its code.

  const cardPanel = document.createElement('aside');
  cardPanel.id = 'card';
  cardPanel.hidden = true;
  document.body.appendChild(cardPanel);
  const btnCard = document.createElement('button');
  btnCard.className = 'tbtn';
  btnCard.id = 'btnCard';
  btnCard.textContent = 'card';
  btnCard.title = 'Show or hide the component card';
  btnCard.hidden = true;
  if ($('#btnTarget')) { $('#btnTarget').before(btnCard); }

  // The reader's last show/hide choice, kept per viewer.
  let cardWanted = true;
  try { cardWanted = localStorage.getItem('jarbobo.cardHidden') !== '1'; } catch { /* storage unavailable */ }
  function setCardShown(shown) {
    cardWanted = shown;
    cardPanel.hidden = !shown;
    btnCard.classList.toggle('on', shown);
    try { localStorage.setItem('jarbobo.cardHidden', shown ? '0' : '1'); } catch { /* storage unavailable */ }
  }
  btnCard.addEventListener('click', () => setCardShown(cardPanel.hidden));

  function renderCard(d) {
    const card = d.card;
    cardPanel.innerHTML = '';
    btnCard.hidden = !card;
    if (!card) { cardPanel.hidden = true; return; }
    cardPanel.hidden = !cardWanted;
    btnCard.classList.toggle('on', cardWanted);

    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) { e.className = cls; }
      if (text !== undefined) { e.textContent = text; }
      return e;
    };
    // a "file:lines ↗" link for anything with refs, or null
    const refLink = (x, text) => {
      const refs = getRefs(x);
      if (!refs.length) { return null; }
      const loc = refLoc(refs[0]);
      const a = el('button', 'cardRef', text || ((refs[0].file.split('/').pop() || refs[0].file) + (loc ? ':' + loc : '') + ' ↗'));
      a.title = 'Open ' + refDisplay(refs[0]);
      a.onclick = (e) => { e.stopPropagation(); openRef(refs[0], refs); };
      return a;
    };
    const section = (title) => { cardPanel.appendChild(el('h3', 'cardH', title)); };

    const close = el('button', 'cardClose', '✕');
    close.title = 'Hide the card (the titlebar "card" button brings it back)';
    close.onclick = () => setCardShown(false);
    cardPanel.appendChild(close);
    cardPanel.appendChild(el('div', 'kind', 'component card'));
    cardPanel.appendChild(el('p', 'cardPurpose', card.purpose || ''));
    if (card.analogy) { cardPanel.appendChild(el('p', 'cardAnalogy', card.analogy)); }

    if (card.terms && card.terms.length) {
      section('Key terms');
      const t = el('table', 'cardTable');
      card.terms.forEach((x) => {
        const tr = el('tr');
        tr.appendChild(el('td', 'cardTerm', x.term));
        tr.appendChild(el('td', '', x.meaning));
        t.appendChild(tr);
      });
      cardPanel.appendChild(t);
    }

    if (card.pseudocode && card.pseudocode.length) {
      section('The whole component');
      card.pseudocode.forEach((block) => {
        const head = el('div', 'cardBlockHead', block.title);
        if (block.status) { head.appendChild(el('span', 'cardStatus', block.status)); }
        cardPanel.appendChild(head);
        const code = el('div', 'cardCode');
        (block.lines || []).forEach((line) => {
          const row = el('div', 'cardLine');
          // leading spaces become a hanging indent, so wrapped lines stay nested
          const indent = /^\s*/.exec(line.text)[0].length;
          const text = el('span', 'cardLineText', line.text.trimStart());
          text.style.paddingLeft = indent + 'ch';
          row.appendChild(text);
          const refs = getRefs(line);
          if (line.step) {
            row.classList.add('linked');
            row.appendChild(el('span', 'cardStep', 'step ' + line.step));
            row.title = 'Focus step ' + line.step + ' in the diagram and open its code';
            row.onclick = () => { if (seqFocus) { seqFocus.focus(line.step - 1); } };
          } else if (refs.length) {
            row.classList.add('linked');
            row.title = 'Open ' + refDisplay(refs[0]);
            row.onclick = () => openRef(refs[0], refs);
          }
          code.appendChild(row);
        });
        cardPanel.appendChild(code);
      });
    }

    if (card.io && card.io.length) {
      section('In and out');
      const t = el('table', 'cardTable');
      card.io.forEach((x) => {
        const tr = el('tr');
        tr.appendChild(el('td', 'cardDir', x.direction === 'in' ? '→ in' : 'out →'));
        tr.appendChild(el('td', 'cardMono', x.link));
        tr.appendChild(el('td', '', x.what));
        const td = el('td');
        const link = refLink(x);
        if (link) { td.appendChild(link); }
        tr.appendChild(td);
        t.appendChild(tr);
      });
      cardPanel.appendChild(t);
    }

    if (card.blackBox && card.blackBox.length) {
      section('Treat as a black box');
      const ul = el('ul', 'cardList');
      card.blackBox.forEach((x) => {
        const li = el('li');
        li.appendChild(el('span', 'cardMono', x.name));
        li.appendChild(document.createTextNode(' — ' + x.what + ' '));
        const link = refLink(x, '↗');
        if (link) { li.appendChild(link); }
        ul.appendChild(li);
      });
      cardPanel.appendChild(ul);
    }

    if (card.goodEnough) {
      const g = el('div', 'cardGood');
      g.appendChild(el('strong', '', 'Good enough when you can explain: '));
      g.appendChild(document.createTextNode(card.goodEnough));
      cardPanel.appendChild(g);
    }

    if (card.readingOrder && card.readingOrder.length) {
      section('Reading order');
      const ol = el('ol', 'cardList');
      card.readingOrder.forEach((x) => {
        const li = el('li', x.skip ? 'skip' : '');
        const link = refLink(x);
        if (link) { li.appendChild(link); li.appendChild(document.createTextNode(' ')); }
        if (x.skip) { li.appendChild(el('span', 'cardSkip', 'skip')); }
        li.appendChild(document.createTextNode(x.text));
        ol.appendChild(li);
      });
      cardPanel.appendChild(ol);
    }

    if (card.questions && card.questions.length) {
      section('Check yourself');
      const ol = el('ol', 'cardList');
      card.questions.forEach((x) => {
        const li = el('li');
        li.appendChild(el('div', 'cardQ', x.q));
        if (x.answer) {
          const ans = el('div', 'cardAnswer', x.answer);
          ans.hidden = true;
          const link = refLink(x, 'see the code ↗');
          if (link) { ans.appendChild(document.createTextNode(' ')); ans.appendChild(link); }
          const show = el('button', 'cardShow', 'show answer');
          show.onclick = () => { ans.hidden = !ans.hidden; show.textContent = ans.hidden ? 'show answer' : 'hide answer'; };
          li.appendChild(show);
          li.appendChild(ans);
        }
        ol.appendChild(li);
      });
      cardPanel.appendChild(ol);
    }
  }

  // ---------------------------------------------------------------- purpose lines
  // Graph nodes' `purpose` and groups' `description`, drawn as smaller muted
  // text. A titlebar toggle hides them for readers who know the system.

  const PURPOSE_FONT_PX = 10.5;
  const PURPOSE_FONT = PURPOSE_FONT_PX + 'px -apple-system, sans-serif';
  const PURPOSE_LINE = 13, PURPOSE_GAP = 3, PURPOSE_MAX_W = 170;
  const GROUP_DESC_H = 2 * PURPOSE_LINE; // two lines are reserved; longer text is clamped
  const GROUP_DESC_MIN_W = 260;
  let purposeShown = true;
  try { purposeShown = localStorage.getItem('jarbobo.purposeHidden') !== '1'; } catch { /* storage unavailable */ }
  const btnPurpose = document.createElement('button');
  btnPurpose.className = 'tbtn';
  btnPurpose.id = 'btnPurpose';
  btnPurpose.textContent = 'purpose';
  btnPurpose.title = 'Show or hide the "what it is for" lines under node and group labels';
  btnPurpose.hidden = true;
  if ($('#btnTarget')) { $('#btnTarget').before(btnPurpose); }
  btnPurpose.addEventListener('click', () => {
    purposeShown = !purposeShown;
    try { localStorage.setItem('jarbobo.purposeHidden', purposeShown ? '0' : '1'); } catch { /* storage unavailable */ }
    if (currentDiagram) { render(currentDiagram); }
  });
  function updatePurposeBtn(d) {
    const has = d.type === 'graph' && ((d.nodes || []).some((n) => n.purpose) || (d.groups || []).some((g) => g.description));
    btnPurpose.hidden = !has;
    btnPurpose.classList.toggle('on', purposeShown);
  }

  // ---------------------------------------------------------------- edge layers
  // Graph edges with a `kind` get a legend with a toggle per kind. Hidden
  // kinds are remembered per diagram, per viewer.

  const edgeLegend = document.createElement('div');
  edgeLegend.id = 'edgeLegend';
  edgeLegend.hidden = true;
  document.body.appendChild(edgeLegend);
  const layerKey = (d) => 'jarbobo.edgeLayers:' + (d._id || d.title || '');
  function loadHiddenKinds(d) {
    try {
      const saved = localStorage.getItem(layerKey(d));
      if (saved) { return new Set(JSON.parse(saved)); }
    } catch { /* storage unavailable or bad JSON: fall back to the diagram's defaults */ }
    return new Set((d.edgeKinds || []).filter((k) => k.hidden).map((k) => k.kind));
  }
  function saveHiddenKinds(d, hidden) {
    try { localStorage.setItem(layerKey(d), JSON.stringify([...hidden])); } catch { /* storage unavailable */ }
  }

  // ---------------------------------------------------------------- search
  // ⌘F / Ctrl+F (or "/") searches the diagram: matches light up with their
  // neighbours, everything else dims; Enter / ⇧Enter step through them.
  // Renderers that support it set searchOps = { run(q, opts) → count,
  // show(i), clear() }; it is null for diagram types without search.

  let searchOps = null;
  let searchCount = 0, searchIndex = -1;
  const searchBox = document.createElement('div');
  searchBox.id = 'searchBox';
  searchBox.hidden = true;
  searchBox.innerHTML =
    '<input id="searchInput" type="text" placeholder="Search names, notes, files…" spellcheck="false">'
    + '<span id="searchCount"></span>'
    + '<label title="Also search the longer explanations shown in the side panel"><input type="checkbox" id="searchDetail">details</label>'
    + '<button id="searchClose" title="Close (Esc)">✕</button>';
  document.body.appendChild(searchBox);
  const searchInput = $('#searchInput'), searchCountEl = $('#searchCount'), searchDetail = $('#searchDetail');
  const btnSearch = document.createElement('button');
  btnSearch.className = 'tbtn';
  btnSearch.id = 'btnSearch';
  btnSearch.textContent = 'search';
  btnSearch.title = 'Search this diagram (⌘F / Ctrl+F, or /)';
  btnSearch.hidden = true;
  if ($('#btnTarget')) { $('#btnTarget').before(btnSearch); }
  btnSearch.addEventListener('click', () => openSearch());

  // lowercase haystack for an element: its names plus tooltip and ref file
  // names, and the detail text when asked for
  function searchText(item, extra, withDetail) {
    const parts = [...extra, item && item.tooltip, ...getRefs(item).map((r) => r.file.split('/').pop())];
    if (withDetail && item) { parts.push(item.detail); }
    return parts.filter(Boolean).join('\n').toLowerCase();
  }
  // every whitespace-separated term must appear
  function matchesQuery(text, q) {
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => text.includes(t));
  }
  // order hits so name matches come first, then purpose/description, then
  // the rest (tooltips, file names, details), each in diagram order
  function rankHits(hits, q, names, purposes) {
    const score = (h) => matchesQuery(names(h).filter(Boolean).join('\n').toLowerCase(), q) ? 0
      : matchesQuery(purposes(h).filter(Boolean).join('\n').toLowerCase(), q) ? 1 : 2;
    return hits.map((h, i) => ({ h, i, s: score(h) })).sort((x, y) => x.s - y.s || x.i - y.i).map((x) => x.h);
  }

  function updateSearchCount() {
    const q = searchInput.value.trim();
    searchCountEl.textContent = !q ? '' : searchCount ? `${searchIndex + 1} of ${searchCount}` : 'no matches';
    searchBox.classList.toggle('none', !!q && !searchCount);
  }
  function runSearch() {
    if (!searchOps) { return; }
    const q = searchInput.value.trim();
    searchOps.clear();
    searchCount = q ? searchOps.run(q, { detail: searchDetail.checked }) : 0;
    searchIndex = searchCount ? 0 : -1;
    if (searchCount) { searchOps.show(0); }
    updateSearchCount();
  }
  function stepSearch(delta) {
    if (!searchCount) { return; }
    searchIndex = (searchIndex + delta + searchCount) % searchCount;
    searchOps.show(searchIndex);
    updateSearchCount();
  }
  function openSearch() {
    if (!searchOps) { return; }
    searchBox.hidden = false;
    searchInput.focus();
    searchInput.select();
    runSearch();
  }
  function closeSearch() {
    searchBox.hidden = true;
    if (searchOps) { searchOps.clear(); }
    searchCount = 0; searchIndex = -1;
  }
  searchInput.addEventListener('input', runSearch);
  searchDetail.addEventListener('change', runSearch);
  $('#searchClose').addEventListener('click', closeSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); stepSearch(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); searchInput.blur(); }
  });
  window.addEventListener('keydown', (e) => {
    if (!searchOps) { return; }
    const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA');
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openSearch(); }
    else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); openSearch(); }
  });
  // after a re-render (drag, purpose toggle) re-apply an open search
  function afterRenderSearch() {
    btnSearch.hidden = !searchOps;
    if (searchBox.hidden) { return; }
    if (searchOps) { runSearch(); } else { closeSearch(); }
  }

  // ---------------------------------------------------------------- titlebar buttons

  const btnTarget = $('#btnTarget');
  function updateTargetBtn() {
    if (!btnTarget) { return; }
    btnTarget.textContent = openTarget === 'main' ? 'refs → code window' : 'refs → this window';
  }
  if (btnTarget) {
    btnTarget.addEventListener('click', () => {
      openTarget = openTarget === 'main' ? 'here' : 'main';
      updateTargetBtn();
    });
    updateTargetBtn();
  }
  const btnResetView = $('#btnResetView');
  if (btnResetView) {
    btnResetView.addEventListener('click', () => { if (activeOps && activeOps.reset) { activeOps.reset(); } });
  }

  // ---------------------------------------------------------------- titlebar dropdowns
  // One-click actions and the zoom setting live in popovers so the titlebar
  // stays readable. Toggles (refs target) and the version picker stay inline.

  const openPopovers = [];
  function wireMenu(buttonSel, popSel) {
    const button = $(buttonSel), pop = $(popSel);
    if (!button || !pop) { return null; }
    openPopovers.push(pop);
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasHidden = pop.hidden;
      openPopovers.forEach((p) => { p.hidden = true; });
      pop.hidden = !wasHidden;
    });
    pop.addEventListener('click', (e) => e.stopPropagation());
    return pop;
  }
  const actionsPop = wireMenu('#btnActions', '#actionsPop');
  const zoomPop = wireMenu('#btnZoom', '#zoomPop');
  document.addEventListener('click', () => { openPopovers.forEach((p) => { p.hidden = true; }); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { openPopovers.forEach((p) => { p.hidden = true; }); }
  });
  // Picking an action closes its menu.
  if (actionsPop) {
    actionsPop.querySelectorAll('.tmenu-item').forEach((item) => {
      item.addEventListener('click', () => { actionsPop.hidden = true; });
    });
  }

  // Zoom sensitivity: a percentage of the default rate, persisted per user.
  const ZOOM_KEY = 'jarbobo.zoomSensitivity';
  const ZOOM_DEFAULT = 100;
  function readZoomSensitivity() {
    try {
      const stored = Number(localStorage.getItem(ZOOM_KEY));
      if (Number.isFinite(stored) && stored >= 25 && stored <= 400) { return stored; }
    } catch (_) { /* storage unavailable in some webview hosts */ }
    return ZOOM_DEFAULT;
  }
  zoomSensitivity = readZoomSensitivity();
  const zoomRange = $('#zoomRange'), zoomValue = $('#zoomValue'), zoomReset = $('#zoomReset');
  function paintZoom() {
    if (zoomRange) { zoomRange.value = String(zoomSensitivity); }
    if (zoomValue) { zoomValue.textContent = `${zoomSensitivity}%`; }
  }
  function setZoomSensitivity(value) {
    zoomSensitivity = Math.min(400, Math.max(25, Math.round(value)));
    try { localStorage.setItem(ZOOM_KEY, String(zoomSensitivity)); } catch (_) { /* ignore */ }
    paintZoom();
  }
  if (zoomRange) { zoomRange.addEventListener('input', () => setZoomSensitivity(Number(zoomRange.value))); }
  if (zoomReset) {
    zoomReset.addEventListener('click', () => {
      setZoomSensitivity(ZOOM_DEFAULT);
      if (zoomPop) { zoomPop.hidden = true; }
    });
  }
  paintZoom();
  const verSel = $('#verSel');
  if (verSel) {
    verSel.addEventListener('change', () => {
      if (currentDiagram && currentDiagram._id) {
        vscodeApi.postMessage({ type: 'loadVersion', id: currentDiagram._id, version: Number(verSel.value) });
      }
    });
  }

  const btnResetLayout = $('#btnResetLayout');
  if (btnResetLayout) {
    btnResetLayout.addEventListener('click', () => {
      if (!currentDiagram) { return; }
      if (currentDiagram._layout) {
        delete currentDiagram._layout; // discard saved rearrangement, recompute + persist
        vscodeApi.postMessage({ type: 'layout', positions: null });
      }
      render(currentDiagram);
    });
  }

  // Swap x/y of every element's position and persist it like a drag would,
  // so the transposed arrangement survives reopen and carries into edits.
  const btnTranspose = $('#btnTranspose');
  if (btnTranspose) {
    btnTranspose.addEventListener('click', () => {
      if (!currentDiagram) { return; }
      if (currentDiagram.type === 'graph' && window.__cy) {
        const cy = window.__cy;
        const positions = {};
        cy.nodes().forEach((n) => {
          if (n.isParent()) { return; }
          const p = n.position();
          positions[n.id()] = { x: p.y, y: p.x };
        });
        // t along an edge is orientation-independent, so transposing the nodes
        // keeps label placements valid — carry edgeLabels through unchanged.
        const prev = normalizeLayout(currentDiagram._layout) || emptyLayout();
        const env = { v: LAYOUT_V, nodes: positions, edgeLabels: prev.edgeLabels || {} };
        currentDiagram._layout = env;
        vscodeApi.postMessage({ type: 'layout', positions: env });
        vscodeApi.setState({ diagram: currentDiagram });
        render(currentDiagram); // re-render so the preset layout + label offsets follow
      } else if (currentDiagram.type === 'class' && lastClassPositions) {
        const positions = {};
        for (const id in lastClassPositions) {
          positions[id] = { x: lastClassPositions[id].y, y: lastClassPositions[id].x };
        }
        const prev = normalizeLayout(currentDiagram._layout) || emptyLayout();
        const env = { v: LAYOUT_V, nodes: positions, edgeLabels: prev.edgeLabels || {} };
        currentDiagram._layout = env;
        vscodeApi.postMessage({ type: 'layout', positions: env });
        render(currentDiagram);
      }
    });
  }

  // Set briefly after a drag so the trailing click doesn't open the detail panel.
  let suppressClick = false;

  // Sequence focus: the message being traced. renderSequence sets seqFocus
  // ({ step(delta), clear() }); it is null for other diagram types. The
  // focused index survives re-renders of the same diagram (e.g. after a drag).
  let seqFocus = null;
  let seqFocusState = { diagram: null, index: null };
  const focusHint = document.createElement('div');
  focusHint.id = 'focusHint';
  focusHint.hidden = true;
  document.body.appendChild(focusHint);

  window.addEventListener('keydown', (e) => {
    if (!seqFocus || e.metaKey || e.ctrlKey || e.altKey) { return; }
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') { return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'j') { e.preventDefault(); seqFocus.step(1); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'k') { e.preventDefault(); seqFocus.step(-1); }
    else if (e.key === 'Escape') { seqFocus.clear(); }
  });
  // a click on empty canvas ends focus (element clicks stop propagation)
  stage.addEventListener('click', () => { if (seqFocus && !suppressClick) { seqFocus.clear(); } });

  // Click policy: the side panel whenever there is an explanation or code to
  // show (it renders each ref's code, and has "Go to source"), else open url.
  // cmd/ctrl+click (opts.direct) skips the panel and opens the code reference immediately.
  function interact(item, label, kind, opts) {
    if (!item || suppressClick) { return; }
    const refs = getRefs(item);
    if (opts && opts.direct) {
      // cmd/ctrl+click: jump to the PRIMARY (first) reference, but highlight
      // EVERY ref's ranges — a collapsed call chain lights up hop by hop as
      // the user follows it through the files
      if (refs.length) { openRef(refs[0], refs); return; }
      if (item.href) { vscodeApi.postMessage({ type: 'openUrl', url: item.href }); return; }
    }
    if (item.detail || refs.length) { openDetail(item, label, kind); }
    else if (item.href) { vscodeApi.postMessage({ type: 'openUrl', url: item.href }); }
    else if (item.tooltip) { openDetail(item, label, kind); }
  }
  function isInteractive(item) {
    return !!(item && (item.tooltip || item.detail || item.file || item.href || (item.refs && item.refs.length)));
  }

  function bindSvgItem(el, item, label, kind) {
    if (!item) { return; }
    // tag for the exporter (interactive HTML): maps this SVG element to its item
    const exIdx = registerExportItem(item, label, kind);
    if (exIdx >= 0) { el.setAttribute('data-jb', String(exIdx)); }
    el.addEventListener('mousemove', (e) => showItemTip(item, e.clientX, e.clientY, e.ctrlKey));
    // glow applies to node/edge-like elements only, not group containers
    const glows = kind !== 'lane' && kind !== 'track';
    el.addEventListener('mouseenter', () => {
      if (glows) { el.style.filter = 'drop-shadow(0 0 4px ' + (item.color || ACCENT) + ')'; }
    });
    el.addEventListener('mouseleave', () => { el.style.filter = ''; hideTip(); });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      interact(item, label, kind, { direct: e.metaKey || e.ctrlKey });
    });
    if (isInteractive(item)) { el.classList.add('clickable'); }
  }

  // ---------------------------------------------------------------- pan / zoom controls
  // right-drag = pan · scroll = vertical pan · shift+scroll = horizontal pan · cmd/ctrl+scroll = zoom

  let activeOps = null; // { pan(dx,dy), zoom(factor, clientX, clientY) } — set by each renderer

  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('wheel', (e) => {
    if (!activeOps) { return; }
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) {
      // Sensitivity scales the exponent: 100% keeps the original 1.0015 rate,
      // and a touchscreen pinch (which arrives here as ctrl+wheel) can be
      // tuned to taste from the titlebar's zoom menu.
      activeOps.zoom(Math.pow(1.0015, -e.deltaY * (zoomSensitivity / 100)), e.clientX, e.clientY);
    } else if (e.shiftKey) {
      activeOps.pan(-(e.deltaY || e.deltaX), 0);
    } else {
      activeOps.pan(-e.deltaX, -e.deltaY);
    }
  }, { passive: false });
  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 2 || !activeOps) { return; }
    e.preventDefault();
    const move = (me) => activeOps && activeOps.pan(me.movementX, me.movementY);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  function makeSvgViewport(svg) {
    // Zoom/pan via an SVG attribute transform on a wrapper <g>, NOT a CSS transform
    // on the <svg>: CSS transforms rasterize the layer once and scale the bitmap
    // (fuzzy text); attribute transforms re-render vectors crisply at every scale.
    const natW = Number(svg.getAttribute('width')) || 0;
    // stash the natural (content) size so the exporter can rebuild a fitted,
    // un-panned copy of this SVG later (width/height get overwritten below)
    svg.dataset.natw = String(natW);
    svg.dataset.nath = String(Number(svg.getAttribute('height')) || 0);
    const vp = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    while (svg.firstChild) { vp.appendChild(svg.firstChild); }
    svg.appendChild(vp);
    svg.removeAttribute('viewBox');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    let k = 1;
    // start clear of the component card when it is open on the left
    const inset = cardPanel.hidden ? 0 : cardPanel.offsetWidth;
    const room = stage.clientWidth - inset;
    const tx0 = inset + (natW < room ? (room - natW) / 2 : 0);
    let tx = tx0, ty = 0;
    const apply = () => { vp.setAttribute('transform', `translate(${tx} ${ty}) scale(${k})`); };
    apply();
    return {
      pan(dx, dy) { tx += dx; ty += dy; apply(); },
      zoom(f, cx, cy) {
        const nk = Math.min(8, Math.max(0.15, k * f));
        f = nk / k;
        const r = stage.getBoundingClientRect();
        const px = cx - r.left, py = cy - r.top;
        tx = px - (px - tx) * f;
        ty = py - (py - ty) * f;
        k = nk;
        apply();
      },
      reset() { tx = tx0; ty = 0; k = 1; apply(); },
      getZoom() { return k; },
      getState() { return { tx, ty, k }; },
      setState(s) { tx = s.tx; ty = s.ty; k = s.k; apply(); },
    };
  }

  // ---------------------------------------------------------------- export
  // Visual formats (SVG / PNG / interactive HTML) are produced HERE because they
  // need the live rendered geometry. Text formats (mermaid/dot/tikz/drawio/json)
  // are produced by the extension from the spec. The export button posts
  // {type:'export'}; the extension shows a format picker and, for visual formats,
  // asks us back via {type:'exportRender', format, reqId}; we reply with
  // {type:'exportResult', reqId, ok, data, encoding, mime}.

  let exportReg = [];              // index -> {item,label,kind}; drives data-jb tags
  let exportReqCounter = 0;
  const exportSnipPending = new Map();

  function registerExportItem(item, label, kind) {
    if (!item) { return -1; }
    exportReg.push({ item, label: label || '', kind: kind || '' });
    return exportReg.length - 1;
  }

  const escX = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function clipToBox(c, toward, box) {
    const dx = toward.x - c.x, dy = toward.y - c.y;
    if (!dx && !dy) { return { x: c.x, y: c.y }; }
    const hw = box.w / 2, hh = box.h / 2;
    const sx = dx ? hw / Math.abs(dx) : Infinity;
    const sy = dy ? hh / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy);
    return { x: c.x + dx * s, y: c.y + dy * s };
  }

  function arrowHeadSvg(x1, y1, x2, y2, color, type) {
    const a = Math.atan2(y2 - y1, x2 - x1);
    const L = 11, Wd = 5;
    const ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
    const bx = x2 - L * ux, by = y2 - L * uy;
    const ax1 = (bx + Wd * px).toFixed(1), ay1 = (by + Wd * py).toFixed(1);
    const ax2 = (bx - Wd * px).toFixed(1), ay2 = (by - Wd * py).toFixed(1);
    if (type === 'vee') {
      return `<polyline points="${ax1},${ay1} ${x2.toFixed(1)},${y2.toFixed(1)} ${ax2},${ay2}" fill="none" stroke="${escX(color)}" stroke-width="1.8"/>`;
    }
    return `<polygon points="${x2.toFixed(1)},${y2.toFixed(1)} ${ax1},${ay1} ${ax2},${ay2}" fill="${escX(color)}"/>`;
  }

  function edgeLabelSvg(mx, my, text, color) {
    const t = String(text);
    const w = Math.max(12, t.length * 6.5) + 6, h = 16;
    return `<rect x="${(mx - w / 2).toFixed(1)}" y="${(my - h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="3" fill="${escX(BG)}" fill-opacity="0.92" stroke="${escX(color)}" stroke-width="1"/>`
      + `<text x="${mx.toFixed(1)}" y="${(my + 4).toFixed(1)}" text-anchor="middle" font-size="11" font-family="sans-serif" fill="${escX(FG)}">${escX(t)}</text>`;
  }

  function nodeShapeSvg(shape, cx, cy, w, h, color) {
    const common = `fill="${escX(color)}" fill-opacity="0.18" stroke="${escX(color)}" stroke-width="1.5"`;
    const x = cx - w / 2, y = cy - h / 2;
    const pts = (arr) => arr.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ');
    switch (shape) {
      case 'ellipse':
        return `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${(w / 2).toFixed(1)}" ry="${(h / 2).toFixed(1)}" ${common}/>`;
      case 'diamond':
        return `<polygon points="${pts([[cx, y], [x + w, cy], [cx, y + h], [x, cy]])}" ${common}/>`;
      case 'hexagon': {
        const q = w / 4;
        return `<polygon points="${pts([[x + q, y], [x + w - q, y], [x + w, cy], [x + w - q, y + h], [x + q, y + h], [x, cy]])}" ${common}/>`;
      }
      case 'barrel': // cylinder
        return `<path d="M${x.toFixed(1)},${(y + 6).toFixed(1)} a${(w / 2).toFixed(1)},6 0 0 1 ${w.toFixed(1)},0 v${(h - 12).toFixed(1)} a${(w / 2).toFixed(1)},6 0 0 1 ${(-w).toFixed(1)},0 z" ${common}/>`
          + `<path d="M${x.toFixed(1)},${(y + 6).toFixed(1)} a${(w / 2).toFixed(1)},6 0 0 0 ${w.toFixed(1)},0" fill="none" stroke="${escX(color)}" stroke-width="1.5"/>`;
      case 'round-rectangle':
      default:
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="6" ${common}/>`;
    }
  }

  function nodeLabelSvg(label, cx, cy) {
    const lines = String(label == null ? '' : label).split('\n');
    const lh = 15;
    const startY = cy - (lines.length - 1) * lh / 2 + 4;
    return lines.map((ln, i) => `<text x="${cx.toFixed(1)}" y="${(startY + i * lh).toFixed(1)}" text-anchor="middle" font-size="12" font-family="sans-serif" fill="${escX(FG)}">${escX(ln)}</text>`).join('');
  }

  // Synthesise an SVG for the cytoscape graph from its live node/edge geometry.
  function buildGraphSvg(noBg) {
    const cy = window.__cy;
    if (!cy) { throw new Error('graph not ready'); }
    exportReg = []; // the graph path doesn't use bindSvgItem — own the registry
    const PAD = 30;
    const bb = { ...cy.elements().boundingBox() };
    // group labels and descriptions stand above their box: grow the bounds
    // to hold them (the description is at least GROUP_DESC_MIN_W wide)
    cy.nodes('[descr]').forEach((n) => {
      const b = n.boundingBox({ includeLabels: false });
      const w = Math.max(b.w, GROUP_DESC_MIN_W);
      bb.y1 = Math.min(bb.y1, b.y1 - GROUP_DESC_H - 20);
      bb.x1 = Math.min(bb.x1, b.x1 + (b.w - w) / 2);
      bb.x2 = Math.max(bb.x2, b.x1 + (b.w + w) / 2);
    });
    bb.w = bb.x2 - bb.x1; bb.h = bb.y2 - bb.y1;
    const W = Math.max(1, Math.ceil(bb.w + PAD * 2));
    const H = Math.max(1, Math.ceil(bb.h + PAD * 2));
    const ox = PAD - bb.x1, oy = PAD - bb.y1;
    // standalone SVG/PNG get a baked-in background; the interactive HTML skips
    // it (the page supplies the color) so panning doesn't drag a visible rect
    const P = noBg ? [] : [`<rect x="0" y="0" width="${W}" height="${H}" fill="${escX(BG)}"/>`];
    cy.nodes().forEach((n) => {
      if (!n.isParent()) { return; }
      const b = n.boundingBox(n.data('descr') ? { includeLabels: false } : undefined);
      const color = n.data('color') || MUTED;
      P.push(`<rect x="${(b.x1 + ox).toFixed(1)}" y="${(b.y1 + oy).toFixed(1)}" width="${b.w.toFixed(1)}" height="${b.h.toFixed(1)}" rx="8" fill="${escX(color)}" fill-opacity="0.06" stroke="${escX(color)}" stroke-width="1" stroke-dasharray="4 3"/>`);
      const descr = n.data('descr');
      if (descr) {
        // label above the box, then up to two lines of description
        const lines = wrapText(descr, Math.max(GROUP_DESC_MIN_W, b.w), PURPOSE_FONT).slice(0, 2);
        const top = b.y1 + oy - GROUP_DESC_H - 2;
        P.push(`<text x="${(b.x1 + ox + b.w / 2).toFixed(1)}" y="${(top - 4).toFixed(1)}" text-anchor="middle" font-size="11" font-family="sans-serif" fill="${escX(FG)}">${escX(n.data('label'))}</text>`);
        lines.forEach((ln, i) => {
          P.push(`<text x="${(b.x1 + ox + b.w / 2).toFixed(1)}" y="${(top + 10 + i * PURPOSE_LINE).toFixed(1)}" text-anchor="middle" font-size="${PURPOSE_FONT_PX}" font-style="italic" font-family="sans-serif" fill="${escX(FG)}" fill-opacity="0.62">${escX(ln)}</text>`);
        });
      } else {
        P.push(`<text x="${(b.x1 + ox + b.w / 2).toFixed(1)}" y="${(b.y1 + oy + 13).toFixed(1)}" text-anchor="middle" font-size="11" font-family="sans-serif" fill="${escX(FG)}">${escX(n.data('label'))}</text>`);
      }
    });
    cy.edges().not('.kHidden').forEach((e) => {
      const s = e.source().position(), t = e.target().position();
      // clip to the drawn box: outer dims include the node style's padding
      const p1 = clipToBox(s, t, { w: e.source().outerWidth(), h: e.source().outerHeight() });
      const p2 = clipToBox(t, s, { w: e.target().outerWidth(), h: e.target().outerHeight() });
      const color = e.data('color') || MUTED;
      const ls = e.data('lstyle');
      const dash = ls === 'dashed' ? ' stroke-dasharray="6 4"' : ls === 'dotted' ? ' stroke-dasharray="2 3"' : '';
      const x1 = p1.x + ox, y1 = p1.y + oy, x2 = p2.x + ox, y2 = p2.y + oy;
      const idx = registerExportItem(e.data('_item'), e.data('label') || '', 'edge');
      let g = `<g${idx >= 0 ? ` data-jb="${idx}"` : ''}>`;
      g += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${escX(color)}" stroke-width="1.8"${dash}/>`;
      const arrow = e.data('arrow');
      if (arrow && arrow !== 'none') { g += arrowHeadSvg(x1, y1, x2, y2, color, arrow); }
      const lbl = e.data('label');
      if (lbl) { g += edgeLabelSvg((x1 + x2) / 2, (y1 + y2) / 2, lbl, color); }
      g += '</g>';
      P.push(g);
    });
    cy.nodes().forEach((n) => {
      if (n.isParent()) { return; }
      const pos = n.position();
      // outerWidth/outerHeight = drawn box (style width + padding + border);
      // n.width() alone is the inner size and exported nodes came out small
      const w = n.outerWidth(), h = n.outerHeight();
      const cx = pos.x + ox, cyy = pos.y + oy;
      const idx = registerExportItem(n.data('_item'), n.data('label') || '', 'node');
      let g = `<g${idx >= 0 ? ` data-jb="${idx}"` : ''}>`;
      g += nodeShapeSvg(n.data('shape') || 'round-rectangle', cx, cyy, w, h, n.data('color') || ACCENT);
      // wrap to the inner width, mirroring cytoscape's text-max-width: data(w)
      const purposeH = n.data('purposeH') || 0;
      const labelCy = purposeH ? cyy - (purposeH + PURPOSE_GAP) / 2 : cyy;
      g += nodeLabelSvg(wrapText(n.data('label'), n.width(), '12px -apple-system, sans-serif').join('\n'), cx, labelCy);
      if (purposeH) {
        const top = cyy + n.height() / 2 - purposeH;
        (n.data('pLines') || []).forEach((ln, i) => {
          g += `<text x="${cx.toFixed(1)}" y="${(top + 10 + i * PURPOSE_LINE).toFixed(1)}" text-anchor="middle" font-size="${PURPOSE_FONT_PX}" font-family="sans-serif" fill="${escX(FG)}" fill-opacity="0.62">${escX(ln)}</text>`;
        });
      }
      g += '</g>';
      P.push(g);
    });
    const str = '<?xml version="1.0" encoding="UTF-8"?>\n'
      + `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${P.join('')}</svg>`;
    return { str, W, H };
  }

  // SVG-native types (sequence/class/swimlane/timeline): rebuild a fitted,
  // un-panned copy of the live SVG, with a background and its natural size.
  function buildNativeSvg(noBg) {
    const live = stage.querySelector('svg');
    if (!live) { throw new Error('nothing to export yet'); }
    const W = Number(live.dataset.natw) || 800, H = Number(live.dataset.nath) || 600;
    const clone = live.cloneNode(true);
    const vp = clone.querySelector('g');
    if (vp) { vp.removeAttribute('transform'); }
    clone.setAttribute('width', String(W));
    clone.setAttribute('height', String(H));
    clone.setAttribute('viewBox', `0 0 ${W} ${H}`);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (!noBg) { clone.insertAdjacentHTML('afterbegin', `<rect x="0" y="0" width="${W}" height="${H}" fill="${escX(BG)}"/>`); }
    const str = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
    return { str, W, H };
  }

  function buildExportSvg(noBg) {
    if (!currentDiagram) { throw new Error('no diagram'); }
    return currentDiagram.type === 'graph' ? buildGraphSvg(noBg) : buildNativeSvg(noBg);
  }

  async function buildExportPng(scale) {
    scale = scale || 2;
    const { str, W, H } = buildExportSvg();
    const img = new Image();
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str);
    await new Promise((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('could not rasterize SVG')); img.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(W * scale));
    canvas.height = Math.max(1, Math.round(H * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = BG; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  }

  // fetch code snippets via the extension (same round-trip the detail panel uses,
  // but on a negative reqId so it never collides with the live panel's request)
  function fetchExportSnippets(refs) {
    return new Promise((resolve) => {
      const reqId = -(++exportReqCounter);
      exportSnipPending.set(reqId, resolve);
      vscodeApi.postMessage({ type: 'snippets', reqId, refs });
      setTimeout(() => { if (exportSnipPending.has(reqId)) { exportSnipPending.delete(reqId); resolve([]); } }, 8000);
    });
  }

  function collectExportCss() {
    let out = '';
    for (let i = 0; i < document.styleSheets.length; i++) {
      try {
        const rules = document.styleSheets[i].cssRules;
        for (let j = 0; j < rules.length; j++) { out += rules[j].cssText + '\n'; }
      } catch (err) { /* cross-origin sheet — skip */ }
    }
    return out;
  }

  async function buildExportHtml(providedCss) {
    const { str: svgStr } = buildExportSvg(true); // page supplies the background
    const wanted = [];
    const allRefs = [];
    exportReg.forEach((entry, idx) => {
      const { item, label, kind } = entry;
      const refs = getRefs(item);
      if (!item.detail && !item.tooltip && !refs.length && !item.href) { return; }
      const slots = refs.map((r) => { const slot = allRefs.length; allRefs.push(r); return { slot, r }; });
      wanted.push({ idx, label, kind, detail: item.detail || '', tooltip: item.tooltip || '', href: item.href || '', slots });
    });
    const results = allRefs.length ? await fetchExportSnippets(allRefs) : [];
    const ITEMS = {};
    wanted.forEach((it) => {
      const refsHtml = it.slots.map(({ slot, r }) => {
        const pre = document.createElement('pre');
        pre.className = 'refCode';
        renderSnippet(pre, results[slot]);
        const loc = refLoc(r);
        const base = (r.file.split('/').pop() || r.file);
        return `<div class="refItem"><div class="refHead">`
          + (r.label ? `<span class="refRole">${escHtml(r.label)}</span>` : '')
          + `<span class="refLoc">${escHtml(base + (loc ? ':' + loc : ''))}</span></div>`
          + (r.note ? `<div class="refNote">${escHtml(r.note)}</div>` : '')
          + pre.outerHTML + `</div>`;
      }).join('');
      ITEMS[it.idx] = { label: it.label, kind: it.kind, detail: it.detail, tooltip: it.tooltip, href: it.href, refsHtml };
    });
    const itemsJson = JSON.stringify(ITEMS).replace(/</g, '\\u003c');
    return exportHtmlDoc(currentDiagram, svgStr, itemsJson, providedCss || collectExportCss());
  }

  function exportHtmlDoc(d, svgStr, itemsJson, css) {
    const rootVars = ':root{--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#d4d4d4;--vscode-descriptionForeground:#9d9d9d;'
      + "--vscode-font-family:-apple-system,'Segoe UI',sans-serif;--vscode-panel-border:#3c3c3c;--vscode-editorWidget-background:#252526;"
      + '--vscode-editorHoverWidget-background:#252526;--vscode-editorHoverWidget-border:#454545;--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;'
      + '--vscode-charts-blue:#4e94ce;--vscode-charts-foreground:#d4d4d4;--vscode-charts-green:#89d185;--vscode-charts-orange:#d18616;--vscode-charts-purple:#b180d7;--vscode-charts-yellow:#cca700;}'
      + '@media (prefers-color-scheme:light){:root{--vscode-editor-background:#fff;--vscode-editor-foreground:#1e1e1e;--vscode-descriptionForeground:#616161;--vscode-panel-border:#e0e0e0;--vscode-editorWidget-background:#f3f3f3;--vscode-editorHoverWidget-background:#f3f3f3;--vscode-editorHoverWidget-border:#c8c8c8;--vscode-charts-foreground:#1e1e1e;}}';
    const layout = 'body{margin:0;font-family:var(--vscode-font-family);background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);}'
      + '#jbBar{padding:8px 14px;border-bottom:1px solid var(--vscode-panel-border);display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;}'
      + '#jbBar h1{font-size:14px;margin:0;font-weight:600;}#jbBar .sub{color:var(--vscode-descriptionForeground);font-size:12px;}'
      + '#jbBar .spacer{flex:1;}#jbReset{font:inherit;font-size:12px;padding:2px 10px;border:1px solid var(--vscode-panel-border);border-radius:4px;background:none;color:inherit;cursor:pointer;}'
      + `#jbWrap{display:flex;height:calc(100vh - 42px);}#jbSvgBox{flex:1;overflow:hidden;background:${escX(BG)};}`
      + '#jbSvgBox svg{display:block;width:100%;height:100%;user-select:none;}'
      + '#jbSvgBox [data-jb]{cursor:pointer;}#jbSvgBox [data-jb]:hover{filter:brightness(1.25);}'
      + '#jbPanel{width:380px;max-width:45vw;border-left:1px solid var(--vscode-panel-border);overflow:auto;padding:14px 16px;background:var(--vscode-editorWidget-background);}'
      + '#jbPanel[hidden]{display:none;}#jbPanel h2{font-size:15px;margin:.2em 0 .5em;}#jbClose{float:right;border:none;background:none;color:inherit;cursor:pointer;font-size:15px;}'
      + '#jbPanel .kind{color:var(--vscode-descriptionForeground);font-size:11px;text-transform:uppercase;letter-spacing:.5px;}'
      + '#jbPanel .jbDetail{white-space:pre-wrap;font-family:inherit;background:none;border:none;padding:0;margin:.4em 0;}#jbHint{color:var(--vscode-descriptionForeground);font-size:12px;padding:8px 0;}';
    const script = 'const ITEMS=' + itemsJson + ';'
      + 'function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML;}'
      + 'function showItem(idx){var it=ITEMS[idx];if(!it)return;var p=document.getElementById("jbPanel");var h="<button id=\\"jbClose\\">\\u2715</button>";'
      + 'if(it.kind)h+="<div class=\\"kind\\">"+esc(it.kind)+"</div>";h+="<h2>"+esc(it.label)+"</h2>";'
      + 'if(it.detail)h+="<pre class=\\"jbDetail\\">"+esc(it.detail)+"</pre>";else if(it.tooltip)h+="<pre class=\\"jbDetail\\">"+esc(it.tooltip)+"</pre>";'
      + 'if(it.href)h+="<div><a href=\\""+esc(it.href)+"\\" target=\\"_blank\\" rel=\\"noopener\\">"+esc(it.href)+"</a></div>";'
      + 'if(it.refsHtml)h+=it.refsHtml;else h+="<div id=\\"jbHint\\">No code references.</div>";'
      + 'p.innerHTML=h;p.hidden=false;document.getElementById("jbClose").onclick=function(){p.hidden=true;};}'
      + 'document.querySelectorAll("#jbSvgBox [data-jb]").forEach(function(el){var idx=el.getAttribute("data-jb");if(!ITEMS[idx])return;'
      + 'el.addEventListener("click",function(e){e.stopPropagation();showItem(idx);});'
      // native hover tooltips from the element's jarbobo tooltip
      + 'var it=ITEMS[idx];if(it&&it.tooltip){var t=document.createElementNS("http://www.w3.org/2000/svg","title");t.textContent=it.tooltip;el.appendChild(t);}});'
      // pan/zoom viewport, mirroring the panel: scroll = pan, shift+scroll =
      // horizontal pan, ctrl/cmd+scroll = zoom at cursor, drag empty space = pan
      + '(function(){var box=document.getElementById("jbSvgBox");var svg=box.querySelector("svg");if(!svg)return;'
      + 'var W=+svg.getAttribute("width")||800,H=+svg.getAttribute("height")||600;'
      + 'var vp=document.createElementNS("http://www.w3.org/2000/svg","g");while(svg.firstChild){vp.appendChild(svg.firstChild);}svg.appendChild(vp);'
      + 'svg.removeAttribute("viewBox");svg.setAttribute("width","100%");svg.setAttribute("height","100%");'
      + 'var k=1,tx=0,ty=0;function apply(){vp.setAttribute("transform","translate("+tx+" "+ty+") scale("+k+")");}'
      + 'function fit(){var r=box.getBoundingClientRect();k=Math.min(1,(r.width-32)/W,(r.height-32)/H);if(!(k>0))k=1;tx=(r.width-W*k)/2;ty=(r.height-H*k)/2;apply();}'
      + 'box.addEventListener("wheel",function(e){e.preventDefault();'
      + 'if(e.ctrlKey||e.metaKey){var f=Math.pow(1.0015,-e.deltaY);var nk=Math.min(8,Math.max(0.1,k*f));f=nk/k;var r=box.getBoundingClientRect();var px=e.clientX-r.left,py=e.clientY-r.top;tx=px-(px-tx)*f;ty=py-(py-ty)*f;k=nk;apply();}'
      + 'else if(e.shiftKey){tx-=(e.deltaY||e.deltaX);apply();}else{tx-=e.deltaX;ty-=e.deltaY;apply();}},{passive:false});'
      + 'var drag=null;box.addEventListener("mousedown",function(e){if(e.button===2||e.button===1||(e.button===0&&e.target===svg)){drag={x:e.clientX,y:e.clientY};e.preventDefault();}});'
      + 'window.addEventListener("mousemove",function(e){if(!drag)return;tx+=e.clientX-drag.x;ty+=e.clientY-drag.y;drag={x:e.clientX,y:e.clientY};apply();});'
      + 'window.addEventListener("mouseup",function(){drag=null;});'
      + 'box.addEventListener("contextmenu",function(e){e.preventDefault();});'
      + 'var rb=document.getElementById("jbReset");if(rb){rb.onclick=fit;}'
      + 'window.addEventListener("resize",fit);fit();})();';
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      + `<title>${escX(d.title || 'Jarbobo diagram')}</title>`
      + `<style>${rootVars}${css}${layout}</style></head><body>`
      + `<div id="jbBar"><h1>${escX(d.title || 'Diagram')}</h1><span class="sub">${escX(d.subtitle || '')}${d.subtitle ? ' · ' : ''}exported from Jarbobo — click an element for its code · scroll = pan · ctrl/cmd+scroll = zoom · drag = pan</span><span class="spacer"></span><button id="jbReset" title="Reset pan &amp; zoom">reset view</button></div>`
      + `<div id="jbWrap"><div id="jbSvgBox">${svgStr}</div><aside id="jbPanel" hidden></aside></div>`
      + `<script>${script}</script></body></html>`;
  }

  async function handleExportRender(msg) {
    try {
      let data, encoding = 'utf8', mime;
      if (msg.format === 'svg') { data = buildExportSvg().str; mime = 'image/svg+xml'; }
      else if (msg.format === 'png') { data = (await buildExportPng()).split(',')[1]; encoding = 'base64'; mime = 'image/png'; }
      else if (msg.format === 'html') { data = await buildExportHtml(msg.css); mime = 'text/html'; }
      else { throw new Error('unknown visual format: ' + msg.format); }
      vscodeApi.postMessage({ type: 'exportResult', reqId: msg.reqId, ok: true, format: msg.format, data, encoding, mime });
    } catch (err) {
      vscodeApi.postMessage({ type: 'exportResult', reqId: msg.reqId, ok: false, format: msg.format, error: String((err && err.message) || err) });
    }
  }

  const btnExport = $('#btnExport');
  if (btnExport) { btnExport.addEventListener('click', () => vscodeApi.postMessage({ type: 'export' })); }

  // ---------------------------------------------------------------- dispatch

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg && msg.type === 'render' && msg.diagram) { render(msg.diagram); }
    else if (msg && msg.type === 'becameVisible') { repaintCanvas(); }
    else if (msg && msg.type === 'exportRender') { handleExportRender(msg); }
    else if (msg && msg.type === 'snippets' && exportSnipPending.has(msg.reqId)) {
      const resolve = exportSnipPending.get(msg.reqId);
      exportSnipPending.delete(msg.reqId);
      resolve(msg.results || []);
    }
    else if (msg && msg.type === 'snippets' && msg.reqId === snippetReq) {
      // code previews for the detail panel's reference list
      (msg.results || []).forEach((res, i) => {
        const pre = document.getElementById('snip-' + msg.reqId + '-' + i);
        if (pre) { renderSnippet(pre, res); }
        // swap in the IMPLIED (re-anchored) line numbers: the file may have
        // drifted since the diagram was drawn, and the display should track it
        const locEl = document.getElementById('refloc-' + msg.reqId + '-' + i);
        if (locEl && res && res.ok) {
          const implied = refLoc({ ranges: res.impliedRanges, line: res.impliedLine });
          if (implied) {
            const base = locEl.textContent.split(':')[0];
            const drifted = locEl.textContent !== base + ':' + implied;
            locEl.textContent = base + ':' + implied;
            if (drifted) { locEl.title = 'moved — the diagram originally referenced other line numbers'; locEl.classList.add('drifted'); }
          }
          if (i === 0 && res.focusLine) {
            const goBtn = document.querySelector('#detailActions button');
            if (goBtn && /^Go to source/.test(goBtn.textContent)) { goBtn.textContent = 'Go to source :' + res.focusLine; }
          }
        }
      });
    }
  });

  // The graph renderer's <canvas> (cytoscape) can go visually blank after
  // the panel was hidden and shown again — the GPU-composited backing store
  // gets evicted while hidden, and canvas content (unlike DOM/SVG) doesn't
  // repaint itself. resize() + forceRender() repaints in place: no rebuild,
  // no lost pan/zoom/selection. SVG diagram types are unaffected and skipped.
  function repaintCanvas() {
    if (window.__cy) {
      window.__cy.resize();
      window.__cy.forceRender();
    }
  }

  function render(d) {
    readTheme();
    hideTip(); closeDetail();
    exportReg = []; // rebuilt as elements bind; indexes the exporter's data-jb tags
    currentDiagram = d;
    vscodeApi.setState({ diagram: d }); // survives window reloads (panel serializer)
    if (verSel) {
      if (d._id && Array.isArray(d._versions) && d._versions.length) {
        verSel.innerHTML = d._versions
          .map((v) => `<option value="${v}"${v === d._version ? ' selected' : ''}>v${v}</option>`)
          .join('');
        verSel.hidden = false;
      } else {
        verSel.hidden = true; // legacy (pre-versioning) diagrams
      }
    }
    // only graph/class have freely arrangeable coordinates to transpose
    if (btnTranspose) { btnTranspose.hidden = !(d.type === 'graph' || d.type === 'class'); }
    activeOps = null;
    seqFocus = null;
    focusHint.hidden = true;
    renderCard(d);
    updatePurposeBtn(d);
    searchOps = null;
    edgeLegend.hidden = true;
    $('#title').textContent = d.title || '';
    $('#title').title = d.title || '';
    const diagramType = {
      graph: 'graph', sequence: 'sequence diagram', class: 'class diagram',
      swimlane: 'swimlane diagram', timeline: 'timeline',
    }[d.type] || d.type;
    $('#subtitle').textContent = d._file ? String(d._file) : diagramType;
    $('#subtitle').title = d._file ? String(d._file) : diagramType;
    stage.innerHTML = '';
    try {
      if (d.type === 'graph') { renderGraph(d); }
      else if (d.type === 'sequence') { renderSequence(d); }
      else if (d.type === 'class') { renderClass(d); }
      else if (d.type === 'swimlane') { renderSwimlane(d); }
      else if (d.type === 'timeline') { renderTimeline(d); }
      else { stage.textContent = 'Unknown diagram type: ' + d.type; }
    } catch (err) {
      stage.textContent = 'Render error: ' + (err && err.message || err);
      console.error(err);
    }
    afterRenderSearch();
  }

  // ================================================================ GRAPH

  function renderGraph(d) {
    const holder = document.createElement('div');
    holder.id = 'cy';
    stage.appendChild(holder);
    if (typeof cytoscape === 'undefined') { stage.textContent = 'cytoscape not loaded'; return; }
    if (typeof cytoscapeDagre !== 'undefined' && !window.__jarboboDagre) {
      cytoscape.use(cytoscapeDagre);
      window.__jarboboDagre = true;
    }

    const shapeMap = { box: 'round-rectangle', ellipse: 'ellipse', diamond: 'diamond', hexagon: 'hexagon', cylinder: 'barrel' };
    // Explicit node dimensions from label measurement. Cytoscape's `width:'label'`
    // is deprecated AND breaks edge rendering under the preset layout (edges
    // project before label-based sizes resolve → invisible edges on reopen).
    const GFONT = '12px -apple-system, sans-serif';
    // A node's purpose is a smaller, muted second block under its label; the
    // node is sized for both and the label shifts up to make room.
    const showPurpose = purposeShown;
    const nodeDims = (label, purpose) => {
      let w = 0, rows = 0;
      String(label).split('\n').forEach((ln) => {
        const lw = tw(ln, GFONT);
        w = Math.max(w, Math.min(lw, 150));
        rows += Math.max(1, Math.ceil(lw / 150));
      });
      const labelH = Math.max(18, rows * 15 + 4);
      if (!purpose) { return { w: Math.max(24, Math.ceil(w) + 6), h: labelH }; }
      const pLines = wrapText(purpose, PURPOSE_MAX_W, PURPOSE_FONT);
      pLines.forEach((ln) => { w = Math.max(w, tw(ln, PURPOSE_FONT)); });
      const purposeH = pLines.length * PURPOSE_LINE;
      return { w: Math.max(24, Math.ceil(w) + 6), h: labelH + PURPOSE_GAP + purposeH, purposeH, pLines };
    };
    const els = [];
    (d.groups || []).forEach((g) => els.push({
      data: {
        id: g.id, label: g.label || g.id, isGroup: 1, color: g.color || MUTED, gdesc: g.description || '',
        // the description sits between the label and the box (two lines at most)
        ...(showPurpose && g.description ? { descr: g.description, lmy: -4 - GROUP_DESC_H } : {}),
      },
    }));
    (d.nodes || []).forEach((n) => {
      const label = n.label || n.id;
      const purpose = showPurpose ? n.purpose : undefined;
      const dims = nodeDims(label, purpose);
      els.push({
        data: {
          id: n.id, label, parent: n.group || undefined,
          shape: shapeMap[n.shape] || 'round-rectangle',
          w: dims.w, h: dims.h,
          color: n.color || ACCENT, _item: n,
          ...(purpose ? { purpose, pLines: dims.pLines, purposeH: dims.purposeH, lmy: -(dims.purposeH + PURPOSE_GAP) / 2 } : {}),
        },
      });
    });
    (d.edges || []).forEach((e, i) => els.push({
      data: {
        id: '__e' + i, source: e.from, target: e.to, label: e.label || '',
        ekey: edgeKey(e.from, e.to, e.label || ''),
        lstyle: e.style || 'solid',
        arrow: e.arrow === 'open' ? 'vee' : e.arrow === 'none' ? 'none' : 'triangle',
        color: e.color || MUTED, _item: e, mx: 0, my: 0, kind: e.kind || '',
      },
    }));

    const layoutName = d.layout || 'layered';
    const descRoom = showPurpose && (d.groups || []).some((g) => g.description) ? GROUP_DESC_H + 24 : 0;
    // A user-saved arrangement (drag & drop, possibly carried forward from a
    // previous version by an LLM edit) takes precedence over the computed
    // layout. It may be PARTIAL — new nodes added by an edit have no saved
    // position — so unplaced nodes are slotted in near their connected,
    // already-placed neighbors rather than discarding the arrangement.
    const savedLayout = normalizeLayout(d._layout);
    const savedNodes = savedLayout && savedLayout.nodes;
    const saved = savedNodes && (d.nodes || []).some((n) => savedNodes[n.id])
      ? completePositions(d.nodes || [], d.edges || [], savedNodes)
      : null;
    const layout = saved
      ? { name: 'preset', positions: (n) => saved[n.id()], fit: true, padding: 24 }
      : layoutName === 'layered'
        // group descriptions sit above their box, outside what dagre sizes,
        // so leave room for them between neighbours
        ? { name: 'dagre', rankDir: d.direction || 'TB', nodeSep: 40 + descRoom, rankSep: 65 + descRoom, padding: 24 }
        : layoutName === 'force' ? { name: 'cose', padding: 24, animate: false }
        : { name: layoutName, padding: 24 };

    const cy = cytoscape({
      container: holder,
      elements: els,
      layout,
      userZoomingEnabled: false, // zoom/pan handled by the shared stage controls
      // Left-drag on empty space = rubber-band box select (pan stays on
      // right-drag / scroll). With panning off, cytoscape box-selects without
      // needing a modifier key; drag any selected node to move them together.
      userPanningEnabled: false,
      boxSelectionEnabled: true,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            'background-opacity': 0.18,
            'border-color': 'data(color)',
            'border-width': 1.5,
            label: 'data(label)',
            color: FG,
            'font-size': 12,
            'text-valign': 'center',
            'text-halign': 'center',
            'text-wrap': 'wrap',
            'text-max-width': 150,
            padding: 12,
          },
        },
        // scoped so compound parents (no shape/w data) don't trigger mapping warnings
        { selector: 'node[shape]', style: { shape: 'data(shape)' } },
        // Wrap the label to the node's own measured width so short labels like
        // "bank tile (C)" don't spill past the box border (the global 150px cap
        // let text overrun narrow nodes).
        { selector: 'node[w]', style: { width: 'data(w)', height: 'data(h)', 'text-max-width': 'data(w)' } },
        { selector: 'node[purpose]', style: { 'text-margin-y': 'data(lmy)' } },
        {
          selector: ':parent',
          style: {
            shape: 'round-rectangle',
            'background-color': 'data(color)',
            'background-opacity': 0.06,
            'border-color': 'data(color)',
            'border-width': 1,
            'border-style': 'dashed',
            label: 'data(label)',
            color: FG,
            'font-size': 11,
            'text-valign': 'top',
            'text-halign': 'center',
            'text-margin-y': -4,
            padding: 18,
          },
        },
        { selector: ':parent[descr]', style: { 'text-margin-y': 'data(lmy)' } },
        // group labels are short names; keep them on one line
        { selector: ':parent', style: { 'text-max-width': 1000 } },
        // edge layers switched off in the legend
        { selector: '.kHidden', style: { display: 'none' } },
        // search: matches glow, everything unrelated fades
        { selector: '.sFaded', style: { opacity: 0.13 } },
        { selector: '.sMatch', style: { 'underlay-color': '#e5c07b', 'underlay-padding': 5, 'underlay-opacity': 0.28, 'underlay-shape': 'round-rectangle' } },
        { selector: '.sCurrent', style: { 'underlay-opacity': 0.5, 'underlay-padding': 9 } },
        {
          selector: 'edge',
          style: {
            'curve-style': 'bezier',
            width: 1.8,
            'line-color': 'data(color)',
            'line-style': 'data(lstyle)',
            'target-arrow-shape': 'data(arrow)',
            'target-arrow-color': 'data(color)',
            'arrow-scale': 1.1,
            label: 'data(label)',
            color: FG,
            'font-size': 11,
            'text-rotation': 'none', // horizontal labels — slanted text is hard to read
            'text-wrap': 'wrap',        // long labels wrap instead of overrunning
            'text-max-width': 150,
            'text-background-color': BG,
            'text-background-opacity': 0.9,
            'text-background-padding': 3,
            'text-background-shape': 'roundrectangle',
            'text-border-color': 'data(color)', // boundary matches the edge/arrow color
            'text-border-width': 1,
            'text-border-opacity': 1,
            'text-border-style': 'solid',
            'text-margin-x': 'data(mx)', // offset that slides the label along the edge
            'text-margin-y': 'data(my)',
            'text-events': 'yes', // the label is part of the edge: hover shows the
                                  // edge tooltip, ctrl/cmd-click opens its code ref
          },
        },
        // hover glow — a soft halo in the element's own color
        {
          selector: 'node.hoverglow',
          style: { 'underlay-color': 'data(color)', 'underlay-padding': 7, 'underlay-opacity': 0.3, 'underlay-shape': 'round-rectangle' },
        },
        {
          selector: 'edge.hoverglow',
          style: { 'underlay-color': 'data(color)', 'underlay-padding': 5, 'underlay-opacity': 0.3 },
        },
        // hovering the LABEL itself: brighter border + opaque background, so it
        // reads as "grabbable" (dragging here slides the label along the edge)
        {
          selector: 'edge.labelglow',
          style: { 'text-border-width': 2.5, 'text-background-opacity': 1 },
        },
        // multi-select (left-drag box or shift+click): selected nodes glow
        // steadily; dragging any one of them moves the whole selection
        {
          selector: 'node:selected',
          style: { 'underlay-color': 'data(color)', 'underlay-padding': 6, 'underlay-opacity': 0.35, 'underlay-shape': 'round-rectangle', 'border-width': 2.5 },
        },
      ],
    });

    window.__cy = cy; // debugging handle (harmless in production)

    // selection is a node-arranging tool: group containers and edges stay out
    cy.$(':parent').unselectify();
    cy.edges().unselectify();

    cy.on('mousemove', 'node, edge', (ev) => {
      const oe = ev.originalEvent;
      showItemTip(ev.target.data('_item'), oe.clientX, oe.clientY, oe.ctrlKey);
    });
    cy.on('mouseout', 'node, edge', (ev) => { ev.target.removeClass('hoverglow'); hideTip(); });
    cy.on('mouseover', 'node, edge', (ev) => {
      // group containers don't glow — only nodes, edges and edge labels do
      if (ev.target.isEdge() || !ev.target.isParent()) { ev.target.addClass('hoverglow'); }
      const item = ev.target.data('_item');
      holder.style.cursor = isInteractive(item) ? 'pointer' : 'default';
    });
    cy.on('tap', 'node, edge', (ev) => {
      const oe = ev.originalEvent || {};
      // shift+click = add/remove this node from the multi-select (cytoscape
      // toggles it natively); no detail panel for selection clicks
      if (oe.shiftKey) { return; }
      // Any other click is an interaction, not a selection: drop the tap's
      // incidental select so ONLY shift+click and box-drag build selections
      // (ctrl/cmd+click especially — it means "jump to code", and cytoscape
      // treats that modifier as a selection toggle too).
      if (ev.target.isNode()) { ev.target.unselect(); }
      const item = ev.target.data('_item');
      interact(item, ev.target.data('label'), ev.target.isNode() ? 'node' : 'edge',
        { direct: !!(oe.metaKey || oe.ctrlKey) });
    });

    // Live, mutable copy of the saved arrangement. We seed edgeLabels from the
    // saved layout and rewrite the whole envelope on every persist, so node
    // drags and label drags never clobber each other's data.
    const layoutState = { v: LAYOUT_V, nodes: {}, edgeLabels: { ...((savedLayout && savedLayout.edgeLabels) || {}) } };

    function persistLayout() {
      const nodes = {};
      cy.nodes().forEach((n) => { if (!n.isParent()) { nodes[n.id()] = { x: n.position('x'), y: n.position('y') }; } });
      layoutState.nodes = nodes;
      d._layout = layoutState;
      vscodeApi.postMessage({ type: 'layout', positions: layoutState });
      vscodeApi.setState({ diagram: d });
    }

    // Place each edge's label at its saved fraction `t` along the straight
    // source→target line (default 0.5 = midpoint). Expressed as a text-margin
    // offset from the midpoint, recomputed whenever endpoints move.
    function applyEdgeLabelOffsets() {
      cy.edges().forEach((e) => {
        const rec = layoutState.edgeLabels[e.data('ekey')];
        const t = rec && typeof rec.t === 'number' ? rec.t : 0.5;
        const s = e.source().position(), tp = e.target().position();
        e.data('mx', (t - 0.5) * (tp.x - s.x));
        e.data('my', (t - 0.5) * (tp.y - s.y));
      });
    }
    cy.ready(() => applyEdgeLabelOffsets());
    cy.on('layoutstop', applyEdgeLabelOffsets);
    cy.on('drag', 'node', applyEdgeLabelOffsets); // keep labels on their line while a node moves

    // persist the arrangement whenever the user finishes dragging a node
    cy.on('dragfree', 'node', () => { applyEdgeLabelOffsets(); persistLayout(); });

    // ---- drag an edge label along its edge -----------------------------
    const LFONT = '11px -apple-system, sans-serif';
    function edgeLabelBox(e) {
      const text = e.data('label');
      if (!text) { return null; }
      let w = 0, lines = 0;
      String(text).split('\n').forEach((ln) => {
        const lw = tw(ln, LFONT);
        w = Math.max(w, Math.min(lw, 150));
        lines += Math.max(1, Math.ceil(lw / 150));
      });
      return { w: w + 8, h: lines * 13 + 6 }; // model-space px (font-size is a model unit)
    }
    function labelCenterModel(e) {
      const s = e.source().position(), tp = e.target().position();
      return { x: (s.x + tp.x) / 2 + e.data('mx'), y: (s.y + tp.y) / 2 + e.data('my') };
    }
    function clientToModel(cx, cy2) {
      const r = holder.getBoundingClientRect(), z = cy.zoom(), pan = cy.pan();
      return { x: (cx - r.left - pan.x) / z, y: (cy2 - r.top - pan.y) / z };
    }
    function edgeLabelAt(cx, cy2) {
      const m = clientToModel(cx, cy2);
      let hit = null;
      cy.edges().forEach((e) => {
        const box = edgeLabelBox(e); if (!box) { return; }
        const c = labelCenterModel(e);
        if (Math.abs(m.x - c.x) <= box.w / 2 + 2 && Math.abs(m.y - c.y) <= box.h / 2 + 2) { hit = e; }
      });
      return hit;
    }
    // Hovering the LABEL itself (not the edge line): glow the label and show a
    // grab cursor, signalling that dragging here slides it along the edge. The
    // edge tooltip/click come via text-events — the label counts as the edge.
    let glowLabelEdge = null;
    holder.addEventListener('mousemove', (me) => {
      const edge = edgeLabelAt(me.clientX, me.clientY);
      if (edge === glowLabelEdge) { return; }
      if (glowLabelEdge) { glowLabelEdge.removeClass('labelglow'); }
      glowLabelEdge = edge;
      if (edge) { edge.addClass('labelglow'); holder.style.cursor = 'grab'; }
      else { holder.style.cursor = 'default'; }
    });

    // Capture phase so we can pre-empt cytoscape's pan/box-select when the press
    // lands on a label; a plain click (no drag) still opens the edge's detail.
    holder.addEventListener('mousedown', (down) => {
      if (down.button !== 0) { return; }
      const edge = edgeLabelAt(down.clientX, down.clientY);
      if (!edge) { return; }
      down.stopPropagation(); down.preventDefault();
      holder.style.cursor = 'grabbing';
      // Anchor the drag to the GRAB point: the label moves by the same delta
      // as the mouse (projected onto the edge), instead of re-centering under
      // the cursor — grabbing a label's corner must not make it jump.
      const projectT = (clientX, clientY) => {
        const m = clientToModel(clientX, clientY);
        const s = edge.source().position(), tp = edge.target().position();
        const dx = tp.x - s.x, dy = tp.y - s.y, len2 = dx * dx + dy * dy;
        return len2 ? ((m.x - s.x) * dx + (m.y - s.y) * dy) / len2 : 0.5;
      };
      const rec0 = layoutState.edgeLabels[edge.data('ekey')];
      const t0 = rec0 && typeof rec0.t === 'number' ? rec0.t : 0.5;
      const tGrab = projectT(down.clientX, down.clientY);
      let moved = false;
      const move = (me) => {
        // ignore sub-3px jitters so an imprecise click doesn't count as a drag
        if (!moved && Math.abs(me.clientX - down.clientX) < 3 && Math.abs(me.clientY - down.clientY) < 3) { return; }
        moved = true;
        const s = edge.source().position(), tp = edge.target().position();
        const dx = tp.x - s.x, dy = tp.y - s.y;
        const t = Math.max(0.04, Math.min(0.96, t0 + (projectT(me.clientX, me.clientY) - tGrab)));
        edge.data('mx', (t - 0.5) * dx);
        edge.data('my', (t - 0.5) * dy);
        layoutState.edgeLabels[edge.data('ekey')] = { t };
      };
      const up = (ue) => {
        window.removeEventListener('mousemove', move, true);
        window.removeEventListener('mouseup', up, true);
        holder.style.cursor = 'default';
        if (moved) { persistLayout(); }
        else { interact(edge.data('_item'), edge.data('label'), 'edge', { direct: !!(ue.metaKey || ue.ctrlKey) }); }
      };
      window.addEventListener('mousemove', move, true);
      window.addEventListener('mouseup', up, true);
    }, true);

    // ---- purpose lines and group descriptions ------------------------------
    // Cytoscape draws a label in one style, so these live in an HTML layer
    // over the canvas, re-placed on every render (pan, zoom, drag).
    const overlay = document.createElement('div');
    overlay.className = 'cyOverlay';
    stage.appendChild(overlay);
    const placed = [];
    cy.nodes('[purpose]').forEach((n) => {
      if (n.isParent()) { return; }
      const el = document.createElement('div');
      el.className = 'cyPurpose';
      el.textContent = n.data('purpose');
      overlay.appendChild(el);
      placed.push({ n, el, group: false });
    });
    cy.nodes('[descr]').forEach((n) => {
      const el = document.createElement('div');
      el.className = 'cyDesc';
      el.textContent = n.data('descr');
      // the description is clamped to two lines; hovering shows all of it
      el.addEventListener('mousemove', (e) => showItemTip({ tooltip: n.data('descr') }, e.clientX, e.clientY, false));
      el.addEventListener('mouseleave', hideTip);
      overlay.appendChild(el);
      placed.push({ n, el, group: true });
    });
    let placePending = false;
    const placeOverlay = () => {
      placePending = false;
      const z = cy.zoom();
      placed.forEach(({ n, el, group }) => {
        el.style.opacity = n.hasClass('sFaded') ? '0.1' : '';
        el.style.fontSize = (PURPOSE_FONT_PX * z) + 'px';
        el.style.lineHeight = (PURPOSE_LINE * z) + 'px';
        if (group) {
          const bb = n.renderedBoundingBox({ includeLabels: false });
          // at least GROUP_DESC_MIN_W wide, centred on the box, so a narrow
          // group's description isn't squeezed into a column
          const w = Math.max(bb.w, GROUP_DESC_MIN_W * z);
          el.style.width = w + 'px';
          el.style.transform = `translate(${bb.x1 + (bb.w - w) / 2}px, ${bb.y1 - (GROUP_DESC_H + 2) * z}px)`;
        } else {
          const p = n.renderedPosition();
          const w = n.width() * z;
          // the purpose block fills the bottom of the node's inner box
          const top = p.y + (n.height() / 2 - n.data('purposeH')) * z;
          el.style.width = w + 'px';
          el.style.transform = `translate(${p.x - w / 2}px, ${top}px)`;
        }
      });
      badges.forEach(({ n, el }) => {
        if (el.hidden) { return; }
        const bb = n.renderedBoundingBox({ includeLabels: false });
        el.style.opacity = n.hasClass('sFaded') ? '0.15' : '';
        el.style.transform = `translate(${bb.x2 - 10}px, ${bb.y1 - 8}px)`;
      });
    };

    // ---- edge layers: legend toggles, "+N hidden" badges on nodes ---------
    const kindsUsed = [...new Set(cy.edges().map((e) => e.data('kind')).filter(Boolean))];
    const kindOrder = [
      ...(d.edgeKinds || []).map((k) => k.kind).filter((k) => kindsUsed.includes(k)),
      ...kindsUsed.filter((k) => !(d.edgeKinds || []).some((x) => x.kind === k)),
    ];
    const hiddenKinds = loadHiddenKinds(d);
    const badges = [];
    if (kindOrder.length) {
      cy.nodes().forEach((n) => {
        if (n.isParent()) { return; }
        const el = document.createElement('div');
        el.className = 'cyBadge';
        el.addEventListener('mousemove', (e) => showItemTip({ tooltip: el.dataset.tip }, e.clientX, e.clientY, false));
        el.addEventListener('mouseleave', hideTip);
        overlay.appendChild(el);
        badges.push({ n, el });
      });
    }
    const applyLayers = () => {
      cy.batch(() => {
        cy.edges().forEach((e) => e.toggleClass('kHidden', hiddenKinds.has(e.data('kind'))));
      });
      badges.forEach(({ n, el }) => {
        const hiddenEdges = n.connectedEdges('.kHidden');
        el.textContent = hiddenEdges.length ? '+' + hiddenEdges.length : '';
        el.hidden = !hiddenEdges.length;
        const byKind = {};
        hiddenEdges.forEach((e) => { byKind[e.data('kind')] = (byKind[e.data('kind')] || 0) + 1; });
        el.dataset.tip = hiddenEdges.length + ' hidden edge' + (hiddenEdges.length > 1 ? 's' : '') + ': '
          + Object.entries(byKind).map(([k, c]) => `${k} ${c}`).join(', ') + ' (turn them on in the legend)';
      });
    };
    if (kindOrder.length) {
      edgeLegend.innerHTML = '';
      edgeLegend.appendChild(Object.assign(document.createElement('div'), { className: 'legendTitle', textContent: 'edges' }));
      kindOrder.forEach((kind) => {
        const spec = (d.edgeKinds || []).find((k) => k.kind === kind);
        const count = cy.edges().filter((e) => e.data('kind') === kind).length;
        const row = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !hiddenKinds.has(kind);
        box.addEventListener('change', () => {
          if (box.checked) { hiddenKinds.delete(kind); } else { hiddenKinds.add(kind); }
          saveHiddenKinds(d, hiddenKinds);
          applyLayers();
          if (!searchBox.hidden) { runSearch(); }
        });
        row.appendChild(box);
        row.appendChild(document.createTextNode(' ' + ((spec && spec.label) || kind) + ' '));
        row.appendChild(Object.assign(document.createElement('span'), { className: 'legendCount', textContent: String(count) }));
        edgeLegend.appendChild(row);
      });
      edgeLegend.hidden = false;
      applyLayers();
    }

    if (placed.length || badges.length) {
      cy.on('render', () => { if (!placePending) { placePending = true; requestAnimationFrame(placeOverlay); } });
      cy.ready(placeOverlay);
    }

    // ---- search -------------------------------------------------------------
    let searchHits = [];
    searchOps = {
      run(q, o) {
        searchHits = cy.elements().not('.kHidden').filter((el) => matchesQuery(searchText(el.data('_item'),
          [el.data('label'), el.isNode() ? el.id() : '', el.data('purpose'), el.data('gdesc')], o.detail), q)).toArray();
        if (!searchHits.length) { return 0; }
        searchHits = rankHits(searchHits, q,
          (el) => [el.data('label'), el.isNode() ? el.id() : ''],
          (el) => [el.data('purpose'), el.data('gdesc')]);
        // a match brings its neighbourhood: a node its edges and their other
        // ends, an edge its two ends, a group its members
        let lit = cy.collection();
        searchHits.forEach((el) => {
          lit = lit.union(el);
          if (el.isNode() && el.isParent()) { lit = lit.union(el.descendants()); }
          else if (el.isNode()) { const es = el.connectedEdges().not('.kHidden'); lit = lit.union(es).union(es.connectedNodes()); }
          else { lit = lit.union(el.connectedNodes()); }
        });
        lit = lit.union(lit.nodes().ancestors());
        cy.batch(() => {
          cy.elements().not(lit).addClass('sFaded');
          searchHits.forEach((el) => el.addClass('sMatch'));
        });
        return searchHits.length;
      },
      show(i) {
        cy.elements('.sCurrent').removeClass('sCurrent');
        const el = searchHits[i];
        if (!el) { return; }
        el.addClass('sCurrent');
        cy.center(el);
      },
      clear() {
        searchHits = [];
        cy.elements().removeClass('sFaded sMatch sCurrent');
      },
    };

    activeOps = {
      pan(dx, dy) { cy.panBy({ x: dx, y: dy }); },
      zoom(f, cx, cy2) {
        const r = holder.getBoundingClientRect();
        cy.zoom({
          level: Math.min(5, Math.max(0.1, cy.zoom() * f)),
          renderedPosition: { x: cx - r.left, y: cy2 - r.top },
        });
      },
      reset() { cy.fit(undefined, 30); },
    };
  }

  // Fill in positions for elements missing from a saved (partial) layout:
  // average of already-placed neighbors plus an offset, else right of the
  // arrangement's bounding box, staggered. `links` = [{a, b}] adjacency.
  function completePositions(elements, links, saved) {
    const pos = {};
    elements.forEach((el) => {
      if (saved[el.id]) { pos[el.id] = { x: saved[el.id].x, y: saved[el.id].y }; }
    });
    const neighbors = {};
    (links || []).forEach((l) => {
      const a = l.from ?? l.a, b = l.to ?? l.b;
      (neighbors[a] = neighbors[a] || []).push(b);
      (neighbors[b] = neighbors[b] || []).push(a);
    });
    let maxX = 0;
    Object.values(pos).forEach((p) => { maxX = Math.max(maxX, p.x); });
    let stagger = 0;
    for (let pass = 0; pass < 3; pass++) {
      elements.forEach((el) => {
        if (pos[el.id]) { return; }
        const placed = (neighbors[el.id] || []).map((id) => pos[id]).filter(Boolean);
        if (placed.length) {
          const ax = placed.reduce((s, p) => s + p.x, 0) / placed.length;
          const ay = placed.reduce((s, p) => s + p.y, 0) / placed.length;
          pos[el.id] = { x: ax + 60 + (stagger % 3) * 50, y: ay + 130 + Math.floor(stagger / 3) * 50 };
          stagger++;
        } else if (pass === 2) {
          pos[el.id] = { x: maxX + 220, y: 80 + stagger * 100 };
          stagger++;
        }
      });
    }
    return pos;
  }

  // ================================================================ helpers for SVG diagrams

  function svgEl(tag, attrs, text) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) { if (attrs[k] !== undefined) { el.setAttribute(k, attrs[k]); } }
    if (text !== undefined) { el.textContent = text; }
    return el;
  }
  // word-wrap text to a pixel width (respects explicit \n)
  function wrapText(text, maxW, font) {
    const out = [];
    String(text).split('\n').forEach((para) => {
      let cur = '';
      para.split(/\s+/).forEach((w) => {
        const t = cur ? cur + ' ' + w : w;
        if (tw(t, font) <= maxW || !cur) { cur = t; } else { out.push(cur); cur = w; }
      });
      out.push(cur);
    });
    return out.length ? out : [''];
  }

  // intersection of segment (center of box -> tx,ty) with the box border;
  // box = {x, y, w, h} with x/y at the CENTER
  function rectBorderPoint(box, tx, ty) {
    const dx = tx - box.x, dy = ty - box.y;
    if (dx === 0 && dy === 0) { return { x: box.x, y: box.y }; }
    const sx = (box.w / 2) / Math.abs(dx || 1e-9);
    const sy = (box.h / 2) / Math.abs(dy || 1e-9);
    const s = Math.min(sx, sy);
    return { x: box.x + dx * s, y: box.y + dy * s };
  }

  function labelWithBg(svg, x, y, text, opts) {
    opts = opts || {};
    const font = opts.font || SMALL_FONT;
    const w = tw(text, font);
    const anchor = opts.anchor || 'middle';
    const rx = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
    const target = opts.parent || svg;
    const rect = svgEl('rect', {
      x: rx - 3, y: y - 11, width: w + 6, height: 15,
      fill: BG, 'fill-opacity': 0.85, rx: 2,
    });
    const label = svgEl('text', {
      x, y, fill: opts.fill || FG, 'font-size': opts.size || 12,
      'font-weight': opts.bold ? 600 : 400, 'text-anchor': anchor,
      'font-family': "-apple-system, 'Segoe UI', sans-serif",
    }, text);
    target.appendChild(rect);
    target.appendChild(label);
    return { rect, label, width: w, anchor };
  }

  // ================================================================ SEQUENCE

  function renderSequence(d) {
    const ps = d.participants || [];
    const ms = d.messages || [];
    const frames = (d.frames || []).slice();
    const idx = {};
    const savedSequenceLayout = normalizeLayout(d._layout);
    const savedSequencePositions = (savedSequenceLayout && savedSequenceLayout.nodes) || {};
    const sequenceKey = (kind, id) => `sequence:${kind}:${id}`;
    const sequenceOffset = (kind, id) => savedSequencePositions[sequenceKey(kind, id)] || { x: 0, y: 0 };
    ps.forEach((p, i) => { idx[p.id] = i; });

    // --- horizontal layout: participant centers
    const pw = ps.map((p) => Math.max(90, tw(p.label || p.id, UI_FONT_BOLD) + 30));
    const baseC = [];
    for (let i = 0; i < ps.length; i++) {
      if (i === 0) { baseC.push(24 + pw[0] / 2); continue; }
      let gap = pw[i - 1] / 2 + 48 + pw[i] / 2;
      ms.forEach((m) => {
        const a = idx[m.from], b = idx[m.to];
        if (a === undefined || b === undefined) { return; }
        if (Math.min(a, b) === i - 1 && Math.max(a, b) === i) {
          gap = Math.max(gap, tw(m.label, SMALL_FONT) + 70);
        }
      });
      baseC.push(baseC[i - 1] + gap);
    }
    // Lifelines may slide horizontally, but their order is invariant.
    const c = baseC.map((x, i) => x + sequenceOffset('participant', ps[i].id).x);
    for (let i = 1; i < c.length; i++) {
      c[i] = Math.max(c[i], c[i - 1] + pw[i - 1] / 2 + 20 + pw[i] / 2);
    }

    // --- vertical layout
    const topY = 18, boxH = 34, lifeTop = topY + boxH;
    let y = lifeTop + 38;
    const baseYs = [];
    ms.forEach((m, i) => {
      frames.forEach((f) => { if (f.from === i) { y += 24; } });
      baseYs.push(y);
      const self = m.from === m.to || m.kind === 'self';
      y += self ? 58 : 40;
      if (m.note) { y += 8; }
      frames.forEach((f) => { if (f.to === i) { y += 12; } });
    });
    // A dragged message or frame shifts everything after it by the same
    // amount ("insert space"), so moving one part never squashes the rest.
    const ownShift = baseYs.map((_, i) => sequenceOffset('message', i).y +
      frames.reduce((sum, f, frameIndex) => f.from === i ? sum + sequenceOffset('frame', frameIndex).y : sum, 0));
    let carried = 0;
    const ys = baseYs.map((value, i) => { carried += ownShift[i]; return value + carried; });
    // Messages retain call-chain order; this pass also repairs hand-edited
    // and legacy layouts.
    for (let i = 1; i < ys.length; i++) { ys[i] = Math.max(ys[i], ys[i - 1] + 24); }

    // Frame nesting. Frames that start (or end) at the same message stack
    // their title tags (or bottom edges) instead of drawing on top of each
    // other: the outer frame's tag sits one band above the inner one's.
    const FRAME_BAND = 22;
    const frameValid = (f) => f.from >= 0 && f.to < ms.length && f.from <= f.to;
    const frameContains = (o, f) => o !== f && o.from <= f.from && o.to >= f.to &&
      (o.to - o.from > f.to - f.from || frames.indexOf(o) < frames.indexOf(f));
    const frameInnerLevels = frames.map(() => 0);
    const innerLevels = (f) => Math.max(0, ...frames.filter((o) => frameValid(o) && frameContains(f, o)).map((o) => 1 + innerLevels(o)));
    frames.forEach((f, i) => { frameInnerLevels[i] = frameValid(f) ? innerLevels(f) : 0; });
    const frameStartRank = frames.map((f) => frames.filter((o) => frameValid(o) && o.from === f.from && frameContains(f, o)).length);
    const frameEndRank = frames.map((f) => frames.filter((o) => frameValid(o) && o.to === f.to && frameContains(f, o)).length);
    const frameTop = (frameIndex) => ys[frames[frameIndex].from] - 46 - FRAME_BAND * frameStartRank[frameIndex];
    const firstActivation = ys.length ? Math.min(...ys) : lifeTop + 38;
    // Lifeline headers may move upward freely, but cannot be placed below the
    // first edge/activation in the sequence.
    const participantTop = ps.map((p) => Math.min(
      topY + sequenceOffset('participant', p.id).y,
      firstActivation - boxH - 8,
    ));
    const participantLifeTop = participantTop.map((v) => v + boxH);
    // Notes live in their own column right of the last lifeline (and of any
    // frame), so they never cover arrows. They wrap, and stack downward when
    // a note is taller than the gap to the next one.
    const NOTE_MAX_W = 260, NOTE_LINE = 14;
    const last = ps.length - 1;
    const selfLabelRight = ms.reduce((r, m) => {
      const a = idx[m.from];
      return a !== undefined && (m.from === m.to || m.kind === 'self') ? Math.max(r, c[a] + 56 + tw(m.label, SMALL_FONT)) : r;
    }, -Infinity);
    const noteX = last >= 0
      ? Math.max(c[last] + Math.max(pw[last] / 2, 74 + 7 * Math.max(0, ...frameInnerLevels)), selfLabelRight) + 24
      : 40;
    const noteBoxes = [];
    let noteBottom = -Infinity;
    ms.forEach((m, i) => {
      if (!m.note) { return; }
      const lines = wrapText(m.note, NOTE_MAX_W, SMALL_FONT);
      const w = Math.max(...lines.map((l) => tw(l, SMALL_FONT))) + 26;
      const h = 12 + NOTE_LINE * lines.length;
      const top = Math.max(ys[i] - 12, noteBottom + 6);
      noteBoxes[i] = { lines, w, h, top };
      noteBottom = top + h;
    });
    const endY = Math.max(y + 10, ...ys.map((v) => v + 60), noteBottom + 10);

    let width = (c.length ? c[c.length - 1] + pw[pw.length - 1] / 2 + 30 : 160);
    noteBoxes.forEach((nb) => { if (nb) { width = Math.max(width, noteX + nb.w + 20); } });
    const height = endY + 26;

    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}` });

    // markers
    const defs = svgEl('defs', {});
    const mk = (id, inner) => {
      const m = svgEl('marker', {
        id, viewBox: '0 0 10 10', refX: 9, refY: 5,
        markerWidth: 8.5, markerHeight: 8.5, orient: 'auto-start-reverse',
      });
      m.appendChild(inner);
      defs.appendChild(m);
    };
    mk('jbFill', svgEl('path', { d: 'M0 0 L10 5 L0 10 z', fill: FG }));
    mk('jbOpen', svgEl('path', { d: 'M0 0 L10 5 L0 10', fill: 'none', stroke: FG, 'stroke-width': 1.6 }));
    svg.appendChild(defs);

    // Sequence elements use the same versioned layout envelope as graph and
    // class diagrams, but with namespaced keys. Dragging changes offsets from
    // the computed layout; a redraw then keeps lifelines, activations, arrows,
    // frames and notes coherent.
    const persistSequenceLayout = () => {
      const previous = normalizeLayout(d._layout) || emptyLayout();
      const env = { v: LAYOUT_V, nodes: { ...(previous.nodes || {}), ...savedSequencePositions }, edgeLabels: previous.edgeLabels || {} };
      d._layout = env;
      vscodeApi.postMessage({ type: 'layout', positions: env });
    };
    const lifelineEls = [];
    const activationEls = ps.map(() => []);
    const activationStarts = [];
    const activationEnds = [];
    const messageGeometries = [];
    const noteElements = [];
    const noteLeaders = [];
    const frameElements = [];
    const headerEls = [];
    const activationInfo = [];
    const updateActivationForMessage = (messageIndex, y) => {
      (activationStarts[messageIndex] || []).forEach((a) => {
        a.y0 = y - 5;
        a.rect.setAttribute('y', String(a.y0));
        a.rect.setAttribute('height', String(Math.max(6, a.y1 - a.y0)));
      });
      (activationEnds[messageIndex] || []).forEach((a) => {
        a.y1 = y + a.endPad;
        a.rect.setAttribute('height', String(Math.max(6, a.y1 - a.y0)));
      });
    };
    const updateMessageGeometry = (participantIndex, deltaX) => {
      messageGeometries.forEach((geom) => {
        if (!geom) { return; }
        const ca = c[geom.a] + (geom.a === participantIndex ? deltaX : 0);
        const cb = c[geom.b] + (geom.b === participantIndex ? deltaX : 0);
        if (geom.self) {
          geom.arrow.setAttribute('d', `M${ca + 4} ${geom.y} h44 v22 h-40`);
          const x = ca + 56;
          geom.label.rect.setAttribute('x', String(x - 3));
          geom.label.rect.setAttribute('y', String(geom.y + 15 - 11));
          geom.label.label.setAttribute('x', String(x));
          geom.label.label.setAttribute('y', String(geom.y + 15));
          geom.hit.setAttribute('x', String(ca - 10));
          return;
        }
        const end = cb + (cb > ca ? -5 : 5);
        geom.arrow.setAttribute('x1', String(ca));
        geom.arrow.setAttribute('x2', String(end));
        const mid = (ca + cb) / 2;
        geom.label.rect.setAttribute('x', String(mid - geom.label.width / 2 - 3));
        geom.label.rect.setAttribute('y', String(geom.y - 6 - 11));
        geom.label.label.setAttribute('x', String(mid));
        geom.label.label.setAttribute('y', String(geom.y - 6));
        geom.hit.setAttribute('x', String(Math.min(ca, cb) - 10));
        geom.hit.setAttribute('width', String(Math.max(Math.abs(cb - ca), 60) + 20));
      });
    };
    const bindSequenceDrag = (el, key, kind, index) => {
      el.classList.add('sequence-draggable');
      el.addEventListener('mousedown', (down) => {
        if (down.button !== 0) { return; }
        const startX = down.clientX, startY = down.clientY;
        const before = { ...(savedSequencePositions[key] || { x: 0, y: 0 }) };
        let moved = false;
        const scale = () => {
          // Mouse deltas are screen pixels; SVG content coordinates are
          // additionally magnified by the current viewport zoom.
          const zoom = activeOps?.getZoom?.() || 1;
          return { x: 1 / zoom, y: 1 / zoom };
        };
        const move = (e) => {
          const s = scale();
          let dx = (e.clientX - startX) * s.x, dy = (e.clientY - startY) * s.y;
          if (Math.abs(dx) < 3 && Math.abs(dy) < 3) { return; }
          moved = true;
          if (kind === 'participant') {
            const i = index;
            const minX = i ? c[i - 1] + pw[i - 1] / 2 + 20 + pw[i] / 2 - baseC[i] : -baseC[i] - pw[i] / 2 - 20;
            const maxX = i + 1 < c.length ? c[i + 1] - pw[i + 1] / 2 - 20 - pw[i] / 2 - baseC[i] : Infinity;
            dx = Math.max(minX, Math.min(maxX, before.x + dx));
            const maxY = firstActivation - boxH - 8 - topY;
            dy = Math.min(maxY, before.y + dy);
          } else if (kind === 'message') {
            // Message arrows are horizontally anchored to the lifelines; only
            // their vertical offset is user-adjustable.
            dx = before.x;
            const current = ys[index];
            // The first edge may rise almost to the participant headers; later
            // edges retain the call-chain spacing constraint.
            // Moving down is unbounded: later messages shift with it on drop.
            const prev = index ? ys[index - 1] + 24 : Math.min(...participantLifeTop) + 8;
            const desired = Math.max(prev, current + dy);
            dy = before.y + (desired - current);
          } else if (kind === 'frame') {
            dx = before.x;
            const f = frames[index];
            const prev = f.from ? ys[f.from - 1] + 10 : lifeTop + 8;
            const desired = Math.max(prev, frameTop(index) + (before.y + dy - sequenceOffset('frame', index).y));
            dy = before.y + (desired - frameTop(index));
            const frameDelta = dy - before.y;
            for (let mi = f.from; mi <= f.to; mi++) {
              const geom = messageGeometries[mi];
              if (geom) { geom.group.setAttribute('transform', `translate(0 ${frameDelta})`); }
              if (noteElements[mi]) { noteElements[mi].setAttribute('transform', `translate(0 ${frameDelta})`); }
              [...(activationStarts[mi] || []), ...(activationEnds[mi] || [])].forEach((a) => {
                a.rect.setAttribute('transform', `translate(0 ${frameDelta})`);
              });
            }
          } else if (kind === 'note') {
            // Notes/tags are the one sequence annotation that may move freely.
            // Keep their horizontal and vertical offsets independent.
          }
          savedSequencePositions[key] = { x: dx, y: dy };
          el.setAttribute('transform', `translate(${dx - before.x} ${dy - before.y})`);
          if (kind === 'message') {
            const messageDelta = dy - before.y;
            updateActivationForMessage(index, ys[index] + messageDelta);
            frames.forEach((f, frameIndex) => {
              if (index >= f.from && index <= f.to && frameElements[frameIndex]) {
                const frame = frameElements[frameIndex];
                if (index === f.from || index === f.to) {
                  const y0 = frame.y0 + (index === f.from ? messageDelta : 0);
                  const y1 = frame.y1 + (index === f.to ? messageDelta : 0);
                  frame.rect.setAttribute('y', String(y0));
                  frame.rect.setAttribute('height', String(y1 - y0));
                  frame.path.setAttribute('d', `M${frame.x0} ${y0} h${frame.tagW} v12 l-7 6 h${-(frame.tagW - 7)} z`);
                  frame.text.setAttribute('y', String(y0 + 13));
                } else {
                  frame.group.setAttribute('transform', `translate(0 ${messageDelta})`);
                }
              }
            });
          }
          if (kind === 'participant' && lifelineEls[index]) {
            const deltaX = dx - before.x;
            const participantY = topY + dy + boxH;
            lifelineEls[index].setAttribute('x1', String(c[index] + deltaX));
            lifelineEls[index].setAttribute('x2', String(c[index] + deltaX));
            lifelineEls[index].setAttribute('y1', String(participantY));
            lifelineEls[index].setAttribute('y2', String(endY));
            // Activation bars belong to the message timeline: a participant's
            // vertical move must not displace their Y positions.  They still
            // follow horizontal lifeline movement so arrow starts remain
            // anchored to the bar.
            activationEls[index].forEach((activation) => {
              activation.setAttribute('transform', `translate(${dx - before.x} 0)`);
            });
            updateMessageGeometry(index, dx - before.x);
          }
        };
        const up = () => {
          window.removeEventListener('mousemove', move, true);
          window.removeEventListener('mouseup', up, true);
          if (moved) {
            suppressClick = true;
            setTimeout(() => { suppressClick = false; }, 150);
            const viewportState = activeOps?.getState?.();
            persistSequenceLayout();
            render(d);
            // Redrawing is necessary to keep every anchored arrow/frame in
            // sync, but it must not reset the user's pan/zoom.
            if (viewportState && activeOps?.setState) { activeOps.setState(viewportState); }
          }
        };
        window.addEventListener('mousemove', move, true);
        window.addEventListener('mouseup', up, true);
        down.preventDefault();
      }, true);
    };

    // lifelines
    ps.forEach((p, i) => {
      const line = svgEl('line', {
        x1: c[i], y1: participantLifeTop[i], x2: c[i], y2: endY,
        stroke: MUTED, 'stroke-width': 1, 'stroke-dasharray': '4 4', 'stroke-opacity': 0.7,
        class: 'jb-dim',
      });
      lifelineEls[i] = line;
      svg.appendChild(line);
    });

    // activations: a sync call starts one on the target, a reply ends it
    const stacks = ps.map(() => []);
    const actRects = [];
    const isSyncCall = (m) => {
      const a = idx[m.from], b = idx[m.to];
      return a !== undefined && b !== undefined && a !== b && (m.kind || 'sync') === 'sync';
    };
    ms.forEach((m, i) => {
      const a = idx[m.from], b = idx[m.to];
      if (a === undefined || b === undefined) { return; }
      const kind = m.kind || (a === b ? 'self' : 'sync');
      if (isSyncCall(m)) { stacks[b].push({ y0: ys[i] - 5, startMessage: i }); }
      if (kind === 'reply' && stacks[a].length) {
        const start = stacks[a].pop();
        actRects.push({ p: a, y0: start.y0, y1: ys[i] + 5, startMessage: start.startMessage, endMessage: i, endPad: 5 });
      }
    });
    // A call without a reply: the callee is busy until the last message it
    // sends before it is called again. One that sends nothing (a hook that
    // just returns) gets a short bar.
    stacks.forEach((st, p) => st.forEach((start) => {
      let end = start.startMessage;
      for (let j = start.startMessage + 1; j < ms.length; j++) {
        if (idx[ms[j].to] === p && isSyncCall(ms[j])) { break; }
        if (idx[ms[j].from] === p) { end = j; }
      }
      const endsOnSelf = end !== start.startMessage && ms[end].from === ms[end].to;
      const endPad = end === start.startMessage ? 16 : endsOnSelf ? 27 : 5;
      actRects.push({ p, y0: start.y0, y1: ys[end] + endPad, startMessage: start.startMessage, endMessage: end, endPad });
    }));
    actRects.forEach((r) => {
      const activation = svgEl('rect', {
        // Y is owned by the message timeline; only the participant's X is
        // applied here.  This keeps activation starts aligned with arrows
        // when the lifeline header is moved vertically.
        x: c[r.p] - 4, y: r.y0, width: 8, height: Math.max(6, r.y1 - r.y0),
        fill: ACCENT, 'fill-opacity': 0.35, stroke: ACCENT, 'stroke-width': 1,
        class: 'jb-dim',
      });
      activationEls[r.p].push(activation);
      activationInfo.push({ el: activation, p: r.p, y0: r.y0, y1: r.y1 });
      const anchor = { rect: activation, y0: r.y0, y1: r.y1, endPad: r.endPad };
      if (r.startMessage !== undefined) { (activationStarts[r.startMessage] ||= []).push(anchor); }
      if (r.endMessage !== undefined) { (activationEnds[r.endMessage] ||= []).push(anchor); }
      svg.appendChild(activation);
    });

    // frames (under messages, over activation bars so their tags stay readable)
    frames.forEach((f, frameIndex) => {
      if (!frameValid(f)) { return; }
      let minC = Infinity, maxC = -Infinity;
      for (let i = f.from; i <= f.to; i++) {
        const a = idx[ms[i].from], b = idx[ms[i].to];
        if (a !== undefined) { minC = Math.min(minC, c[a]); maxC = Math.max(maxC, c[a]); }
        if (b !== undefined) { minC = Math.min(minC, c[b]); maxC = Math.max(maxC, c[b]); }
      }
      if (!isFinite(minC)) { return; }
      // Outer frames grow by one step per level nested inside them, so
      // borders never coincide and inner frames keep their clearance.
      const grow = 7 * frameInnerLevels[frameIndex];
      const x0 = Math.max(4, minC - 40 - grow), x1 = maxC + 44 + (ms.slice(f.from, f.to + 1).some(m => m.from === m.to) ? 30 : 0) + grow;
      // Leave a clear title band above the first message label.
      const y0 = frameTop(frameIndex);
      const y1 = ys[f.to] + (ms[f.to].from === ms[f.to].to ? 34 : 14) + 10 * frameEndRank[frameIndex];
      const frameGroup = svgEl('g', { class: 'jb-dim' });
      const frameRect = svgEl('rect', {
        x: x0, y: y0, width: x1 - x0, height: y1 - y0,
        fill: FG, 'fill-opacity': 0.03, stroke: MUTED, 'stroke-width': 1, rx: 2,
      });
      frameGroup.appendChild(frameRect);
      const tag = f.kind + (f.label ? ' [' + f.label + ']' : '');
      const tagW = tw(tag, SMALL_FONT) + 14;
      const framePath = svgEl('path', {
        d: `M${x0} ${y0} h${tagW} v12 l-7 6 h${-(tagW - 7)} z`,
        fill: MUTED, 'fill-opacity': 0.25, stroke: MUTED, 'stroke-width': 0.8,
      });
      frameGroup.appendChild(framePath);
      const frameText = svgEl('text', {
        x: x0 + 6, y: y0 + 13, fill: FG, 'font-size': 11, 'font-weight': 600,
        'font-family': "-apple-system, sans-serif",
      }, tag);
      frameGroup.appendChild(frameText);
      frameElements[frameIndex] = { group: frameGroup, rect: frameRect, path: framePath, text: frameText, x0, x1, y0, y1, tagW };
      bindSequenceDrag(frameGroup, sequenceKey('frame', frameIndex), 'frame', frameIndex);
      svg.appendChild(frameGroup);
    });

    // participant headers
    ps.forEach((p, i) => {
      const g = svgEl('g', { class: 'jb-dim' });
      headerEls[i] = g;
      const label = p.label || p.id;
      if (p.kind === 'actor') {
        const hx = c[i], hy = participantTop[i] + 7;
        g.appendChild(svgEl('circle', { cx: hx, cy: hy, r: 4.5, fill: 'none', stroke: FG, 'stroke-width': 1.4 }));
        g.appendChild(svgEl('line', { x1: hx, y1: hy + 4.5, x2: hx, y2: hy + 14, stroke: FG, 'stroke-width': 1.4 }));
        g.appendChild(svgEl('line', { x1: hx - 7, y1: hy + 8, x2: hx + 7, y2: hy + 8, stroke: FG, 'stroke-width': 1.4 }));
        g.appendChild(svgEl('line', { x1: hx, y1: hy + 13, x2: hx - 5, y2: hy + 19, stroke: FG, 'stroke-width': 1.4 }));
        g.appendChild(svgEl('line', { x1: hx, y1: hy + 13, x2: hx + 5, y2: hy + 19, stroke: FG, 'stroke-width': 1.4 }));
        g.appendChild(svgEl('text', {
          x: c[i], y: participantTop[i] + 37, fill: FG, 'font-size': 11, 'font-weight': 600, 'text-anchor': 'middle',
          'font-family': "-apple-system, sans-serif",
        }, label));
      } else if (p.kind === 'database') {
        const w = pw[i] - 16, x0 = c[i] - w / 2, ry = 5;
        g.appendChild(svgEl('path', {
          d: `M${x0} ${participantTop[i] + ry} a${w / 2} ${ry} 0 0 1 ${w} 0 v${boxH - 2 * ry - 4} a${w / 2} ${ry} 0 0 1 ${-w} 0 z`,
          fill: BG, stroke: FG, 'stroke-width': 1.3,
        }));
        g.appendChild(svgEl('ellipse', { cx: c[i], cy: participantTop[i] + ry, rx: w / 2, ry, fill: 'none', stroke: FG, 'stroke-width': 1.3 }));
        g.appendChild(svgEl('text', {
          x: c[i], y: participantTop[i] + boxH / 2 + 7, fill: FG, 'font-size': 12, 'font-weight': 600, 'text-anchor': 'middle',
          'font-family': "-apple-system, sans-serif",
        }, label));
      } else {
        g.appendChild(svgEl('rect', {
          x: c[i] - pw[i] / 2, y: participantTop[i], width: pw[i], height: boxH,
          fill: ACCENT, 'fill-opacity': 0.15, stroke: ACCENT, 'stroke-width': 1.3, rx: 4,
        }));
        g.appendChild(svgEl('text', {
          x: c[i], y: participantTop[i] + boxH / 2 + 4.5, fill: FG, 'font-size': 13, 'font-weight': 600, 'text-anchor': 'middle',
          'font-family': "-apple-system, sans-serif",
        }, label));
      }
      bindSvgItem(g, p, label, 'participant');
      bindSequenceDrag(g, sequenceKey('participant', p.id), 'participant', i);
      svg.appendChild(g);
    });

    // messages
    ms.forEach((m, i) => {
      const a = idx[m.from], b = idx[m.to];
      if (a === undefined || b === undefined) { return; }
      const kind = m.kind || (a === b ? 'self' : 'sync');
      const yy = ys[i];
      const g = svgEl('g', { class: 'jb-dim' });
      let arrow;
      let messageLabel;

      if (kind === 'self' || a === b) {
        const x = c[a];
        arrow = svgEl('path', {
          d: `M${x + 4} ${yy} h44 v22 h-40`,
          fill: 'none', stroke: FG, 'stroke-width': 1.4, 'marker-end': 'url(#jbFill)',
        });
        g.appendChild(arrow);
        messageLabel = labelWithBg(g, x + 56, yy + 15, m.label, { anchor: 'start', parent: g });
      } else {
        const dashed = kind === 'reply';
        const marker = kind === 'sync' ? 'url(#jbFill)' : 'url(#jbOpen)';
        arrow = svgEl('line', {
          x1: c[a], y1: yy, x2: c[b] + (c[b] > c[a] ? -5 : 5), y2: yy,
          stroke: FG, 'stroke-width': 1.4,
          'stroke-dasharray': dashed ? '5 4' : undefined,
          'marker-end': marker,
        });
        g.appendChild(arrow);
        messageLabel = labelWithBg(g, (c[a] + c[b]) / 2, yy - 6, m.label, { parent: g });
      }
      // wide invisible hit area
      const hit = svgEl('rect', {
        x: Math.min(c[a], c[b]) - 10, y: yy - 16,
        width: Math.max(Math.abs(c[b] - c[a]), 60) + 20, height: kind === 'self' ? 40 : 26,
        fill: 'transparent',
      });
      g.appendChild(hit);
      messageGeometries[i] = { a, b, y: yy, self: kind === 'self' || a === b, arrow, label: messageLabel, hit, group: g };
      bindSvgItem(g, m, m.label, 'message');
      g.addEventListener('click', () => { if (!suppressClick) { focusMessage(i, {}); } });
      bindSequenceDrag(g, sequenceKey('message', i), 'message', i);
      svg.appendChild(g);

      if (m.note && noteBoxes[i]) {
        const noteOffset = sequenceOffset('note', i);
        const nb = noteBoxes[i];
        const nx = noteX + noteOffset.x;
        const top = nb.top + noteOffset.y;
        const nw = nb.w;
        // dotted leader from the message's right end to the note
        const fromX = kind === 'self' || a === b ? c[a] + 48 : Math.max(c[a], c[b]);
        noteLeaders[i] = svgEl('path', {
          d: `M${fromX + 6} ${yy} H${nx - 10} L${nx} ${top + nb.h / 2}`,
          fill: 'none', stroke: '#b8963e', 'stroke-width': 1, 'stroke-dasharray': '2 3', 'stroke-opacity': 0.7,
          class: 'jb-dim',
        });
        svg.appendChild(noteLeaders[i]);
        const ng = svgEl('g', { class: 'jb-dim' });
        ng.appendChild(svgEl('path', {
          d: `M${nx} ${top} h${nw - 8} l8 8 v${nb.h - 8} h${-nw} z M${nx + nw - 8} ${top} v8 h8`,
          fill: 'rgba(255, 214, 102, 0.10)', stroke: '#b8963e', 'stroke-width': 1,
        }));
        nb.lines.forEach((line, li) => {
          ng.appendChild(svgEl('text', {
            x: nx + 8, y: top + 17 + NOTE_LINE * li, fill: FG, 'font-size': 11.5,
            'font-family': "-apple-system, sans-serif",
          }, line));
        });
        bindSequenceDrag(ng, sequenceKey('note', i), 'note', i);
        noteElements[i] = ng;
        svg.appendChild(ng);
      }
    });

    stage.appendChild(svg);
    activeOps = makeSvgViewport(svg);

    // --- focus: trace one message at a time
    // The focused message, its two participants, its enclosing frames, its
    // note and the activation bars it touches stay lit; the rest dims. A
    // band behind the message marks the current step.
    const band = svgEl('rect', { fill: ACCENT, 'fill-opacity': 0.14, rx: 4, 'pointer-events': 'none' });
    const keepInView = (i) => {
      const geom = messageGeometries[i];
      if (!activeOps || !activeOps.getState || !geom) { return; }
      const st = activeOps.getState();
      const midX = geom.self ? c[geom.a] + 60 : (c[geom.a] + c[geom.b]) / 2;
      const sx = st.tx + midX * st.k, sy = st.ty + geom.y * st.k;
      const left = cardPanel.hidden ? 0 : cardPanel.offsetWidth;
      const right = stage.clientWidth - (detail.hidden ? 0 : detail.offsetWidth);
      let { tx, ty } = st;
      if (sy < 70 || sy > stage.clientHeight - 70) { ty = stage.clientHeight * 0.35 - geom.y * st.k; }
      if (sx < left + 40 || sx > right - 40) { tx = left + (right - left) * 0.45 - midX * st.k; }
      if (tx !== st.tx || ty !== st.ty) { activeOps.setState({ tx, ty, k: st.k }); }
    };
    // everything that belongs with message i: its arrow, both participants,
    // its note, enclosing frames and the activation bars it touches
    const litForMessage = (i, lit) => {
      const geom = messageGeometries[i];
      if (!geom) { return; }
      [geom.group, headerEls[geom.a], headerEls[geom.b], lifelineEls[geom.a], lifelineEls[geom.b],
        noteElements[i], noteLeaders[i]].forEach((el) => { if (el) { lit.add(el); } });
      frames.forEach((f, fi) => { if (frameElements[fi] && i >= f.from && i <= f.to) { lit.add(frameElements[fi].group); } });
      activationInfo.forEach((ai) => {
        if ((ai.p === geom.a || ai.p === geom.b) && ai.y0 <= ys[i] + 6 && ai.y1 >= ys[i] - 6) { lit.add(ai.el); }
      });
    };
    const applyLit = (lit) => {
      svg.classList.add('jb-focusing');
      svg.querySelectorAll('.jb-dim').forEach((el) => el.classList.toggle('jb-lit', lit.has(el)));
    };
    const placeBand = (i) => {
      const geom = messageGeometries[i];
      const x0 = Math.min(c[geom.a], c[geom.b]) - 14;
      const x1 = geom.self ? c[geom.a] + 56 + geom.label.width + 10 : Math.max(c[geom.a], c[geom.b]) + 14;
      band.setAttribute('x', String(x0));
      band.setAttribute('y', String(geom.y - 21));
      band.setAttribute('width', String(x1 - x0));
      band.setAttribute('height', String(geom.self ? 52 : 30));
      geom.group.insertBefore(band, geom.group.firstChild);
    };
    const focusMessage = (i, opts) => {
      if (!messageGeometries[i]) { return; }
      seqFocusState.index = i;
      const lit = new Set();
      litForMessage(i, lit);
      applyLit(lit);
      placeBand(i);
      focusHint.textContent = `step ${i + 1} of ${ms.length} · ↑ ↓ to step · Esc to exit`;
      focusHint.hidden = false;
      if (opts.step) {
        const m = ms[i];
        openDetail(m, m.label, 'message');
        const refs = getRefs(m);
        if (refs.length) { openRef(refs[0], refs, { follow: true }); }
        keepInView(i);
      }
    };
    const clearFocus = () => {
      seqFocusState.index = null;
      svg.classList.remove('jb-focusing');
      band.remove();
      focusHint.hidden = true;
    };
    seqFocus = {
      step(delta) {
        let i = seqFocusState.index === null ? (delta > 0 ? -1 : ms.length) : seqFocusState.index;
        do { i += delta; } while (i >= 0 && i < ms.length && !messageGeometries[i]);
        if (i >= 0 && i < ms.length) { focusMessage(i, { step: true }); }
      },
      focus(i) { if (messageGeometries[i]) { focusMessage(i, { step: true }); } },
      clear: clearFocus,
    };
    // ---- search: messages, participants and frames
    const searchItems = [];
    ps.forEach((p, i) => searchItems.push({
      kind: 'participant', i, names: [p.label, p.id], purposes: [],
      text: (o) => searchText(p, [p.label, p.id], o.detail),
    }));
    ms.forEach((m, i) => {
      if (!messageGeometries[i]) { return; }
      searchItems.push({
        kind: 'message', i, names: [m.label], purposes: [m.note],
        text: (o) => searchText(m, [m.label, m.note], o.detail),
      });
    });
    frames.forEach((f, fi) => {
      if (!frameElements[fi]) { return; }
      searchItems.push({ kind: 'frame', i: fi, names: [f.label], purposes: [], text: () => [f.kind, f.label].join(' ').toLowerCase() });
    });
    let seqHits = [];
    const hitEl = (h) => h.kind === 'participant' ? headerEls[h.i] : h.kind === 'message' ? messageGeometries[h.i].group : frameElements[h.i].group;
    // the message to scroll to for a hit
    const hitMessage = (h) => h.kind === 'message' ? h.i
      : h.kind === 'frame' ? frames[h.i].from
      : messageGeometries.findIndex((g) => g && (g.a === h.i || g.b === h.i));
    searchOps = {
      run(q, o) {
        seqHits = searchItems.filter((it) => matchesQuery(it.text(o), q));
        if (!seqHits.length) { return 0; }
        seqHits = rankHits(seqHits, q, (h) => h.names, (h) => h.purposes);
        const lit = new Set();
        seqHits.forEach((h) => {
          if (h.kind === 'message') { litForMessage(h.i, lit); }
          else if (h.kind === 'frame') {
            lit.add(frameElements[h.i].group);
            for (let mi = frames[h.i].from; mi <= frames[h.i].to; mi++) { litForMessage(mi, lit); }
          } else {
            lit.add(headerEls[h.i]); lit.add(lifelineEls[h.i]);
            messageGeometries.forEach((g, mi) => { if (g && (g.a === h.i || g.b === h.i)) { litForMessage(mi, lit); } });
          }
          hitEl(h).classList.add('jb-match');
        });
        applyLit(lit);
        return seqHits.length;
      },
      show(i) {
        svg.querySelectorAll('.jb-current').forEach((el) => el.classList.remove('jb-current'));
        const h = seqHits[i];
        if (!h) { return; }
        hitEl(h).classList.add('jb-current');
        const mi = hitMessage(h);
        if (mi >= 0) {
          keepInView(mi);
          // ↑/↓ carry on from here
          seqFocusState.index = mi;
          if (h.kind === 'message') { placeBand(mi); } else { band.remove(); }
        }
      },
      clear() {
        seqHits = [];
        svg.querySelectorAll('.jb-match, .jb-current').forEach((el) => el.classList.remove('jb-match', 'jb-current'));
        clearFocus();
      },
    };

    if (seqFocusState.diagram === d && seqFocusState.index !== null) { focusMessage(seqFocusState.index, {}); }
    else { seqFocusState = { diagram: d, index: null }; }
  }

  // ================================================================ CLASS

  function renderClass(d) {
    if (typeof dagre === 'undefined') { stage.textContent = 'dagre not loaded'; return; }
    const classes = d.classes || [];
    const rels = d.relations || [];
    const LINE = 17, PAD = 10;

    const boxes = {};
    classes.forEach((cl) => {
      const name = cl.name || cl.id;
      const attrs = cl.attributes || [];
      const meths = cl.methods || [];
      let w = Math.max(130, tw(name, UI_FONT_BOLD) + 28);
      if (cl.stereotype) { w = Math.max(w, tw('«' + cl.stereotype + '»', SMALL_FONT) + 28); }
      attrs.concat(meths).forEach((s) => { w = Math.max(w, tw(s, MONO_FONT) + 2 * PAD + 4); });
      const nameH = cl.stereotype ? 40 : 27;
      const aH = attrs.length ? attrs.length * LINE + 9 : 9;
      const mH = meths.length ? meths.length * LINE + 9 : 9;
      boxes[cl.id] = { cl, name, attrs, meths, w, nameH, aH, mH, h: nameH + aH + mH };
    });

    // layout: dagre, rankdir BT so inheritance targets (bases) sit above
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'BT', nodesep: 55, ranksep: 70, marginx: 24, marginy: 24 });
    g.setDefaultEdgeLabel(() => ({}));
    classes.forEach((cl) => g.setNode(cl.id, { width: boxes[cl.id].w, height: boxes[cl.id].h }));
    rels.forEach((r) => { if (boxes[r.from] && boxes[r.to]) { g.setEdge(r.from, r.to); } });
    dagre.layout(g);
    classes.forEach((cl) => {
      const n = g.node(cl.id);
      boxes[cl.id].x = n.x; boxes[cl.id].y = n.y;
    });

    // user-saved arrangement (drag & drop, possibly carried across an LLM
    // edit) overrides the dagre layout; new classes slot in near neighbors
    const savedClassLayout = normalizeLayout(d._layout);
    const savedClassNodes = savedClassLayout && savedClassLayout.nodes;
    const savedPos = savedClassNodes && classes.some((c) => savedClassNodes[c.id])
      ? completePositions(classes, rels, savedClassNodes)
      : null;
    if (savedPos) {
      classes.forEach((cl) => {
        if (savedPos[cl.id]) { boxes[cl.id].x = savedPos[cl.id].x; boxes[cl.id].y = savedPos[cl.id].y; }
      });
    }

    let width = 300, height = 200;
    classes.forEach((cl) => {
      const b = boxes[cl.id];
      width = Math.max(width, b.x + b.w / 2 + 24);
      height = Math.max(height, b.y + b.h / 2 + 24);
    });
    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}` });
    const relEls = []; // live-updated while dragging a class box

    // markers
    const defs = svgEl('defs', {});
    function marker(id, w, h, refX, child) {
      const m = svgEl('marker', {
        id, viewBox: `0 0 ${w} ${h}`, refX, refY: h / 2,
        markerWidth: w, markerHeight: h, orient: 'auto-start-reverse',
      });
      m.appendChild(child);
      defs.appendChild(m);
    }
    marker('jbTri', 16, 14, 15, svgEl('path', { d: 'M1 1 L15 7 L1 13 z', fill: BG, stroke: FG, 'stroke-width': 1.3 }));
    marker('jbDiaF', 18, 10, 17, svgEl('path', { d: 'M1 5 L9 1 L17 5 L9 9 z', fill: FG }));
    marker('jbDiaH', 18, 10, 17, svgEl('path', { d: 'M1 5 L9 1 L17 5 L9 9 z', fill: BG, stroke: FG, 'stroke-width': 1.2 }));
    marker('jbVee', 12, 12, 11, svgEl('path', { d: 'M1 1 L11 6 L1 11', fill: 'none', stroke: FG, 'stroke-width': 1.5 }));
    svg.appendChild(defs);

    function borderPoint(box, tx, ty) {
      // intersection of segment (box center -> tx,ty) with box rectangle border
      const dx = tx - box.x, dy = ty - box.y;
      if (dx === 0 && dy === 0) { return { x: box.x, y: box.y }; }
      const sx = (box.w / 2) / Math.abs(dx || 1e-9);
      const sy = (box.h / 2) / Math.abs(dy || 1e-9);
      const s = Math.min(sx, sy);
      return { x: box.x + dx * s, y: box.y + dy * s };
    }

    // relations first (under boxes)
    rels.forEach((r) => {
      const A = boxes[r.from], B = boxes[r.to];
      if (!A || !B) { return; }
      const p1 = borderPoint(A, B.x, B.y);
      const p2 = borderPoint(B, A.x, A.y);
      const dashed = r.kind === 'implements' || r.kind === 'dependency';
      const markerEnd =
        r.kind === 'inheritance' || r.kind === 'implements' ? 'url(#jbTri)'
        : r.kind === 'composition' ? 'url(#jbDiaF)'
        : r.kind === 'aggregation' ? 'url(#jbDiaH)'
        : r.kind === 'dependency' || (r.kind === 'association' && r.directed) ? 'url(#jbVee)'
        : undefined;
      const rg = svgEl('g', {});
      const relLine = svgEl('line', {
        x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
        stroke: FG, 'stroke-width': 1.3,
        'stroke-dasharray': dashed ? '6 4' : undefined,
        'marker-end': markerEnd,
      });
      const relHit = svgEl('line', {
        x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
        stroke: 'transparent', 'stroke-width': 12,
      });
      rg.appendChild(relLine);
      rg.appendChild(relHit);
      relEls.push({ r, line: relLine, hit: relHit });
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      if (r.label) { labelWithBg(svg, mx, my - 5, r.label, { size: 11 }); }
      if (r.fromLabel) { labelWithBg(svg, p1.x + (p2.x >= p1.x ? 12 : -12), p1.y + (p2.y >= p1.y ? 14 : -8), r.fromLabel, { size: 10.5, fill: MUTED }); }
      if (r.toLabel) { labelWithBg(svg, p2.x + (p1.x >= p2.x ? 12 : -12), p2.y + (p1.y >= p2.y ? 16 : -10), r.toLabel, { size: 10.5, fill: MUTED }); }
      bindSvgItem(rg, r, (r.label || r.kind) + ` (${r.from} → ${r.to})`, 'relation · ' + r.kind);
      svg.appendChild(rg);
    });

    // class boxes
    classes.forEach((cl) => {
      const b = boxes[cl.id];
      const x0 = b.x - b.w / 2, y0 = b.y - b.h / 2;
      const cg = svgEl('g', {});
      cg.appendChild(svgEl('rect', {
        x: x0, y: y0, width: b.w, height: b.h,
        fill: BG, stroke: FG, 'stroke-width': 1.3,
      }));
      cg.appendChild(svgEl('rect', {
        x: x0, y: y0, width: b.w, height: b.nameH,
        fill: ACCENT, 'fill-opacity': 0.12, stroke: 'none',
      }));
      let ty = y0;
      if (b.cl.stereotype) {
        cg.appendChild(svgEl('text', {
          x: b.x, y: y0 + 15, fill: MUTED, 'font-size': 11, 'text-anchor': 'middle',
          'font-family': "-apple-system, sans-serif", 'font-style': 'italic',
        }, '«' + b.cl.stereotype + '»'));
        ty += 13;
      }
      cg.appendChild(svgEl('text', {
        x: b.x, y: ty + 18, fill: FG, 'font-size': 13, 'font-weight': 600, 'text-anchor': 'middle',
        'font-family': "-apple-system, sans-serif",
      }, b.name));
      cg.appendChild(svgEl('line', { x1: x0, y1: y0 + b.nameH, x2: x0 + b.w, y2: y0 + b.nameH, stroke: FG, 'stroke-width': 1 }));
      b.attrs.forEach((s, i) => {
        cg.appendChild(svgEl('text', {
          x: x0 + PAD, y: y0 + b.nameH + 14 + i * LINE, fill: FG, 'font-size': 12,
          'font-family': 'Menlo, Consolas, monospace',
        }, s));
      });
      cg.appendChild(svgEl('line', { x1: x0, y1: y0 + b.nameH + b.aH, x2: x0 + b.w, y2: y0 + b.nameH + b.aH, stroke: FG, 'stroke-width': 1 }));
      b.meths.forEach((s, i) => {
        cg.appendChild(svgEl('text', {
          x: x0 + PAD, y: y0 + b.nameH + b.aH + 14 + i * LINE, fill: FG, 'font-size': 12,
          'font-family': 'Menlo, Consolas, monospace',
        }, s));
      });
      bindSvgItem(cg, cl, b.name, 'class');
      attachClassDrag(cg, cl.id);
      cg.classList.add('draggable');
      svg.appendChild(cg);
    });

    // drag a class box: live-update its edges; persist + clean redraw on release
    function attachClassDrag(cg, clId) {
      cg.addEventListener('mousedown', (e) => {
        if (e.button !== 0) { return; }
        e.stopPropagation();
        const b = boxes[clId];
        const sx = e.clientX, sy = e.clientY, ox = b.x, oy = b.y;
        let moved = false;
        const move = (me) => {
          const kz = activeOps && activeOps.getZoom ? activeOps.getZoom() : 1;
          const dx = (me.clientX - sx) / kz, dy = (me.clientY - sy) / kz;
          if (!moved && Math.abs(dx) + Math.abs(dy) < 4) { return; }
          moved = true;
          b.x = ox + dx; b.y = oy + dy;
          cg.setAttribute('transform', `translate(${b.x - ox} ${b.y - oy})`);
          relEls.forEach((re) => {
            if (re.r.from !== clId && re.r.to !== clId) { return; }
            const A = boxes[re.r.from], B = boxes[re.r.to];
            if (!A || !B) { return; }
            const q1 = borderPoint(A, B.x, B.y), q2 = borderPoint(B, A.x, A.y);
            [re.line, re.hit].forEach((ln) => {
              ln.setAttribute('x1', q1.x); ln.setAttribute('y1', q1.y);
              ln.setAttribute('x2', q2.x); ln.setAttribute('y2', q2.y);
            });
          });
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          if (!moved) { return; }
          suppressClick = true;
          setTimeout(() => { suppressClick = false; }, 150);
          const positions = {};
          classes.forEach((c) => { positions[c.id] = { x: boxes[c.id].x, y: boxes[c.id].y }; });
          const prev = normalizeLayout(d._layout) || emptyLayout();
          const env = { v: LAYOUT_V, nodes: positions, edgeLabels: prev.edgeLabels || {} };
          d._layout = env;
          vscodeApi.postMessage({ type: 'layout', positions: env });
          const vpState = activeOps && activeOps.getState ? activeOps.getState() : null;
          render(d); // clean redraw so relation labels and sizing follow
          if (vpState && activeOps && activeOps.setState) { activeOps.setState(vpState); }
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
    }

    lastClassPositions = {};
    classes.forEach((cl) => { lastClassPositions[cl.id] = { x: boxes[cl.id].x, y: boxes[cl.id].y }; });

    stage.appendChild(svg);
    activeOps = makeSvgViewport(svg);
  }

  // ================================================================ SWIMLANE

  function renderSwimlane(d) {
    const horizontal = d.direction !== 'vertical';
    const lanes = d.lanes || [], nodes = d.nodes || [], edges = d.edges || [];
    const laneOrder = {};
    lanes.forEach((l, i) => { laneOrder[l.id] = i; });

    // step order along the flow axis: longest-path layering over the edges
    const col = {};
    nodes.forEach((n) => { col[n.id] = 0; });
    const idSet = new Set(nodes.map((n) => n.id));
    for (let pass = 0; pass < nodes.length; pass++) {
      let changed = false;
      edges.forEach((e) => {
        if (!idSet.has(e.from) || !idSet.has(e.to)) { return; }
        if (col[e.to] < col[e.from] + 1 && col[e.from] + 1 < nodes.length) {
          col[e.to] = col[e.from] + 1;
          changed = true;
        }
      });
      if (!changed) { break; }
    }
    const nCols = nodes.length ? Math.max(...nodes.map((n) => col[n.id])) + 1 : 1;

    // node dimensions (wrapped labels)
    const dims = {};
    nodes.forEach((n) => {
      const lines = wrapText(n.label || n.id, 150, SMALL_FONT);
      const w = Math.max(90, Math.min(176, lines.reduce((m, ln) => Math.max(m, tw(ln, SMALL_FONT)), 0) + 26));
      const h = Math.max(40, lines.length * 15 + 18);
      dims[n.id] = { w, h, lines };
    });

    // stacking inside each (lane, column) cell
    const cellCount = {}, rowIdx = {};
    nodes.forEach((n) => {
      const key = laneOrder[n.lane] + ':' + col[n.id];
      rowIdx[n.id] = cellCount[key] = (cellCount[key] || 0);
      cellCount[key]++;
    });
    const laneMetrics = lanes.map((l, li) => {
      let maxStack = 1, maxH = 40, maxW = 100;
      nodes.forEach((n) => {
        if (laneOrder[n.lane] !== li) { return; }
        maxStack = Math.max(maxStack, cellCount[li + ':' + col[n.id]]);
        maxH = Math.max(maxH, dims[n.id].h);
        maxW = Math.max(maxW, dims[n.id].w);
      });
      return horizontal
        ? { slot: maxH + 16, band: Math.max(84, maxStack * (maxH + 16) + 20) }
        : { slot: maxW + 16, band: Math.max(140, maxStack * (maxW + 16) + 24) };
    });
    const laneOffset = [];
    let acc = 0;
    laneMetrics.forEach((m) => { laneOffset.push(acc); acc += m.band; });
    const totalBand = acc;

    const HEADER = horizontal ? 118 : 40;
    const colStep = horizontal
      ? Math.max(...nodes.map((n) => dims[n.id].w), 100) + 64
      : Math.max(...nodes.map((n) => dims[n.id].h), 44) + 56;
    const flowLen = HEADER + 20 + nCols * colStep + 16;

    const width = horizontal ? flowLen : totalBand;
    const height = horizontal ? totalBand : flowLen;
    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}` });

    const defs = svgEl('defs', {});
    const mk = svgEl('marker', {
      id: 'swArr', viewBox: '0 0 10 10', refX: 9, refY: 5,
      markerWidth: 8.5, markerHeight: 8.5, orient: 'auto-start-reverse',
    });
    mk.appendChild(svgEl('path', { d: 'M0 0 L10 5 L0 10 z', fill: FG }));
    defs.appendChild(mk);
    svg.appendChild(defs);

    // lane bands + headers
    lanes.forEach((l, li) => {
      const color = l.color || MUTED;
      const g = svgEl('g', {});
      const bandRect = horizontal
        ? { x: 0, y: laneOffset[li], width, height: laneMetrics[li].band }
        : { x: laneOffset[li], y: 0, width: laneMetrics[li].band, height };
      g.appendChild(svgEl('rect', {
        ...bandRect, fill: color, 'fill-opacity': li % 2 ? 0.04 : 0.08,
        stroke: color, 'stroke-opacity': 0.35, 'stroke-width': 1,
      }));
      const label = l.label || l.id;
      const lines = wrapText(label, horizontal ? HEADER - 18 : laneMetrics[li].band - 18, UI_FONT_BOLD);
      const lx = horizontal ? 12 : laneOffset[li] + laneMetrics[li].band / 2;
      const ly0 = horizontal
        ? laneOffset[li] + laneMetrics[li].band / 2 - (lines.length - 1) * 7.5
        : 18;
      lines.forEach((ln, i) => {
        g.appendChild(svgEl('text', {
          x: lx, y: ly0 + i * 15 + 4, fill: FG, 'font-size': 12.5, 'font-weight': 600,
          'text-anchor': horizontal ? 'start' : 'middle',
          'font-family': "-apple-system, sans-serif",
        }, ln));
      });
      if (horizontal) {
        g.appendChild(svgEl('line', { x1: HEADER, y1: laneOffset[li], x2: HEADER, y2: laneOffset[li] + laneMetrics[li].band, stroke: color, 'stroke-opacity': 0.35 }));
      } else {
        g.appendChild(svgEl('line', { x1: laneOffset[li], y1: HEADER, x2: laneOffset[li] + laneMetrics[li].band, y2: HEADER, stroke: color, 'stroke-opacity': 0.35 }));
      }
      bindSvgItem(g, l, label, 'lane');
      svg.appendChild(g);
    });

    // node center rects
    const rect = {};
    nodes.forEach((n) => {
      const li = laneOrder[n.lane];
      if (li === undefined) { return; }
      const m = laneMetrics[li];
      const used = cellCount[li + ':' + col[n.id]] * m.slot;
      const stackStart = laneOffset[li] + (m.band - used) / 2 + m.slot / 2;
      const flowPos = HEADER + 20 + col[n.id] * colStep + colStep / 2;
      const lanePos = stackStart + rowIdx[n.id] * m.slot;
      rect[n.id] = horizontal
        ? { x: flowPos, y: lanePos, w: dims[n.id].w, h: dims[n.id].h }
        : { x: lanePos, y: flowPos, w: dims[n.id].w, h: dims[n.id].h };
    });

    // edges under nodes
    edges.forEach((e) => {
      const A = rect[e.from], B = rect[e.to];
      if (!A || !B) { return; }
      const p1 = rectBorderPoint(A, B.x, B.y);
      const p2 = rectBorderPoint(B, A.x, A.y);
      const g = svgEl('g', {});
      g.appendChild(svgEl('line', {
        x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
        stroke: e.color || FG, 'stroke-width': 1.4,
        'stroke-dasharray': e.style === 'dashed' ? '6 4' : e.style === 'dotted' ? '2 3' : undefined,
        'marker-end': 'url(#swArr)',
      }));
      g.appendChild(svgEl('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stroke: 'transparent', 'stroke-width': 12 }));
      if (e.label) { labelWithBg(svg, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2 - 5, e.label, { size: 11 }); }
      bindSvgItem(g, e, e.label || `${e.from} → ${e.to}`, 'edge');
      svg.appendChild(g);
    });

    // nodes
    nodes.forEach((n) => {
      const r = rect[n.id];
      if (!r) { return; }
      const color = n.color || ACCENT;
      const g = svgEl('g', {});
      if (n.shape === 'diamond') {
        const w2 = r.w / 2 + 14, h2 = r.h / 2 + 10;
        g.appendChild(svgEl('path', {
          d: `M${r.x} ${r.y - h2} L${r.x + w2} ${r.y} L${r.x} ${r.y + h2} L${r.x - w2} ${r.y} z`,
          fill: color, 'fill-opacity': 0.16, stroke: color, 'stroke-width': 1.4,
        }));
      } else if (n.shape === 'ellipse') {
        g.appendChild(svgEl('ellipse', {
          cx: r.x, cy: r.y, rx: r.w / 2 + 8, ry: r.h / 2 + 4,
          fill: color, 'fill-opacity': 0.16, stroke: color, 'stroke-width': 1.4,
        }));
      } else {
        g.appendChild(svgEl('rect', {
          x: r.x - r.w / 2, y: r.y - r.h / 2, width: r.w, height: r.h, rx: 6,
          fill: color, 'fill-opacity': 0.16, stroke: color, 'stroke-width': 1.4,
        }));
      }
      const lines = dims[n.id].lines;
      lines.forEach((ln, i) => {
        g.appendChild(svgEl('text', {
          x: r.x, y: r.y - (lines.length - 1) * 7.5 + i * 15 + 4,
          fill: FG, 'font-size': 12, 'text-anchor': 'middle',
          'font-family': "-apple-system, sans-serif",
        }, ln));
      });
      bindSvgItem(g, n, n.label || n.id, 'step');
      svg.appendChild(g);
    });

    stage.appendChild(svg);
    activeOps = makeSvgViewport(svg);
  }

  // ================================================================ TIMELINE

  function renderTimeline(d) {
    const items = d.items || [];
    const tracks = (d.tracks && d.tracks.length) ? d.tracks : [{ id: '__default', label: '' }];
    const trackOf = (it) => it.track || tracks[0].id;

    // categorical axis: explicit order, else first appearance
    const axis = (d.axisOrder || []).slice();
    const seen = new Set(axis);
    items.forEach((it) => {
      [it.start, it.end].forEach((s) => {
        if (s && !seen.has(s)) { seen.add(s); axis.push(s); }
      });
    });

    const HEADER_W = Math.max(24, ...tracks.map((t) => tw(t.label || (t.id === '__default' ? '' : t.id), UI_FONT_BOLD) + 24));
    const stepW = Math.max(96, ...axis.map((a) => tw(a, SMALL_FONT) + 36));
    const axisX = {};
    axis.forEach((a, i) => { axisX[a] = HEADER_W + 50 + i * stepW; });

    const ROW = 34, TOP = 44;
    const trackRows = tracks.map((t) => Math.max(1, items.filter((it) => trackOf(it) === t.id).length));
    const trackOffset = [];
    let acc = TOP;
    trackRows.forEach((rows) => { trackOffset.push(acc); acc += rows * ROW + 18; });
    const height = acc + 16;
    const width = HEADER_W + 50 + (axis.length ? (axis.length - 1) * stepW : 0) + Math.max(160, stepW);

    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}` });

    // axis header + gridlines
    axis.forEach((a) => {
      svg.appendChild(svgEl('line', {
        x1: axisX[a], y1: TOP - 12, x2: axisX[a], y2: height - 8,
        stroke: MUTED, 'stroke-width': 1, 'stroke-dasharray': '3 5', 'stroke-opacity': 0.5,
      }));
      svg.appendChild(svgEl('text', {
        x: axisX[a], y: 20, fill: MUTED, 'font-size': 11.5, 'font-weight': 600, 'text-anchor': 'middle',
        'font-family': "-apple-system, sans-serif",
      }, a));
    });

    // track bands + labels
    tracks.forEach((t, ti) => {
      const bandH = trackRows[ti] * ROW + 18;
      const color = t.color || MUTED;
      const g = svgEl('g', {});
      g.appendChild(svgEl('rect', {
        x: 0, y: trackOffset[ti] - 9, width, height: bandH,
        fill: color, 'fill-opacity': ti % 2 ? 0.03 : 0.06,
      }));
      const label = t.label || (t.id === '__default' ? '' : t.id);
      if (label) {
        g.appendChild(svgEl('text', {
          x: 12, y: trackOffset[ti] + bandH / 2 - 4, fill: FG, 'font-size': 12.5, 'font-weight': 600,
          'font-family': "-apple-system, sans-serif",
        }, label));
      }
      bindSvgItem(g, t, label, 'track');
      svg.appendChild(g);
    });

    // items: sub-row per item within its track, in array order
    const subRow = {};
    tracks.forEach((t) => { subRow[t.id] = 0; });
    items.forEach((it) => {
      const ti = tracks.findIndex((t) => t.id === trackOf(it));
      if (ti < 0 || axisX[it.start] === undefined) { return; }
      const y = trackOffset[ti] + subRow[trackOf(it)] * ROW + ROW / 2;
      subRow[trackOf(it)]++;
      const color = it.color || (tracks[ti].color || ACCENT);
      const g = svgEl('g', {});
      if (it.end && axisX[it.end] !== undefined && it.end !== it.start) {
        const x1 = axisX[it.start], x2 = axisX[it.end];
        g.appendChild(svgEl('rect', {
          x: Math.min(x1, x2), y: y - 9, width: Math.abs(x2 - x1), height: 18, rx: 9,
          fill: color, 'fill-opacity': 0.3, stroke: color, 'stroke-width': 1.2,
        }));
        const mid = (x1 + x2) / 2;
        if (tw(it.label, SMALL_FONT) + 14 < Math.abs(x2 - x1)) {
          g.appendChild(svgEl('text', {
            x: mid, y: y + 4, fill: FG, 'font-size': 11.5, 'text-anchor': 'middle',
            'font-family': "-apple-system, sans-serif",
          }, it.label));
        } else {
          labelWithBg(svg, Math.max(x1, x2) + 8, y + 4, it.label, { anchor: 'start', size: 11.5 });
        }
      } else {
        g.appendChild(svgEl('path', {
          d: `M${axisX[it.start]} ${y - 9} L${axisX[it.start] + 8} ${y} L${axisX[it.start]} ${y + 9} L${axisX[it.start] - 8} ${y} z`,
          fill: color, stroke: color, 'fill-opacity': 0.55, 'stroke-width': 1.2,
        }));
        labelWithBg(svg, axisX[it.start] + 13, y + 4, it.label, { anchor: 'start', size: 11.5 });
      }
      // generous hit area
      g.appendChild(svgEl('rect', {
        x: axisX[it.start] - 12, y: y - 13,
        width: (it.end && axisX[it.end] !== undefined ? Math.abs(axisX[it.end] - axisX[it.start]) : 0) + tw(it.label, SMALL_FONT) + 40,
        height: 26, fill: 'transparent',
      }));
      bindSvgItem(g, it, it.label, it.end ? 'span' : 'milestone');
      svg.appendChild(g);
    });

    stage.appendChild(svg);
    activeOps = makeSvgViewport(svg);
  }

  // ---------------------------------------------------------------- input relay
  // The webview is an iframe: mouse buttons 4/5 and some keybinding chords
  // never reach the workbench from here — relay them so Go Back / Go Forward
  // work while the diagram has focus. EXCEPTION: stock VS Code delivers mouse
  // buttons 4/5 to the workbench natively even from inside a webview
  // (workbench.editor.mouseBackForwardToNavigate); relaying there too caused
  // a single click to navigate back twice (field-confirmed). The extension
  // sets window.__jarboboMouseRelay = false for editors with that native
  // path; default true (relay) everywhere else, including this dev harness.
  if (window.__jarboboMouseRelay !== false) {
    window.addEventListener('mouseup', (e) => {
      if (e.button === 3) {
        e.preventDefault();
        vscodeApi.postMessage({ type: 'navigate', direction: 'back' });
      } else if (e.button === 4) {
        e.preventDefault();
        vscodeApi.postMessage({ type: 'navigate', direction: 'forward' });
      }
    });
  }
  window.addEventListener('keydown', (e) => {
    // default macOS chords: ctrl+- = Go Back, ctrl+shift+- = Go Forward
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '-' || e.key === '_')) {
      e.preventDefault();
      vscodeApi.postMessage({ type: 'navigate', direction: e.shiftKey ? 'forward' : 'back' });
    }
  });

  // ---------------------------------------------------------------- ready

  // After a window reload the serializer restores the tab; the diagram comes
  // back from our own persisted webview state without waiting on the extension.
  const savedState = vscodeApi.getState && vscodeApi.getState();
  if (savedState && savedState.diagram) { render(savedState.diagram); }

  vscodeApi.postMessage({ type: 'ready' });
})();
