(() => {
  'use strict';

  // ---------- storage (IndexedDB, falls back to memory) ----------
  const DB_NAME = 'echina', STORE = 'cards';
  let memory = null;
  function openDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('no-idb'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function run(mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  function fallBack() {
    if (!memory) { memory = []; toast('Энэ хөтөч дээр хадгалах боломжгүй тул түр хадгална'); }
  }
  const store = {
    async all() {
      if (memory) return memory.slice();
      try { return await run('readonly', s => s.getAll()); }
      catch { fallBack(); return []; }
    },
    async put(rec) {
      if (!memory) {
        try { await run('readwrite', s => s.put(rec)); return; }
        catch (e) { if (e && e.name === 'QuotaExceededError') throw e; fallBack(); }
      }
      memory = memory.filter(r => r.id !== rec.id).concat(rec);
    },
    async remove(id) {
      if (!memory) {
        try { await run('readwrite', s => s.delete(id)); return; }
        catch { fallBack(); }
      }
      memory = memory.filter(r => r.id !== id);
    }
  };
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } }
  };

  // ---------- helpers ----------
  const $ = s => document.querySelector(s);
  const toastEl = $('#toast');
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  async function resizeImage(file, max = 1600) {
    let src, w, h;
    try {
      src = await createImageBitmap(file, { imageOrientation: 'from-image' });
      w = src.width; h = src.height;
    } catch {
      const url = URL.createObjectURL(file);
      src = new Image(); src.src = url;
      await src.decode();
      w = src.naturalWidth; h = src.naturalHeight;
      URL.revokeObjectURL(url);
    }
    const k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    if (src.close) src.close();
    return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('encode')), 'image/jpeg', 0.85));
  }
  function checkFile(file) {
    if (!file) return false;
    if (!file.type.startsWith('image/')) { toast('Зөвхөн зураг оруулна уу'); return false; }
    if (file.size > 25 * 1048576) { toast('Зураг хэт том байна (25MB-аас бага)'); return false; }
    return true;
  }

  // ---------- data ----------
  // Built-in cards, same as the Figma "Wallet Card" instances
  const DEMO = [
    { id: 'demo:0', kind: 'Гишүүн · Gold', val: '12 480', vl: 'урамшууллын оноо', code: 'EC 4821 0937', bg: 'linear-gradient(135deg,#ffd27f,#f08a4b)', fg: '#2b1a0e' },
    { id: 'demo:1', kind: 'Echina Pay', val: '₮245 000', vl: 'хэтэвчний үлдэгдэл', code: '•••• 3310', bg: 'linear-gradient(135deg,#5b8cff,#6a3df0)', fg: '#ffffff' },
    { id: 'demo:2', kind: 'Тасалбар', val: '3', vl: 'идэвхтэй тасалбар', code: '2026.12.31 хүртэл', bg: 'linear-gradient(135deg,#5ee8c8,#22a7b8)', fg: '#05201c' }
  ];
  const AVATAR_ID = '__avatar';
  const DEFAULT_PROFILE = { name: 'Б.Тэмүүлэн', email: 'temuulen@echina.mn' };

  let cards = [];                 // user cards
  let overrides = new Map();      // demo id -> user image record
  let hiddenDemos = LS.get('echina.hiddenDemos', []);
  let profile = Object.assign({}, DEFAULT_PROFILE, LS.get('echina.profile', {}));
  let avatarBlob = null;

  const urls = new Map();
  function urlFor(rec) {
    const key = rec.id + ':' + (rec.updatedAt || rec.createdAt || 0);
    if (!urls.has(key)) urls.set(key, URL.createObjectURL(rec.blob));
    return urls.get(key);
  }
  function pruneUrls() {
    const keep = new Set([...cards, ...overrides.values()].map(r => r.id + ':' + (r.updatedAt || r.createdAt || 0)));
    for (const [k, u] of urls) if (!keep.has(k)) { URL.revokeObjectURL(u); urls.delete(k); }
  }
  const findCard = id => overrides.get(id) || cards.find(c => c.id === id);

  async function load() {
    const list = (await store.all()) || [];
    const av = list.find(r => r.id === AVATAR_ID);
    avatarBlob = av ? av.blob : null;
    overrides = new Map(list.filter(r => r.id.startsWith('demo:')).map(r => [r.id, r]));
    cards = list.filter(r => !r.id.startsWith('demo:') && !r.id.startsWith('__'))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  // ---------- profile ----------
  function initialsOf(name) {
    const parts = String(name || '').split(/[\s.]+/).filter(Boolean);
    const s = parts.slice(0, 2).map(p => p[0]).join('').toUpperCase();
    return s || '?';
  }
  function setAvatar(imgEl, initialsEl, blob, name) {
    initialsEl.textContent = initialsOf(name);
    if (blob) {
      const u = URL.createObjectURL(blob);
      if (imgEl.dataset.url) URL.revokeObjectURL(imgEl.dataset.url);
      imgEl.dataset.url = u;
      imgEl.src = u; imgEl.hidden = false; initialsEl.hidden = true;
    } else {
      if (imgEl.dataset.url) URL.revokeObjectURL(imgEl.dataset.url);
      delete imgEl.dataset.url;
      imgEl.removeAttribute('src'); imgEl.hidden = true; initialsEl.hidden = false;
    }
  }
  function renderProfile() {
    $('#profileName').textContent = profile.name;
    $('#profileEmail').textContent = profile.email || 'Имэйл нэмэх';
    setAvatar($('#avatarImg'), $('#initials'), avatarBlob, profile.name);
  }

  const profileDialog = $('#profileDialog');
  const pfName = $('#pfName'), pfEmail = $('#pfEmail'), pfError = $('#pfError');
  let pfPending; // undefined = unchanged, null = removed, Blob = new photo
  function openProfile() {
    pfPending = undefined;
    pfName.value = profile.name;
    pfEmail.value = profile.email;
    pfError.hidden = true;
    $('#pfAvatarFile').value = '';
    setAvatar($('#pfAvatarImg'), $('#pfInitials'), avatarBlob, profile.name);
    profileDialog.showModal();
  }
  pfName.addEventListener('input', () => {
    if (!$('#pfInitials').hidden || pfPending === null) $('#pfInitials').textContent = initialsOf(pfName.value);
  });
  $('#pfAvatarFile').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    if (!checkFile(file)) return;
    try {
      pfPending = await resizeImage(file, 512);
      setAvatar($('#pfAvatarImg'), $('#pfInitials'), pfPending, pfName.value);
    } catch { toast('Зургийг уншиж чадсангүй, өөр зураг сонгоно уу'); }
  });
  $('#pfAvatarRemove').addEventListener('click', () => {
    pfPending = null;
    setAvatar($('#pfAvatarImg'), $('#pfInitials'), null, pfName.value);
  });
  $('#pfCancel').addEventListener('click', () => profileDialog.close());
  $('#pfSave').addEventListener('click', async () => {
    const name = pfName.value.trim();
    const email = pfEmail.value.trim();
    if (!name) { pfError.textContent = 'Нэрээ оруулна уу'; pfError.hidden = false; pfName.focus(); return; }
    if (email && !pfEmail.checkValidity()) { pfError.textContent = 'Имэйл хаяг буруу байна'; pfError.hidden = false; pfEmail.focus(); return; }
    pfError.hidden = true;
    try {
      if (pfPending instanceof Blob) { await store.put({ id: AVATAR_ID, blob: pfPending, createdAt: Date.now() }); avatarBlob = pfPending; }
      else if (pfPending === null) { await store.remove(AVATAR_ID); avatarBlob = null; }
    } catch { toast('Зураг хадгалах зай хүрэлцэхгүй байна'); return; }
    profile = { name, email };
    LS.set('echina.profile', profile);
    renderProfile();
    render();
    profileDialog.close();
    toast('Профайл хадгалагдлаа');
  });
  $('#profileBtn').addEventListener('click', openProfile);
  $('#myInfoRow').addEventListener('click', openProfile);

  // ---------- carousel ----------
  const carousel = $('#carousel'), dots = $('#dots');
  let activeIndex = 1; // Figma shows Echina Pay centred

  function demoCard(d) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ccard demo';
    b.dataset.id = d.id;
    b.style.setProperty('--cbg', d.bg);
    b.style.setProperty('--fg', d.fg);
    b.setAttribute('aria-label', `${d.kind} картыг засах`);
    b.innerHTML =
      '<span class="ctop"><span class="brand"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M18.5 15.5A7.5 7.5 0 1 1 19 9H8"/></svg>ECHINA</span><span class="kind"></span></span>' +
      '<span class="cval"><span class="val"></span><span class="vl"></span></span>' +
      '<span class="cbot"><span class="holder"></span><span class="code"></span></span>';
    b.querySelector('.kind').textContent = d.kind;
    b.querySelector('.val').textContent = d.val;
    b.querySelector('.vl').textContent = d.vl;
    b.querySelector('.holder').textContent = profile.name.toUpperCase();
    b.querySelector('.code').textContent = d.code;
    b.addEventListener('click', () => openSheet({ mode: 'demo', id: d.id }));
    return b;
  }

  function imageCard(rec) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ccard';
    b.dataset.id = rec.id;
    b.style.backgroundImage = `url("${urlFor(rec)}")`;
    b.setAttribute('aria-label', `${rec.name} картыг нээх`);
    const cap = document.createElement('span');
    cap.className = 'cap';
    cap.textContent = rec.name;
    b.appendChild(cap);
    b.addEventListener('click', () => openViewer(rec.id));
    return b;
  }

  function render(focusId) {
    pruneUrls();
    carousel.replaceChildren();
    DEMO.forEach((d, i) => {
      const o = overrides.get(d.id);
      if (o) carousel.appendChild(imageCard(o));
      else if (!hiddenDemos.includes(i)) carousel.appendChild(demoCard(d));
    });
    cards.forEach(c => carousel.appendChild(imageCard(c)));

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'ccard add';
    add.innerHTML = '<span class="plus" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span><strong>Карт нэмэх</strong><small>Картынхаа зургийг оруулаарай</small>';
    add.addEventListener('click', () => openSheet({ mode: 'add' }));
    carousel.appendChild(add);

    dots.replaceChildren();
    for (let i = 0; i < carousel.children.length; i++) dots.appendChild(document.createElement('span'));

    const all = [...cards, ...overrides.values()];
    $('#statCount').textContent = all.length;
    const bytes = all.reduce((s, c) => s + (c.blob ? c.blob.size : 0), 0);
    $('#statSize').textContent = (bytes / 1048576).toFixed(1) + ' MB';
    const last = all.reduce((m, c) => Math.max(m, c.updatedAt || c.createdAt || 0), 0);
    $('#statLast').textContent = last ? new Date(last).toLocaleDateString('mn-MN', { month: '2-digit', day: '2-digit' }) : '—';

    if (focusId) {
      const idx = [...carousel.children].findIndex(el => el.dataset.id === focusId);
      if (idx >= 0) activeIndex = idx;
    }
    activeIndex = Math.max(0, Math.min(activeIndex, carousel.children.length - 1));
    requestAnimationFrame(() => { scrollToIndex(activeIndex, false); updateCarousel(); });
  }

  function scrollToIndex(i, smooth = true) {
    const el = carousel.children[i];
    if (!el) return;
    const left = el.offsetLeft - (carousel.clientWidth - el.offsetWidth) / 2;
    carousel.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
  }
  function updateCarousel() {
    const mid = carousel.scrollLeft + carousel.clientWidth / 2;
    let best = 0, bestD = Infinity;
    [...carousel.children].forEach((el, i) => {
      const c = el.offsetLeft + el.offsetWidth / 2;
      const d = Math.abs(c - mid);
      const t = Math.min(d / (el.offsetWidth + 12), 1);
      el.style.transform = `scale(${1 - t * 0.12})`;
      el.style.opacity = String(1 - t * 0.5);
      if (d < bestD) { bestD = d; best = i; }
    });
    activeIndex = best;
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i === best));
  }
  let raf = 0;
  carousel.addEventListener('scroll', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(updateCarousel);
  }, { passive: true });
  window.addEventListener('resize', () => requestAnimationFrame(updateCarousel));

  // ---------- add / edit sheet ----------
  const addDialog = $('#addDialog');
  const previewImg = $('#previewImg'), previewEmpty = $('#previewEmpty'), preview = $('#preview');
  const nameInput = $('#cardName'), saveBtn = $('#saveAdd'), sheetDelete = $('#deleteFromSheet');
  let sheet = { mode: 'add' };
  let pendingBlob = null, pendingUrl = null;

  function clearPreview() {
    preview.querySelectorAll('.ccard').forEach(n => n.remove());
    previewImg.hidden = true; previewImg.removeAttribute('src');
    previewEmpty.hidden = false; preview.classList.remove('has');
  }
  function showPreviewUrl(u) {
    preview.querySelectorAll('.ccard').forEach(n => n.remove());
    previewImg.src = u; previewImg.hidden = false;
    previewEmpty.hidden = true; preview.classList.add('has');
  }
  function resetSheet() {
    pendingBlob = null;
    if (pendingUrl) URL.revokeObjectURL(pendingUrl);
    pendingUrl = null;
    clearPreview();
    nameInput.value = '';
    $('#fileGallery').value = ''; $('#fileCamera').value = '';
    saveBtn.disabled = true;
  }
  function openSheet(opts) {
    resetSheet();
    sheet = opts;
    const title = $('#addTitle');
    if (opts.mode === 'add') {
      title.textContent = 'Карт нэмэх';
      sheetDelete.hidden = true;
    } else if (opts.mode === 'edit') {
      const rec = findCard(opts.id);
      if (!rec) return;
      title.textContent = 'Карт засах';
      showPreviewUrl(urlFor(rec));
      nameInput.value = rec.name;
      saveBtn.disabled = false;
      sheetDelete.hidden = false;
    } else if (opts.mode === 'demo') {
      const d = DEMO.find(x => x.id === opts.id);
      title.textContent = 'Карт засах';
      const clone = demoCard(d);
      clone.tabIndex = -1;
      previewEmpty.hidden = true; preview.classList.add('has');
      preview.appendChild(clone);
      nameInput.value = d.kind;
      sheetDelete.hidden = false;
    }
    addDialog.showModal();
  }

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!checkFile(file)) return;
    saveBtn.disabled = true;
    try {
      pendingBlob = await resizeImage(file);
      if (pendingUrl) URL.revokeObjectURL(pendingUrl);
      pendingUrl = URL.createObjectURL(pendingBlob);
      showPreviewUrl(pendingUrl);
      saveBtn.disabled = false;
      if (!nameInput.value) nameInput.focus();
    } catch {
      toast('Зургийг уншиж чадсангүй, өөр зураг сонгоно уу');
      saveBtn.disabled = sheet.mode !== 'edit';
    }
  }
  $('#fileGallery').addEventListener('change', onFile);
  $('#fileCamera').addEventListener('change', onFile);
  $('#cancelAdd').addEventListener('click', () => addDialog.close());
  addDialog.addEventListener('close', resetSheet);

  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const now = Date.now();
    let rec;
    if (sheet.mode === 'add') {
      if (!pendingBlob) return;
      rec = { id: uid(), name: name || `Карт ${cards.length + 1}`, blob: pendingBlob, createdAt: now };
    } else if (sheet.mode === 'edit') {
      const old = findCard(sheet.id);
      if (!old) return;
      rec = Object.assign({}, old, { name: name || old.name, blob: pendingBlob || old.blob, updatedAt: now });
    } else {
      if (!pendingBlob) return;
      const d = DEMO.find(x => x.id === sheet.id);
      rec = { id: d.id, name: name || d.kind, blob: pendingBlob, createdAt: now };
    }
    saveBtn.disabled = true;
    try {
      await store.put(rec);
    } catch {
      saveBtn.disabled = false;
      toast('Хадгалах зай хүрэлцэхгүй байна');
      return;
    }
    if (rec.id.startsWith('demo:')) overrides.set(rec.id, rec);
    else if (sheet.mode === 'add') cards.push(rec);
    else cards = cards.map(c => c.id === rec.id ? rec : c);
    const mode = sheet.mode;
    addDialog.close();
    render(rec.id);
    toast(mode === 'add' ? 'Карт нэмэгдлээ' : 'Карт шинэчлэгдлээ');
  });

  async function deleteCard(id) {
    if (!confirm('Энэ картыг устгах уу?')) return false;
    if (id.startsWith('demo:')) {
      if (overrides.has(id)) { await store.remove(id); overrides.delete(id); }
      const i = DEMO.findIndex(d => d.id === id);
      if (!hiddenDemos.includes(i)) { hiddenDemos.push(i); LS.set('echina.hiddenDemos', hiddenDemos); }
    } else {
      await store.remove(id);
      cards = cards.filter(c => c.id !== id);
    }
    render();
    toast('Карт устгагдлаа');
    return true;
  }
  sheetDelete.addEventListener('click', async () => {
    if (sheet.id && await deleteCard(sheet.id)) addDialog.close();
  });

  // ---------- viewer ----------
  const viewDialog = $('#viewDialog');
  let viewingId = null;
  function openViewer(id) {
    const rec = findCard(id);
    if (!rec) return;
    viewingId = id;
    $('#viewTitle').textContent = rec.name;
    const img = $('#viewImg');
    img.src = urlFor(rec); img.alt = rec.name;
    if (allDialog.open) allDialog.close();
    viewDialog.showModal();
  }
  $('#closeView').addEventListener('click', () => viewDialog.close());
  $('#editCard').addEventListener('click', () => {
    const id = viewingId;
    viewDialog.close();
    if (id) openSheet({ mode: 'edit', id });
  });
  $('#deleteCard').addEventListener('click', async () => {
    if (viewingId && await deleteCard(viewingId)) { viewingId = null; viewDialog.close(); }
  });

  // ---------- all cards ----------
  const allDialog = $('#allDialog');
  $('#allBtn').addEventListener('click', () => {
    const grid = $('#grid');
    grid.replaceChildren();
    const items = [...carousel.children].filter(el => !el.classList.contains('add'));
    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'Одоогоор карт алга байна.';
      grid.appendChild(p);
    } else {
      DEMO.forEach((d, i) => {
        const o = overrides.get(d.id);
        if (o) grid.appendChild(imageCard(o));
        else if (!hiddenDemos.includes(i)) {
          const b = demoCard(d);
          b.addEventListener('click', () => allDialog.close());
          grid.appendChild(b);
        }
      });
      cards.forEach(c => grid.appendChild(imageCard(c)));
    }
    allDialog.showModal();
  });
  $('#closeAll').addEventListener('click', () => allDialog.close());

  // close sheets on backdrop tap
  for (const d of [addDialog, allDialog, profileDialog]) {
    d.addEventListener('click', e => {
      const r = d.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) d.close();
    });
  }

  // ---------- misc ----------
  const refreshBtn = $('#refreshBtn');
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.classList.add('busy');
    refreshBtn.disabled = true;
    await load();
    renderProfile();
    render();
    refreshBtn.classList.remove('busy');
    refreshBtn.disabled = false;
    toast('Шинэчлэгдлээ');
  });
  $('#fab').addEventListener('click', () => openSheet({ mode: 'add' }));
  const expandBtn = $('#expandBtn'), stats = $('#stats');
  expandBtn.addEventListener('click', () => {
    const open = expandBtn.getAttribute('aria-expanded') !== 'true';
    expandBtn.setAttribute('aria-expanded', String(open));
    stats.hidden = !open;
  });
  document.querySelectorAll('[data-soon]').forEach(el => el.addEventListener('click', () => toast('Удахгүй нэмэгдэнэ')));
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    if (t.dataset.tab !== 'profile') toast('Удахгүй нэмэгдэнэ');
  }));

  // ---------- boot ----------
  renderProfile();
  load().then(() => { renderProfile(); render(); });
})();
