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
  const ICON_EDIT = '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>';
  const ICON_FLIP = '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 14-5.3"/><path d="M18 3v4h-4"/><path d="M20 12a8 8 0 0 1-14 5.3"/><path d="M6 21v-4h4"/></svg>';

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
  const AVATAR_ID = '__avatar';
  const DEFAULT_PROFILE = { name: 'Б.Тэмүүлэн', email: 'temuulen@echina.mn' };
  let cards = [];
  let profile = Object.assign({}, DEFAULT_PROFILE, LS.get('echina.profile', {}));
  let avatarBlob = null;

  // older saves kept a single `blob`; treat it as the front side
  const normalize = r => ({ id: r.id, name: r.name || '', front: r.front || r.blob || null, back: r.back || null, createdAt: r.createdAt || 0, updatedAt: r.updatedAt || 0 });

  const urls = new Map();
  function urlFor(rec, side) {
    const blob = rec[side];
    if (!blob) return '';
    const key = `${rec.id}:${side}:${rec.updatedAt || rec.createdAt}`;
    if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob));
    return urls.get(key);
  }
  function pruneUrls() {
    const keep = new Set();
    cards.forEach(r => ['front', 'back'].forEach(s => keep.add(`${r.id}:${s}:${r.updatedAt || r.createdAt}`)));
    for (const [k, u] of urls) if (!keep.has(k)) { URL.revokeObjectURL(u); urls.delete(k); }
  }
  const findCard = id => cards.find(c => c.id === id);

  async function load() {
    const list = (await store.all()) || [];
    const av = list.find(r => r.id === AVATAR_ID);
    avatarBlob = av ? av.blob : null;
    cards = list.filter(r => !String(r.id).startsWith('__')).map(normalize).filter(r => r.front)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  // ---------- profile ----------
  function initialsOf(name) {
    const parts = String(name || '').split(/[\s.]+/).filter(Boolean);
    return parts.slice(0, 2).map(p => p[0]).join('').toUpperCase() || '?';
  }
  function setAvatar(imgEl, initialsEl, blob, name) {
    initialsEl.textContent = initialsOf(name);
    if (imgEl.dataset.url) URL.revokeObjectURL(imgEl.dataset.url);
    if (blob) {
      const u = URL.createObjectURL(blob);
      imgEl.dataset.url = u;
      imgEl.src = u; imgEl.hidden = false; initialsEl.hidden = true;
    } else {
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
  pfName.addEventListener('input', () => { $('#pfInitials').textContent = initialsOf(pfName.value); });
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
    profileDialog.close();
    toast('Профайл хадгалагдлаа');
  });
  $('#profileBtn').addEventListener('click', openProfile);
  $('#myInfoRow').addEventListener('click', openProfile);

  // ---------- carousel ----------
  const carousel = $('#carousel'), dots = $('#dots');
  let activeIndex = 0;

  function flipCard(rec) {
    const wrap = document.createElement('div');
    wrap.className = 'ccard flip';
    wrap.dataset.id = rec.id;

    const inner = document.createElement('button');
    inner.type = 'button';
    inner.className = 'inner';
    inner.setAttribute('aria-pressed', 'false');
    inner.setAttribute('aria-label', `${rec.name || 'Карт'}: эргүүлж ард талыг харах`);

    const front = document.createElement('span');
    front.className = 'face front';
    front.style.backgroundImage = `url("${urlFor(rec, 'front')}")`;
    if (rec.back) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.innerHTML = ICON_FLIP + 'Эргүүлэх';
      front.appendChild(hint);
    }

    const back = document.createElement('span');
    if (rec.back) {
      back.className = 'face back';
      back.style.backgroundImage = `url("${urlFor(rec, 'back')}")`;
    } else {
      back.className = 'face back empty';
      back.innerHTML = 'Ард талын зураг алга<small>Засах товчоор нэмнэ үү</small>';
    }
    inner.append(front, back);
    for (const side of ['l', 'r', 't', 'b']) {
      const e = document.createElement('span');
      e.className = 'edge ' + side;
      e.setAttribute('aria-hidden', 'true');
      inner.appendChild(e);
    }
    inner.addEventListener('click', () => {
      const i = [...carousel.children].indexOf(wrap);
      if (i >= 0 && i !== activeIndex) { scrollToIndex(i); return; }
      const on = !wrap.classList.contains('flipped');
      wrap.classList.toggle('flipped', on);
      inner.setAttribute('aria-pressed', String(on));
    });

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'edit';
    edit.setAttribute('aria-label', `${rec.name || 'Карт'} засах`);
    edit.innerHTML = ICON_EDIT;
    edit.addEventListener('click', () => openSheet({ mode: 'edit', id: rec.id }));

    wrap.append(inner, edit);
    return wrap;
  }

  function render(focusId) {
    pruneUrls();
    carousel.replaceChildren();
    cards.forEach(c => carousel.appendChild(flipCard(c)));

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'ccard add';
    add.dataset.id = '__add';
    add.innerHTML = '<span class="plus" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span><strong>Карт нэмэх</strong><small>Урд, ард талын зургийг оруулна</small>';
    add.addEventListener('click', () => openSheet({ mode: 'add' }));
    carousel.appendChild(add);

    dots.replaceChildren();
    for (let i = 0; i < carousel.children.length; i++) dots.appendChild(document.createElement('span'));

    $('#statCount').textContent = cards.length;
    const bytes = cards.reduce((s, c) => s + (c.front ? c.front.size : 0) + (c.back ? c.back.size : 0), 0);
    $('#statSize').textContent = (bytes / 1048576).toFixed(1) + ' MB';
    const last = cards.reduce((m, c) => Math.max(m, c.updatedAt || c.createdAt), 0);
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

  // Coverflow: side cards turn toward the centre so their edges show
  function updateCarousel() {
    const mid = carousel.scrollLeft + carousel.clientWidth / 2;
    let best = 0, bestD = Infinity;
    [...carousel.children].forEach((el, i) => {
      const c = el.offsetLeft + el.offsetWidth / 2;
      const raw = (c - mid) / (el.offsetWidth + 12);
      const s = Math.max(-1, Math.min(1, raw));
      const a = Math.abs(s);
      // inner edge turns toward the viewer, so the card's thickness shows
      el.style.transform = `perspective(900px) translateX(${(-s * 22).toFixed(1)}px) rotateY(${(s * 30).toFixed(2)}deg) scale(${(1 - a * 0.16).toFixed(3)})`;
      if (el.classList.contains('flip')) el.style.setProperty('--dim', (a * 0.4).toFixed(3));
      else el.style.opacity = String(1 - a * 0.45);
      const d = Math.abs(c - mid);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best !== activeIndex) {
      [...carousel.children].forEach((el, i) => {
        if (i !== best && el.classList.contains('flipped')) {
          el.classList.remove('flipped');
          const btn = el.querySelector('.inner');
          if (btn) btn.setAttribute('aria-pressed', 'false');
        }
      });
    }
    activeIndex = best;
    [...carousel.children].forEach((el, i) => el.classList.toggle('active', i === best));
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
  const nameInput = $('#cardName'), saveBtn = $('#saveAdd'), sheetDelete = $('#deleteFromSheet');
  const slots = { front: $('#slotFront'), back: $('#slotBack') };
  const removeBackBtn = $('#removeBack');
  let sheet = { mode: 'add' };
  // per side: undefined = unchanged, null = removed, Blob = new image
  let pending = {};
  const tmpUrls = [];

  function showSlot(side, url) {
    const slot = slots[side];
    const img = slot.querySelector('img');
    const empty = slot.querySelector('.slot-empty');
    if (url) { img.src = url; img.hidden = false; empty.hidden = true; slot.classList.add('has'); }
    else { img.removeAttribute('src'); img.hidden = true; empty.hidden = false; slot.classList.remove('has'); }
    if (side === 'back') removeBackBtn.hidden = !url;
  }
  function currentHas(side) {
    if (pending[side] instanceof Blob) return true;
    if (pending[side] === null) return false;
    const rec = sheet.id && findCard(sheet.id);
    return !!(rec && rec[side]);
  }
  function updateSave() { saveBtn.disabled = !currentHas('front'); }

  function resetSheet() {
    pending = {};
    tmpUrls.splice(0).forEach(u => URL.revokeObjectURL(u));
    showSlot('front', ''); showSlot('back', '');
    nameInput.value = '';
    $('#fileFront').value = ''; $('#fileBack').value = '';
    saveBtn.disabled = true;
  }
  function openSheet(opts) {
    resetSheet();
    sheet = opts;
    if (opts.mode === 'edit') {
      const rec = findCard(opts.id);
      if (!rec) return;
      $('#addTitle').textContent = 'Карт засах';
      showSlot('front', urlFor(rec, 'front'));
      showSlot('back', urlFor(rec, 'back'));
      nameInput.value = rec.name;
      sheetDelete.hidden = false;
    } else {
      $('#addTitle').textContent = 'Карт нэмэх';
      sheetDelete.hidden = true;
    }
    updateSave();
    addDialog.showModal();
  }

  async function onSlotFile(side, e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!checkFile(file)) return;
    try {
      const blob = await resizeImage(file);
      pending[side] = blob;
      const u = URL.createObjectURL(blob);
      tmpUrls.push(u);
      showSlot(side, u);
      updateSave();
    } catch {
      toast('Зургийг уншиж чадсангүй, өөр зураг сонгоно уу');
    }
  }
  $('#fileFront').addEventListener('change', e => onSlotFile('front', e));
  $('#fileBack').addEventListener('change', e => onSlotFile('back', e));
  removeBackBtn.addEventListener('click', () => { pending.back = null; showSlot('back', ''); });
  $('#cancelAdd').addEventListener('click', () => addDialog.close());
  addDialog.addEventListener('close', resetSheet);

  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const now = Date.now();
    const pick = (side, old) => pending[side] === undefined ? old : pending[side];
    let rec;
    if (sheet.mode === 'edit') {
      const old = findCard(sheet.id);
      if (!old) return;
      rec = { ...old, name, front: pick('front', old.front), back: pick('back', old.back), updatedAt: now };
    } else {
      rec = { id: uid(), name, front: pending.front || null, back: pending.back || null, createdAt: now, updatedAt: 0 };
    }
    if (!rec.front) { toast('Урд талын зургийг оруулна уу'); return; }
    saveBtn.disabled = true;
    try {
      await store.put(rec);
    } catch {
      saveBtn.disabled = false;
      toast('Хадгалах зай хүрэлцэхгүй байна');
      return;
    }
    const mode = sheet.mode;
    if (mode === 'edit') cards = cards.map(c => c.id === rec.id ? rec : c);
    else cards.push(rec);
    addDialog.close();
    render(rec.id);
    toast(mode === 'edit' ? 'Карт шинэчлэгдлээ' : 'Карт нэмэгдлээ');
  });

  async function deleteCard(id) {
    if (!confirm('Энэ картыг устгах уу?')) return false;
    await store.remove(id);
    cards = cards.filter(c => c.id !== id);
    render();
    toast('Карт устгагдлаа');
    return true;
  }
  sheetDelete.addEventListener('click', async () => {
    if (sheet.id && await deleteCard(sheet.id)) addDialog.close();
  });

  // ---------- viewer (both sides) ----------
  const viewDialog = $('#viewDialog');
  let viewingId = null;
  function openViewer(id) {
    const rec = findCard(id);
    if (!rec) return;
    viewingId = id;
    $('#viewTitle').textContent = rec.name || 'Карт';
    $('#viewFront').src = urlFor(rec, 'front');
    const hasBack = !!rec.back;
    $('#viewBackWrap').hidden = !hasBack;
    if (hasBack) $('#viewBack').src = urlFor(rec, 'back');
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
    if (!cards.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'Одоогоор карт алга байна.';
      grid.appendChild(p);
    } else {
      cards.forEach(c => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ccard';
        b.style.backgroundImage = `url("${urlFor(c, 'front')}")`;
        b.setAttribute('aria-label', `${c.name || 'Карт'} нээх`);
        if (c.name) {
          const cap = document.createElement('span');
          cap.className = 'cap';
          cap.textContent = c.name;
          b.appendChild(cap);
        }
        b.addEventListener('click', () => openViewer(c.id));
        grid.appendChild(b);
      });
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
