// ========================
//  TMDB API
// ========================
const TMDB_API_KEY = '40f8044a3992bf1a264badac3ca33f28';

// TMDB теперь требует авторизацию через заголовок Authorization: Bearer
// (api_key в query-параметрах отключён). На случай старых/нештатных режимов
// при 401/403 пробуем fallback с api_key в URL.
async function tmdbFetch(path) {
    const base = 'https://api.themoviedb.org/3';
    const url = base + path;

    let resp = await fetch(url, {
        headers: { Authorization: `Bearer ${TMDB_API_KEY}` }
    });

    if (resp.status === 401 || resp.status === 403) {
        const sep = path.includes('?') ? '&' : '?';
        resp = await fetch(`${url}${sep}api_key=${TMDB_API_KEY}`);
    }
    return resp;
}

// ========================
//  ПОСТЕРЫ (с fallback через прокси)
// ========================
function posterFallbackHtml(mode, name) {
    if (mode === 'grid') {
        return `<div class="poster-fallback"><i class="fas fa-film"></i><span class="pf-title">${esc(name)}</span></div>`;
    }
    if (mode === 'list') return '<div class="l-fallback"><i class="fas fa-film"></i></div>';
    if (mode === 'similar') return '<div class="s-fallback"><i class="fas fa-film"></i></div>';
    if (mode === 'search') return '<div class="sr-fallback"><i class="fas fa-film"></i></div>';
    if (mode === 'hero') return '<div class="hero-fallback"><i class="fas fa-film"></i></div>';
    return '';
}

// Запасной путь для картинок: image.tmdb.org может блокироваться сетью,
// тогда грузим через прокси wsrv.nl, а если и он не смог — плейсхолдер.
window.posterError = function(img, url, w, mode, name) {
    if (img.dataset.retried) {
        if (mode === 'hero') {
            img.style.display = 'none';
            const fb = document.getElementById('detailHeroFallback');
            if (fb) fb.style.display = 'flex';
        } else {
            img.outerHTML = posterFallbackHtml(mode, name);
        }
        return;
    }
    img.dataset.retried = '1';
    img.referrerPolicy = 'no-referrer';
    img.src = 'https://wsrv.nl/?url=' + encodeURIComponent(url) + '&w=' + w;
};

function posterTag(url, alt, mode, name) {
    const w = mode === 'hero' ? 500 : mode === 'similar' ? 92 : 342;
    const fbName = mode === 'grid' ? (name || alt) : '';
    return `<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer"
        onerror="posterError(this,'${esc(url)}','${w}','${mode}','${esc(fbName)}')" />`;
}

// ========================
//  СОСТОЯНИЕ
// ========================
const STORAGE_KEY = 'myKinoArchive';
const VIEW_KEY = 'kinoViewMode';
const THEME_KEY = 'kinoTheme';
const BACKFILL_KEY = 'kinoBackfillDone';

let items = [];
let typeFilter = 'all';
let statusFilter = 'all';
let decadeFilter = 'all';
let sortMode = 'rating-desc';
let viewMode = localStorage.getItem(VIEW_KEY) || 'grid';
let theme = localStorage.getItem(THEME_KEY) || 'dark';
let editId = null;
let toastTimer = null;
let searchTimer = null;
let dragId = null;

// ========================
//  ХЕЛПЕРЫ
// ========================
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

function esc(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const TYPE_BADGES = { 'Фильм': 'film', 'Сериал': 'serial', 'Аниме': 'anime' };
const STATUS_BADGES = {
    'Просмотрено': 'status-watched',
    'В процессе': 'status-watching',
    'Буду смотреть': 'status-plan'
};
const STATUS_ICONS = {
    'Просмотрено': '✅',
    'В процессе': '⏳',
    'Буду смотреть': '📌'
};
const TYPE_ICONS = { 'Фильм': '🎬', 'Сериал': '📺', 'Аниме': '🎌' };

// ========================
//  ДАННЫЕ
// ========================
function normalize(item) {
    if (item.watchedEpisodes === undefined) item.watchedEpisodes = 0;
    if (item.totalEpisodes === undefined) item.totalEpisodes = 0;
    if (item.rewatches === undefined) item.rewatches = 0;
    if (item.watchedAt === undefined) item.watchedAt = '';
    if (item.year === undefined) item.year = null;
    if (item.tmdbRating === undefined) item.tmdbRating = null;
    return item;
}

function loadData() {
    let saved = null;
    try {
        saved = localStorage.getItem(STORAGE_KEY);
    } catch (e) { /* ignore */ }

    if (saved) {
        try {
            items = JSON.parse(saved).map(normalize);
        } catch (e) {
            items = [];
        }
    }
    if (!items || !items.length) {
        items = MY_BACKUP.map(normalize);
    }
    render();
}

function saveData() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch (e) { /* ignore */ }
    render();
}

// ========================
//  РЕНДЕР
// ========================
function getFiltered() {
    const query = $('#searchInput').value.toLowerCase().trim();

    let filtered = items;

    if (typeFilter !== 'all') {
        filtered = filtered.filter(item => item.type === typeFilter);
    }
    if (statusFilter !== 'all') {
        filtered = filtered.filter(item => item.status === statusFilter);
    }
    if (decadeFilter !== 'all') {
        filtered = filtered.filter(item =>
            item.year && Math.floor(item.year / 10) * 10 === parseInt(decadeFilter, 10));
    }
    if (query) {
        filtered = filtered.filter(item => item.name.toLowerCase().includes(query));
    }

    switch (sortMode) {
        case 'rating-desc':
            filtered = filtered.slice().sort((a, b) => (b.rating || 0) - (a.rating || 0));
            break;
        case 'rating-asc':
            filtered = filtered.slice().sort((a, b) => (a.rating || 0) - (b.rating || 0));
            break;
        case 'watched-desc':
            filtered = filtered.slice().sort((a, b) => {
                const wa = a.watchedAt || '', wb = b.watchedAt || '';
                if (!wa && !wb) return 0;
                if (!wa) return 1;
                if (!wb) return -1;
                return wb.localeCompare(wa);
            });
            break;
        case 'name-asc':
            filtered = filtered.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru'));
            break;
        case 'name-desc':
            filtered = filtered.slice().sort((a, b) => b.name.localeCompare(a.name, 'ru'));
            break;
        case 'id-desc':
            filtered = filtered.slice().sort((a, b) => b.id - a.id);
            break;
        case 'id-asc':
            filtered = filtered.slice().sort((a, b) => a.id - b.id);
            break;
        case 'manual':
            break;
    }
    return filtered;
}

function renderStats() {
    const films = items.filter(i => i.type === 'Фильм').length;
    const serials = items.filter(i => i.type === 'Сериал').length;
    const anime = items.filter(i => i.type === 'Аниме').length;
    const rated = items.filter(i => i.rating > 0);
    const avg = rated.length ? (rated.reduce((s, i) => s + i.rating, 0) / rated.length).toFixed(1) : '—';

    $('#totalCount').textContent = items.length;
    $('#filmCount').textContent = films;
    $('#serialCount').textContent = serials;
    $('#animeCount').textContent = anime;
    $('#avgRating').textContent = avg;
}

function ratingMeta(rating) {
    const r = rating || 0;
    if (r >= 8) return { cls: 'ring-high', color: '#34d399', txt: r };
    if (r >= 5) return { cls: 'ring-mid', color: '#fbbf24', txt: r };
    if (r > 0) return { cls: 'ring-low', color: '#f87171', txt: r };
    return { cls: 'ring-zero', color: '#52525b', txt: '?' };
}

function ratingRingHtml(rating) {
    const m = ratingMeta(rating);
    const pct = (rating || 0) * 10;
    const zero = rating ? '' : ' zero';
    return `
        <div class="rating-ring ${m.cls}" style="background: conic-gradient(${m.color} ${pct}%, rgba(255,255,255,0.08) 0);">
            <div class="rating-inner${zero}">${m.txt}</div>
        </div>`;
}

function ratingBadgeHtml(rating) {
    const m = ratingMeta(rating);
    return `<div class="l-rating ${m.cls}">${m.txt}</div>`;
}

function posterHtml(item, cls) {
    if (item.poster) {
        return posterTag(item.poster, item.name, cls === 'grid' ? 'grid' : 'list');
    }
    return posterFallbackHtml(cls === 'grid' ? 'grid' : 'list', item.name);
}

function progressHtml(item) {
    if ((item.type !== 'Сериал' && item.type !== 'Аниме') || item.status !== 'В процессе') return '';
    const watched = item.watchedEpisodes || 0;
    const total = item.totalEpisodes || 0;
    const pct = total > 0 ? Math.min(100, Math.round((watched / total) * 100)) : 0;
    return `
        <div class="progress-wrap"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="progress-label">${watched}/${total} серий · ${pct}%</div>`;
}

function render() {
    const filtered = getFiltered();
    renderStats();

    const cardsEl = $('#cards');
    const emptyEl = $('#emptyState');

    const dnd = sortMode === 'manual';
    cardsEl.className = viewMode === 'grid' ? 'cards' : 'cards list';
    if (dnd) cardsEl.classList.add('dnd');

    $('#decadeFilters').style.display = items.some(i => i.year) ? 'flex' : 'none';
    renderRecent();

    if (!filtered.length) {
        cardsEl.innerHTML = '';
        emptyEl.style.display = 'block';
        return;
    }
    emptyEl.style.display = 'none';

    if (viewMode === 'grid') {
        cardsEl.innerHTML = filtered.map(item => {
            const typeBadge = TYPE_BADGES[item.type] || '';
            const statusBadge = STATUS_BADGES[item.status] || '';
            const yearBadge = item.year ? `<span class="badge year">${item.year}</span>` : '';
            const tmdbText = item.tmdbRating ? `<span class="gtmdb">TMDB ⭐ ${item.tmdbRating}</span>` : '';
            const rewatch = item.rewatches > 0
                ? `<span class="grewatch"><i class="fas fa-rotate-right"></i> ×${item.rewatches}</span>` : '';
            const quickBtn = item.status === 'В процессе'
                ? `<button class="act-finish" title="Посмотрел!"><i class="fas fa-check"></i></button>`
                : item.status === 'Буду смотреть'
                    ? `<button class="act-start" title="Начать смотреть"><i class="fas fa-play"></i></button>` : '';
            const rewatchBtn = item.status === 'Просмотрено'
                ? `<button class="act-rewatch" title="+1 пересмотр"><i class="fas fa-rotate-right"></i></button>` : '';
            return `
                <div class="gcard" data-id="${item.id}" data-action="open" ${dnd ? 'draggable="true"' : ''}>
                    <div class="poster-wrap">
                        ${posterHtml(item, 'grid')}
                        ${ratingRingHtml(item.rating)}
                        <div class="gcard-actions" data-actions>
                            ${quickBtn}
                            ${rewatchBtn}
                            <button class="act-edit" title="Редактировать"><i class="fas fa-pen"></i></button>
                            <button class="act-delete" title="Удалить"><i class="fas fa-trash"></i></button>
                        </div>
                    </div>
                    <div class="gcard-body">
                        <div class="gtitle">${esc(item.name)}</div>
                        <div class="gmeta">
                            <span class="badge ${typeBadge}">${TYPE_ICONS[item.type] || ''} ${esc(item.type || '?')}</span>
                            <span class="badge ${statusBadge}">${STATUS_ICONS[item.status] || ''} ${esc(item.status || '?')}</span>
                            ${yearBadge}
                        </div>
                        ${progressHtml(item)}
                        ${rewatch}${tmdbText}
                    </div>
                </div>`;
        }).join('');
    } else {
        cardsEl.innerHTML = filtered.map(item => {
            const typeBadge = TYPE_BADGES[item.type] || '';
            const statusBadge = STATUS_BADGES[item.status] || '';
            const yearBadge = item.year ? `<span class="badge year">${item.year}</span>` : '';
            const tmdbText = item.tmdbRating ? `<span>TMDB ⭐ ${item.tmdbRating}</span>` : '';
            const rewatch = item.rewatches > 0 ? `<span>🔄 ×${item.rewatches}</span>` : '';
            const quickBtn = item.status === 'В процессе'
                ? `<button class="act-finish" title="Посмотрел!"><i class="fas fa-check"></i></button>`
                : item.status === 'Буду смотреть'
                    ? `<button class="act-start" title="Начать смотреть"><i class="fas fa-play"></i></button>` : '';
            const rewatchBtn = item.status === 'Просмотрено'
                ? `<button class="act-rewatch" title="+1 пересмотр"><i class="fas fa-rotate-right"></i></button>` : '';
            return `
                <div class="list-item" data-id="${item.id}" data-action="open" ${dnd ? 'draggable="true"' : ''}>
                    ${posterHtml(item, 'list')}
                    <div class="l-info">
                        <div class="l-title">${esc(item.name)}</div>
                        <div class="l-meta">
                            <span class="badge ${typeBadge}">${esc(item.type || '?')}</span>
                            <span class="badge ${statusBadge}">${esc(item.status || '?')}</span>
                            ${yearBadge}
                            ${item.status === 'В процессе' && (item.type === 'Сериал' || item.type === 'Аниме')
                                ? `<span>${item.watchedEpisodes || 0}/${item.totalEpisodes || '?'} серий</span>` : ''}
                            ${rewatch}
                            ${tmdbText}
                        </div>
                    </div>
                    ${ratingBadgeHtml(item.rating)}
                    <div class="l-actions">
                        ${quickBtn}
                        ${rewatchBtn}
                        <button class="act-edit" title="Редактировать"><i class="fas fa-pen"></i></button>
                        <button class="act-delete" title="Удалить"><i class="fas fa-trash"></i></button>
                    </div>
                </div>`;
        }).join('');
    }
}

// ========================
//  НЕДАВНИЕ ДОБАВЛЕННЫЕ
// ========================
function renderRecent() {
    const section = $('#recentSection');
    const recent = items.slice().sort((a, b) => b.id - a.id).slice(0, 8);
    if (!recent.length) {
        section.style.display = 'none';
        return;
    }
    section.style.display = 'block';
    $('#recentRow').innerHTML = recent.map(item => `
        <div class="recent-item" data-id="${item.id}" data-recent>
            ${item.poster ? posterTag(item.poster, item.name, 'similar') : '<div class="s-fallback"><i class="fas fa-film"></i></div>'}
            <div class="name">${esc(item.name)}</div>
        </div>`).join('');
}

$('#recentRow').addEventListener('click', function(e) {
    const el = e.target.closest('[data-id]');
    if (!el) return;
    openDetail(el.dataset.id);
});

// ========================
//  ДЕЛЕГИРОВАНИЕ КЛИКОВ ПО КАРТОЧКАМ
// ========================
$('#cards').addEventListener('click', function(e) {
    const btn = e.target.closest('button');
    const card = e.target.closest('[data-id]');
    if (!card) return;

    const id = card.dataset.id;
    if (btn) {
        if (btn.classList.contains('act-edit')) {
            e.stopPropagation();
            openEdit(id);
        } else if (btn.classList.contains('act-delete')) {
            e.stopPropagation();
            confirmDelete(id);
        } else if (btn.classList.contains('act-rewatch')) {
            e.stopPropagation();
            bumpRewatch(id);
        } else if (btn.classList.contains('act-finish')) {
            e.stopPropagation();
            markWatched(id);
        } else if (btn.classList.contains('act-start')) {
            e.stopPropagation();
            startWatching(id);
        }
        return;
    }
    openDetail(id);
});

// ========================
//  CRUD
// ========================
function findItem(id) {
    return items.find(i => i.id == id);
}

function addItem(name, type, status, rating, rewatches, poster, watchedEpisodes, totalEpisodes, watchedAt) {
    const exists = items.some(item =>
        item.name.toLowerCase() === name.toLowerCase() && item.type === type);
    if (exists) {
        showToast('⚠️ Такой уже есть в списке!', true);
        return false;
    }

    items.push({
        id: Date.now() + Math.random(),
        name: name.trim(),
        type: type || 'Фильм',
        status: status || 'Просмотрено',
        rating: parseInt(rating) || 0,
        rewatches: parseInt(rewatches) || 0,
        poster: poster || '',
        watchedEpisodes: parseInt(watchedEpisodes) || 0,
        totalEpisodes: parseInt(totalEpisodes) || 0,
        watchedAt: watchedAt || (status === 'Просмотрено' ? todayISO() : ''),
        year: null,
        tmdbRating: null,
    });
    saveData();
    showToast('✅ Добавлено!');
    return true;
}

function todayISO() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
}

function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('ru-RU');
}

function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}

function bumpRewatch(id) {
    const item = findItem(id);
    if (!item) return;
    showConfirm(`«${item.name}» — добавить пересмотр?`, () => {
        item.rewatches = (item.rewatches || 0) + 1;
        saveData();
        showToast(`🔄 «${item.name}» — ${item.rewatches} ${plural(item.rewatches, 'пересмотр', 'пересмотра', 'пересмотров')}`);
    });
}

function markWatched(id) {
    const item = findItem(id);
    if (!item) return;
    item.status = 'Просмотрено';
    if (!item.watchedAt) item.watchedAt = todayISO();
    saveData();
    showToast(`✅ «${item.name}» — просмотрено!`);
}

function startWatching(id) {
    const item = findItem(id);
    if (!item) return;
    item.status = 'В процессе';
    saveData();
    showToast(`⏳ Начал смотреть «${item.name}»`);
}

function confirmDelete(id) {
    const item = findItem(id);
    if (!item) return;
    showConfirm(`Удалить «${item.name}»?`, () => {
        items = items.filter(i => i.id != id);
        saveData();
        showToast('🗑️ Удалено');
    });
}

// ========================
//  МОДАЛКА ДОБАВЛЕНИЯ / РЕДАКТИРОВАНИЯ
// ========================
function openAddModal() {
    editId = null;
    $('#modalTitle').textContent = '➕ Добавить вручную';
    $('#editName').value = '';
    $('#editType').value = 'Фильм';
    $('#editStatus').value = 'Просмотрено';
    $('#editRating').value = '';
    $('#editRewatches').value = '0';
    $('#editPoster').value = '';
    $('#editWatchedEpisodes').value = '';
    $('#editTotalEpisodes').value = '';
    $('#editWatchedAt').value = '';
    $('#editModal').classList.add('show');
    toggleEditFields();
    setTimeout(() => $('#editName').focus(), 80);
}

function openEdit(id) {
    const item = findItem(id);
    if (!item) return;
    editId = id;
    $('#modalTitle').textContent = '✏️ ' + item.name;
    $('#editName').value = item.name || '';
    $('#editType').value = item.type || 'Фильм';
    $('#editStatus').value = item.status || 'Просмотрено';
    $('#editRating').value = item.rating || '';
    $('#editRewatches').value = item.rewatches || 0;
    $('#editPoster').value = item.poster || '';
    $('#editWatchedEpisodes').value = item.watchedEpisodes || '';
    $('#editTotalEpisodes').value = item.totalEpisodes || '';
    $('#editWatchedAt').value = item.watchedAt || '';
    $('#editModal').classList.add('show');
    toggleEditFields();
}

function closeModal() {
    $('#editModal').classList.remove('show');
    editId = null;
}

function toggleEditFields() {
    const status = $('#editStatus').value;
    const wrap = $('#editProgressWrap');
    const dateWrap = $('#editDateWrap');
    const ratingInput = $('#editRating');

    if (status === 'В процессе') {
        wrap.style.display = 'block';
        dateWrap.style.display = 'none';
        ratingInput.disabled = true;
        ratingInput.value = '';
    } else if (status === 'Просмотрено') {
        wrap.style.display = 'none';
        dateWrap.style.display = 'block';
        ratingInput.disabled = false;
    } else {
        wrap.style.display = 'none';
        dateWrap.style.display = 'none';
        ratingInput.disabled = false;
    }
}

function saveModal() {
    const name = $('#editName').value.trim();
    if (!name) {
        showToast('Введите название', true);
        return;
    }

    const type = $('#editType').value;
    const status = $('#editStatus').value;
    const rating = status === 'В процессе' || status === 'Буду смотреть' ? 0 : (parseInt($('#editRating').value) || 0);
    const rewatches = parseInt($('#editRewatches').value) || 0;
    const poster = $('#editPoster').value.trim();
    const watchedEpisodes = parseInt($('#editWatchedEpisodes').value) || 0;
    const totalEpisodes = parseInt($('#editTotalEpisodes').value) || 0;

    if (editId) {
        const item = findItem(editId);
        if (!item) return;
        item.name = name;
        item.type = type;
        item.status = status;
        item.rating = rating;
        item.rewatches = rewatches;
        item.poster = poster;
        item.watchedEpisodes = watchedEpisodes;
        item.totalEpisodes = totalEpisodes;
        if (status === 'Просмотрено') {
            item.watchedAt = $('#editWatchedAt').value || item.watchedAt || todayISO();
        } else if (!item.watchedAt) {
            item.watchedAt = '';
        }
        saveData();
        closeModal();
        showToast('💾 Сохранено!');
    } else {
        const watchedAt = status === 'Просмотрено'
            ? ($('#editWatchedAt').value || todayISO()) : '';
        if (addItem(name, type, status, rating, rewatches, poster, watchedEpisodes, totalEpisodes, watchedAt)) {
            closeModal();
        }
    }
}

// ========================
//  ПОИСК TMDB
// ========================
async function searchTMDB() {
    const query = $('#searchInput').value.trim();
    if (!query) {
        showToast('Введите название для поиска', true);
        return;
    }

    const resultsEl = $('#searchResults');
    resultsEl.innerHTML = '<div style="color:#666;padding:12px;">⏳ Поиск...</div>';
    resultsEl.classList.add('show');

    try {
        const response = await tmdbFetch(`/search/multi?query=${encodeURIComponent(query)}&language=ru-RU`);
        if (!response.ok) throw { api: true, status: response.status };
        const data = await response.json();

        if (!data.results || !data.results.length) {
            resultsEl.innerHTML = '<div style="color:#666;padding:12px;">😕 Ничего не найдено</div>';
            return;
        }

        const results = data.results.slice(0, 8);
        resultsEl.innerHTML = results.map(item => {
            const title = item.title || item.name || 'Без названия';
            const year = item.release_date ? item.release_date.slice(0, 4) :
                (item.first_air_date ? item.first_air_date.slice(0, 4) : '');
            const mediaType = item.media_type === 'tv' ? 'Сериал' : 'Фильм';
            const rating = item.vote_average ? (Math.round(item.vote_average * 10) / 10).toFixed(1) : '';
            const poster = item.poster_path ? `https://image.tmdb.org/t/p/w92${item.poster_path}` : '';
            const exists = items.some(i =>
                i.name.toLowerCase() === title.toLowerCase() && i.type === mediaType);

            return `
                <div class="search-result-item" data-result-name="${esc(title)}" data-result-type="${mediaType}"
                     data-result-rating="${rating}" data-result-poster="${esc(poster)}">
                    ${poster ? posterTag(poster, title, 'search') :
                        '<div class="sr-fallback"><i class="fas fa-film"></i></div>'}
                    <div class="info">
                        <div class="title">${esc(title)}${exists ? '<span class="exists-flag"><i class="fas fa-circle-check"></i>уже есть</span>' : ''}</div>
                        <div class="meta">${esc(mediaType)} ${year ? '· ' + esc(year) : ''} ${rating ? '⭐ ' + rating : ''}</div>
                    </div>
                    <button class="add-btn" ${exists ? 'style="opacity:0.35;pointer-events:none;"' : ''}><i class="fas fa-plus"></i></button>
                </div>`;
        }).join('');

    } catch (e) {
        if (e && e.api && (e.status === 401 || e.status === 403)) {
            resultsEl.innerHTML = '<div style="color:#f87171;padding:12px;">❌ TMDB отклонил API-ключ</div>';
        } else {
            resultsEl.innerHTML = '<div style="color:#f87171;padding:12px;">❌ Ошибка запроса. Проверь интернет.</div>';
        }
        console.error(e);
    }
}

$('#searchResults').addEventListener('click', function(e) {
    if (e.target.closest('.add-btn')) return;
    const row = e.target.closest('[data-result-name]');
    if (!row) return;
    const { resultName: name, resultType: type, resultRating: rating, resultPoster: poster } = row.dataset;
    const exists = items.some(i =>
        i.name.toLowerCase() === name.toLowerCase() && i.type === type);
    if (exists) {
        showToast('⚠️ Уже в списке!', true);
        return;
    }
    const added = addItem(name, type, 'Просмотрено', parseFloat(rating) || 0, 0, poster, 0, 0);
    if (added) {
        $('#searchResults').classList.remove('show');
        $('#searchInput').value = '';
    }
});

// ========================
//  ДЕТАЛЬНАЯ МОДАЛКА
// ========================
function openDetail(id) {
    const item = findItem(id);
    if (!item) return;

    const modal = $('#detailModal');
    const heroImg = $('#detailPoster');
    const heroFallback = $('#detailHeroFallback');

    heroImg.onerror = null;
    heroImg.dataset.retried = '';
    if (item.poster) {
        heroImg.src = item.poster;
        heroImg.style.display = 'block';
        heroFallback.style.display = 'none';
        heroImg.onerror = () => posterError(heroImg, item.poster, 500, 'hero');
    } else {
        heroImg.style.display = 'none';
        heroFallback.style.display = 'flex';
    }

    $('#detailTitle').textContent = item.name;
    $('#detailYear').textContent = '—';
    $('#detailYear2').textContent = '—';
    $('#detailGenres').innerHTML = '';
    $('#detailOverview').textContent = '⏳ Загрузка описания...';
    $('#detailSimilar').innerHTML = '<div style="color:#666;padding:8px;">Загрузка похожих...</div>';
    $('#detailStatus').textContent = `${STATUS_ICONS[item.status] || ''} ${item.status}`;
    $('#detailType').className = 'badge ' + (TYPE_BADGES[item.type] || 'film');
    $('#detailStatus').className = 'badge ' + (STATUS_BADGES[item.status] || 'status-watched');
    $('#detailRating').textContent = item.rating > 0 ? `${item.rating} / 10` : '—';
    $('#detailTmdbr').textContent = item.tmdbRating || '—';
    $('#detailRewatches').textContent = item.rewatches || 0;
    $('#detailType').textContent = item.type;
    $('#detailWatched').textContent = item.watchedAt
        ? `📅 Просмотрено: ${formatDate(item.watchedAt)}` : '';
    $('#detailModal').classList.add('show');

    fetchTMDBDetail(item.name).then(detail => {
        if (detail.overview) {
            $('#detailOverview').textContent = detail.overview;
        } else {
            $('#detailOverview').textContent = 'Описание отсутствует';
        }
        if (detail.year) {
            $('#detailYear').textContent = detail.year;
            $('#detailYear2').textContent = detail.year;
        }
        if (detail.rating) {
            $('#detailTmdbr').textContent = detail.rating;
        }

        let changed = false;
        if (item.year === null && detail.year) { item.year = detail.year; changed = true; }
        if (item.tmdbRating === null && detail.rating) { item.tmdbRating = detail.rating; changed = true; }
        if (changed) saveData();

        if (detail.genres && detail.genres.length) {
            $('#detailGenres').innerHTML = detail.genres
                .map(g => `<span class="genre-chip">${esc(g.name)}</span>`).join('');
        } else {
            $('#detailGenres').innerHTML = '<span class="genre-chip" style="opacity:0.5;">Жанры не найдены</span>';
        }

        if (detail.similar && detail.similar.length) {
            $('#detailSimilar').innerHTML = detail.similar.slice(0, 10).map(s => {
                const name = s.title || s.name || '—';
                const posterPath = s.poster_path ? `https://image.tmdb.org/t/p/w92${s.poster_path}` : '';
                return `
                    <div class="detail-similar-item" data-similar-name="${esc(name)}">
                        ${posterPath ? posterTag(posterPath, name, 'similar') :
                            '<div class="s-fallback"><i class="fas fa-film"></i></div>'}
                        <div class="name">${esc(name)}</div>
                    </div>`;
            }).join('');
        } else {
            $('#detailSimilar').innerHTML = '<div style="color:#666;padding:8px;">Похожих не найдено</div>';
        }
    }).catch(() => {
        $('#detailOverview').textContent = '❌ Ошибка загрузки описания';
        $('#detailSimilar').innerHTML = '<div style="color:#666;padding:8px;">Ошибка загрузки</div>';
    });
}

async function fetchTMDBDetail(name) {
    const resp = await tmdbFetch(`/search/multi?query=${encodeURIComponent(name)}&language=ru-RU`);
    if (!resp.ok) throw new Error('TMDB error');
    const data = await resp.json();
    if (!data.results || !data.results.length) return {};

    const first = data.results[0];
    const mediaType = first.media_type === 'movie' ? 'movie' : 'tv';
    const year = (first.release_date || first.first_air_date || '').slice(0, 4);

    const detail = {
        overview: first.overview || '',
        year,
        rating: first.vote_average ? Math.round(first.vote_average * 10) / 10 : null,
        genres: first.genre_ids || [],
        similar: []
    };

    if (detail.genres.length) {
        try {
            const genreMap = await fetchGenreMap();
            detail.genres = detail.genres.map(id => ({ name: genreMap[id] || 'Жанр' }));
        } catch (e) { /* ignore */ }
    }

    try {
        const similarResp = await tmdbFetch(`/${mediaType}/${first.id}/similar?language=ru-RU`);
        if (similarResp.ok) {
            const similarData = await similarResp.json();
            detail.similar = similarData.results || [];
        }
    } catch (e) { /* ignore */ }

    return detail;
}

let genreCache = null;
async function fetchGenreMap() {
    if (genreCache) return genreCache;
    const resp = await tmdbFetch('/genre/movie/list?language=ru-RU');
    const data = await resp.json();
    const map = {};
    (data.genres || []).forEach(g => { map[g.id] = g.name; });
    genreCache = map;
    return map;
}

$('#detailSimilar').addEventListener('click', async function(e) {
    const el = e.target.closest('[data-similar-name]');
    if (!el) return;
    const name = el.dataset.similarName;
    const existing = items.find(i => i.name.toLowerCase() === name.toLowerCase());
    if (existing) {
        openDetail(existing.id);
        return;
    }
    showToast('🔍 Ищем и добавляем...');
    try {
        const resp = await tmdbFetch(`/search/multi?query=${encodeURIComponent(name)}&language=ru-RU`);
        const data = await resp.json();
        if (data.results && data.results.length) {
            const first = data.results[0];
            const title = first.title || first.name || name;
            const type = first.media_type === 'tv' ? 'Сериал' : 'Фильм';
            const poster = first.poster_path ? `https://image.tmdb.org/t/p/w185${first.poster_path}` : '';
            const rating = first.vote_average ? Math.round(first.vote_average * 10) / 10 : 0;
            if (addItem(title, type, 'Буду смотреть', rating, 0, poster, 0, 0)) {
                const newItem = items[items.length - 1];
                openDetail(newItem.id);
            }
        } else {
            showToast('❌ Не найден', true);
        }
    } catch (e) {
        showToast('❌ Ошибка', true);
    }
});

function closeDetail() {
    $('#detailModal').classList.remove('show');
}

// ========================
//  ЭКСПОРТ / ИМПОРТ
// ========================
function importData(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = JSON.parse(e.target.result);
            if (Array.isArray(data) && data.length) {
                items = data.map(normalize);
                saveData();
                showToast('✅ Импорт успешен!');
            } else {
                showToast('❌ Неверный формат', true);
            }
        } catch (err) {
            showToast('❌ Ошибка чтения файла', true);
        }
    };
    reader.readAsText(file);
    event.target.value = '';
}

// ========================
//  КАСТОМНЫЙ CONFIRM
// ========================
let confirmCallback = null;

function showConfirm(message, onYes) {
    $('#confirmText').textContent = message;
    confirmCallback = onYes;
    $('#confirmModal').classList.add('show');
}

function closeConfirm() {
    $('#confirmModal').classList.remove('show');
    confirmCallback = null;
}

$('#confirmYes').addEventListener('click', () => {
    const cb = confirmCallback;
    closeConfirm();
    if (cb) cb();
});
$('#confirmNo').addEventListener('click', closeConfirm);

// ========================
//  TOAST
// ========================
function showToast(message, isError = false) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

// ========================
//  ФИЛЬТРЫ / СОРТИРОВКА / ВИД
// ========================
$('#typeFilters').addEventListener('click', function(e) {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    $$('#typeFilters .chip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    typeFilter = btn.dataset.filter;
    render();
});

$('#statusFilters').addEventListener('click', function(e) {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    $$('#statusFilters .chip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    statusFilter = btn.dataset.status;
    render();
});

$('#decadeFilters').addEventListener('click', function(e) {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    $$('#decadeFilters .chip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    decadeFilter = btn.dataset.decade;
    render();
});

$('#sortSelect').addEventListener('change', function() {
    sortMode = this.value;
    render();
});

function setView(mode) {
    viewMode = mode;
    try {
        localStorage.setItem(VIEW_KEY, mode);
    } catch (e) { /* ignore */ }
    $('#viewGrid').classList.toggle('active', mode === 'grid');
    $('#viewList').classList.toggle('active', mode === 'list');
    render();
}

$('#viewGrid').addEventListener('click', () => setView('grid'));
$('#viewList').addEventListener('click', () => setView('list'));

// ========================
//  ПОИСК (локальный + TMDB)
// ========================
$('#searchInput').addEventListener('input', function() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        const val = this.value.trim();
        if (!val) {
            $('#searchResults').classList.remove('show');
        }
        render();
    }, 200);
});

$('#searchInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') searchTMDB();
});

$('#searchBtn').addEventListener('click', searchTMDB);

// ========================
//  МОДАЛКИ: закрытие
// ========================
function closeTopModal() {
    if ($('#detailModal').classList.contains('show')) closeDetail();
    else if ($('#confirmModal').classList.contains('show')) closeConfirm();
    else if ($('#editModal').classList.contains('show')) closeModal();
}

document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeTopModal();
});

['editModal', 'detailModal', 'confirmModal'].forEach(id => {
    document.getElementById(id).addEventListener('click', function(e) {
        if (e.target === this) {
            if (id === 'editModal') closeModal();
            else if (id === 'detailModal') closeDetail();
            else closeConfirm();
        }
    });
});

$('#modalCloseBtn').addEventListener('click', closeModal);
$('#detailCloseBtn').addEventListener('click', closeDetail);
$('#cancelModalBtn').addEventListener('click', closeModal);
$('#saveModalBtn').addEventListener('click', saveModal);

// ========================
//  ТЕМА
// ========================
function applyTheme() {
    document.documentElement.dataset.theme = theme;
    $('#themeBtn').innerHTML = theme === 'dark'
        ? '<i class="fas fa-sun"></i>'
        : '<i class="fas fa-moon"></i>';
}

$('#themeBtn').addEventListener('click', function() {
    theme = theme === 'dark' ? 'light' : 'dark';
    try {
        localStorage.setItem(THEME_KEY, theme);
    } catch (e) { /* ignore */ }
    applyTheme();
});

// ========================
//  СЛУЧАЙНЫЙ ФИЛЬМ
// ========================
$('#randomBtn').addEventListener('click', function() {
    const pool = getFiltered();
    if (!pool.length) {
        showToast('Нет фильмов для выбора', true);
        return;
    }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    openDetail(pick.id);
});

// ========================
//  ЭКСПОРТ (JSON / Markdown / CSV)
// ========================
function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
}

function exportJSON() {
    downloadFile('my_archive_backup.json', JSON.stringify(items, null, 2), 'application/json');
    showToast('📦 Бэкап JSON скачан!');
}

function exportMarkdown() {
    let md = '# 🎬 Мой киноархив\n\n';
    for (const t of ['Фильм', 'Сериал', 'Аниме']) {
        const list = items.filter(i => i.type === t)
            .sort((a, b) => (b.rating || 0) - (a.rating || 0));
        if (!list.length) continue;
        md += `## ${t}\n\n`;
        list.forEach(i => {
            const parts = [];
            parts.push(`**${i.name}**`);
            if (i.rating) parts.push(`моя оценка ${i.rating}/10`);
            if (i.tmdbRating) parts.push(`TMDB ${i.tmdbRating}`);
            if (i.year) parts.push(String(i.year));
            if (i.rewatches) parts.push(`пересмотрено ×${i.rewatches}`);
            if (i.watchedAt) parts.push(`просмотрено ${formatDate(i.watchedAt)}`);
            md += `- ${parts.join(' · ')}\n`;
        });
        md += '\n';
    }
    downloadFile('my_archive.md', md, 'text/markdown');
    showToast('📄 Markdown скачан!');
}

function exportCSV() {
    const rows = [
        ['Название', 'Тип', 'Статус', 'Моя оценка', 'TMDB', 'Пересмотры', 'Год', 'Дата просмотра', 'Постер']
    ];
    items.forEach(i => {
        rows.push([
            i.name, i.type, i.status, i.rating || '', i.tmdbRating || '',
            i.rewatches || 0, i.year || '', i.watchedAt || '', i.poster || ''
        ]);
    });
    const csv = rows.map(r => r.map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    downloadFile('my_archive.csv', '\ufeff' + csv, 'text/csv;charset=utf-8');
    showToast('📊 CSV скачан!');
}

$('#exportBtn').addEventListener('click', function(e) {
    e.stopPropagation();
    $('#exportMenu').classList.toggle('show');
});

document.addEventListener('click', function(e) {
    if (!e.target.closest('.export-wrap')) {
        $('#exportMenu').classList.remove('show');
    }
});

$('#exportMenu').addEventListener('click', function(e) {
    const btn = e.target.closest('[data-format]');
    if (!btn) return;
    const format = btn.dataset.format;
    if (format === 'json') exportJSON();
    else if (format === 'markdown') exportMarkdown();
    else if (format === 'csv') exportCSV();
    $('#exportMenu').classList.remove('show');
});

// ========================
//  DRAG & DROP (свой порядок)
// ========================
$('#cards').addEventListener('dragstart', function(e) {
    const card = e.target.closest('[data-id]');
    if (!card || sortMode !== 'manual') return;
    dragId = card.dataset.id;
    card.classList.add('dragging');
});

$('#cards').addEventListener('dragover', function(e) {
    if (!dragId) return;
    e.preventDefault();
    const card = e.target.closest('[data-id]');
    if (card && card.dataset.id !== dragId) {
        $$('#cards [data-id].drag-over').forEach(c => c.classList.remove('drag-over'));
        card.classList.add('drag-over');
    }
});

$('#cards').addEventListener('dragleave', function(e) {
    const card = e.target.closest('[data-id]');
    if (card) card.classList.remove('drag-over');
});

$('#cards').addEventListener('drop', function(e) {
    if (!dragId) return;
    e.preventDefault();
    const target = e.target.closest('[data-id]');
    if (target && target.dataset.id !== dragId) {
        const fromIdx = items.findIndex(i => i.id == dragId);
        const toIdx = items.findIndex(i => i.id == target.dataset.id);
        if (fromIdx !== -1 && toIdx !== -1) {
            const [moved] = items.splice(fromIdx, 1);
            items.splice(toIdx, 0, moved);
            saveData();
            showToast('✋ Порядок сохранён!');
        }
    }
});

$('#cards').addEventListener('dragend', function() {
    dragId = null;
    $$('#cards .dragging, #cards .drag-over').forEach(c =>
        c.classList.remove('dragging', 'drag-over'));
});

// ========================
//  ФОНОВАЯ ДОЗАГРУЗКА TMDB (год + рейтинг)
// ========================
function backfillTMDB() {
    let done = false;
    try {
        done = localStorage.getItem(BACKFILL_KEY) === '1';
    } catch (e) { /* ignore */ }
    if (done) return;

    const missing = items.filter(i => !i.year && !i.tmdbRating).slice(0, 15);
    if (!missing.length) {
        try { localStorage.setItem(BACKFILL_KEY, '1'); } catch (e) { /* ignore */ }
        return;
    }

    let k = 0;
    const tick = async () => {
        if (k >= missing.length) {
            try { localStorage.setItem(BACKFILL_KEY, '1'); } catch (e) { /* ignore */ }
            saveData();
            return;
        }
        const item = missing[k++];
        try {
            const resp = await tmdbFetch(`/search/multi?query=${encodeURIComponent(item.name)}&language=ru-RU`);
            if (resp.ok) {
                const data = await resp.json();
                const first = data.results && data.results[0];
                if (first) {
                    if (item.year === null) {
                        const y = parseInt((first.release_date || first.first_air_date || '').slice(0, 4), 10);
                        if (!isNaN(y)) item.year = y;
                    }
                    if (item.tmdbRating === null && first.vote_average) {
                        item.tmdbRating = Math.round(first.vote_average * 10) / 10;
                    }
                }
            }
        } catch (e) { /* ignore */ }
        setTimeout(tick, 350);
    };
    tick();
}

// ========================
//  КНОПКИ ШАПКИ И FAB
// ========================
$('#importBtn').addEventListener('click', () => $('#importInput').click());
$('#importInput').addEventListener('change', importData);
$('#fabAdd').addEventListener('click', openAddModal);

// ========================
//  ЗАПУСК
// ========================
applyTheme();
setView(viewMode);
loadData();
backfillTMDB();
console.log('🎬 Киноархив загружен! Всего записей:', items.length);
