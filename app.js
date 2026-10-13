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
  const store = {
    async all() {
      if (memory) return memory.slice();
      try { return await run('readonly', s => s.getAll()); }
      catch { memory = []; toast('Энэ хөтөч дээр хадгалах боломжгүй тул түр хадгална'); return []; }
    },
    async put(card) {
      if (memory) { memory.push(card); return; }
      try { await run('readwrite', s => s.put(card)); }
      catch (e) {
        if (e && e.name === 'QuotaExceededError') throw e;
        memory = [card]; toast('Энэ хөтөч дээр хадгалах боломжгүй тул түр хадгална');
      }
    },
    async remove(id) {
      if (memory) { memory = memory.filter(c => c.id !== id); return; }
      await run('readwrite', s => s.delete(id));
    }
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

  async function resizeImage(file) {
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
    const k = Math.min(1, 1600 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    if (src.close) src.close();
    return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('encode')), 'image/jpeg', 0.85));
  }

  // ---------- state ----------
  let cards = [];
  let urls = new Map();
  let activeIndex = 0;

  function urlFor(card) {
    if (!urls.has(card.id)) urls.set(card.id, URL.createObjectURL(card.blob));
    return urls.get(card.id);
  }
  function pruneUrls() {
    const ids = new Set(cards.map(c => c.id));
    for (const [id, u] of urls) if (!ids.has(id)) { URL.revokeObjectURL(u); urls.delete(id); }
  }

  // ---------- render ----------
  const carousel = $('#carousel'), dots = $('#dots');

  function cardButton(card, extraClass = '') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ccard ' + extraClass;
    b.style.backgroundImage = `url("${urlFor(card)}")`;
    b.setAttribute('aria-label', `${card.name} картыг нээх`);
    const cap = document.createElement('span');
    cap.className = 'cap';
    cap.textContent = card.name;
    b.appendChild(cap);
    b.addEventListener('click', () => openViewer(card.id));
    return b;
  }

  function render() {
    pruneUrls();
    carousel.replaceChildren();
    cards.forEach(c => carousel.appendChild(cardButton(c)));

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'ccard add';
    add.innerHTML = '<span class="plus" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span><strong>Карт нэмэх</strong><small>Картынхаа зургийг оруулаарай</small>';
    add.addEventListener('click', openAdd);
    carousel.appendChild(add);

    dots.replaceChildren();
    for (let i = 0; i <= cards.length; i++) dots.appendChild(document.createElement('span'));

    // summary + stats
    $('#summary').innerHTML = cards.length
      ? `Танд <b>${cards.length}</b> карт хадгалагдсан байна.`
      : 'Картынхаа зургийг нэмж <b>нэг дор</b> хадгалаарай.';
    $('#statCount').textContent = cards.length;
    const bytes = cards.reduce((s, c) => s + (c.blob ? c.blob.size : 0), 0);
    $('#statSize').textContent = (bytes / 1048576).toFixed(1) + ' MB';
    const last = cards.reduce((m, c) => Math.max(m, c.createdAt || 0), 0);
    $('#statLast').textContent = last ? new Date(last).toLocaleDateString('mn-MN', { month: '2-digit', day: '2-digit' }) : '—';

    activeIndex = Math.min(activeIndex, cards.length);
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

  // ---------- add dialog ----------
  const addDialog = $('#addDialog');
  const previewImg = $('#previewImg'), previewEmpty = $('#previewEmpty'), preview = $('#preview');
  const nameInput = $('#cardName'), saveBtn = $('#saveAdd');
  let pendingBlob = null, pendingUrl = null;

  function resetAdd() {
    pendingBlob = null;
    if (pendingUrl) URL.revokeObjectURL(pendingUrl);
    pendingUrl = null;
    previewImg.hidden = true; previewImg.removeAttribute('src');
    previewEmpty.hidden = false; preview.classList.remove('has');
    nameInput.value = '';
    $('#fileGallery').value = ''; $('#fileCamera').value = '';
    saveBtn.disabled = true;
  }
  function openAdd() { resetAdd(); addDialog.showModal(); }

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('Зөвхөн зураг оруулна уу'); return; }
    if (file.size > 25 * 1048576) { toast('Зураг хэт том байна (25MB-аас бага)'); return; }
    saveBtn.disabled = true;
    try {
      pendingBlob = await resizeImage(file);
      if (pendingUrl) URL.revokeObjectURL(pendingUrl);
      pendingUrl = URL.createObjectURL(pendingBlob);
      previewImg.src = pendingUrl;
      previewImg.hidden = false; previewEmpty.hidden = true; preview.classList.add('has');
      saveBtn.disabled = false;
      if (!nameInput.value) nameInput.focus();
    } catch {
      toast('Зургийг уншиж чадсангүй, өөр зураг сонгоно уу');
    }
  }
  $('#fileGallery').addEventListener('change', onFile);
  $('#fileCamera').addEventListener('change', onFile);
  $('#cancelAdd').addEventListener('click', () => addDialog.close());
  addDialog.addEventListener('close', resetAdd);

  saveBtn.addEventListener('click', async () => {
    if (!pendingBlob) return;
    const card = {
      id: uid(),
      name: nameInput.value.trim() || `Карт ${cards.length + 1}`,
      blob: pendingBlob,
      createdAt: Date.now()
    };
    saveBtn.disabled = true;
    try {
      await store.put(card);
      cards.push(card);
      activeIndex = cards.length - 1;
      addDialog.close();
      render();
      toast('Карт нэмэгдлээ');
    } catch {
      saveBtn.disabled = false;
      toast('Хадгалах зай хүрэлцэхгүй байна');
    }
  });

  // ---------- viewer ----------
  const viewDialog = $('#viewDialog');
  let viewingId = null;
  function openViewer(id) {
    const card = cards.find(c => c.id === id);
    if (!card) return;
    viewingId = id;
    $('#viewTitle').textContent = card.name;
    const img = $('#viewImg');
    img.src = urlFor(card); img.alt = card.name;
    if (allDialog.open) allDialog.close();
    viewDialog.showModal();
  }
  $('#closeView').addEventListener('click', () => viewDialog.close());
  $('#deleteCard').addEventListener('click', async () => {
    if (!viewingId) return;
    if (!confirm('Энэ картыг устгах уу?')) return;
    await store.remove(viewingId);
    cards = cards.filter(c => c.id !== viewingId);
    viewingId = null;
    viewDialog.close();
    render();
    toast('Карт устгагдлаа');
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
      cards.forEach(c => grid.appendChild(cardButton(c)));
    }
    allDialog.showModal();
  });
  $('#closeAll').addEventListener('click', () => allDialog.close());

  // close sheets on backdrop tap
  for (const d of [addDialog, allDialog]) {
    d.addEventListener('click', e => {
      const r = d.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) d.close();
    });
  }

  // ---------- misc ----------
  $('#addBtn').addEventListener('click', openAdd);
  $('#fab').addEventListener('click', openAdd);
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
  store.all().then(list => {
    cards = (list || []).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    render();
  });
})();
