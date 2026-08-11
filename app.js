// ========================
//  TMDB API
// ========================
const TMDB_API_KEY = '40f8044a3992bf1a264badac3ca33f28';

// ========================
//  СОСТОЯНИЕ
// ========================
const STORAGE_KEY = 'myKinoArchive';
const VIEW_KEY = 'kinoViewMode';

let items = [];
let typeFilter = 'all';
let statusFilter = 'all';
let sortMode = 'rating-desc';
let viewMode = localStorage.getItem(VIEW_KEY) || 'grid';
let editId = null;
let toastTimer = null;
let searchTimer = null;

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
        return `<img src="${esc(item.poster)}" alt="${esc(item.name)}" loading="lazy" onerror="this.outerHTML=''" />`;
    }
    if (cls === 'grid') {
        return `
            <div class="poster-fallback">
                <i class="fas fa-film"></i>
                <span class="pf-title">${esc(item.name)}</span>
            </div>`;
    }
    return `<div class="l-fallback"><i class="fas fa-film"></i></div>`;
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

    cardsEl.className = viewMode === 'grid' ? 'cards' : 'cards list';

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
            const rewatch = item.rewatches > 0
                ? `<span class="grewatch"><i class="fas fa-rotate-right"></i> ×${item.rewatches}</span>` : '';
            const rewatchBtn = item.status === 'Просмотрено'
                ? `<button class="act-rewatch" title="+1 пересмотр"><i class="fas fa-rotate-right"></i></button>` : '';
            return `
                <div class="gcard" data-id="${item.id}" data-action="open">
                    <div class="poster-wrap">
                        ${posterHtml(item, 'grid')}
                        ${ratingRingHtml(item.rating)}
                        <div class="gcard-actions" data-actions>
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
                        </div>
                        ${progressHtml(item)}
                        ${rewatch}
                    </div>
                </div>`;
        }).join('');
    } else {
        cardsEl.innerHTML = filtered.map(item => {
            const typeBadge = TYPE_BADGES[item.type] || '';
            const statusBadge = STATUS_BADGES[item.status] || '';
            const rewatch = item.rewatches > 0 ? `<span>🔄 ×${item.rewatches}</span>` : '';
            const rewatchBtn = item.status === 'Просмотрено'
                ? `<button class="act-rewatch" title="+1 пересмотр"><i class="fas fa-rotate-right"></i></button>` : '';
            return `
                <div class="list-item" data-id="${item.id}" data-action="open">
                    ${posterHtml(item, 'list')}
                    <div class="l-info">
                        <div class="l-title">${esc(item.name)}</div>
                        <div class="l-meta">
                            <span class="badge ${typeBadge}">${esc(item.type || '?')}</span>
                            <span class="badge ${statusBadge}">${esc(item.status || '?')}</span>
                            ${item.status === 'В процессе' && (item.type === 'Сериал' || item.type === 'Аниме')
                                ? `<span>${item.watchedEpisodes || 0}/${item.totalEpisodes || '?'} серий</span>` : ''}
                            ${rewatch}
                        </div>
                    </div>
                    ${ratingBadgeHtml(item.rating)}
                    <div class="l-actions">
                        ${rewatchBtn}
                        <button class="act-edit" title="Редактировать"><i class="fas fa-pen"></i></button>
                        <button class="act-delete" title="Удалить"><i class="fas fa-trash"></i></button>
                    </div>
                </div>`;
        }).join('');
    }
}

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

function addItem(name, type, status, rating, rewatches, poster, watchedEpisodes, totalEpisodes) {
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
    });
    saveData();
    showToast('✅ Добавлено!');
    return true;
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
    item.rewatches = (item.rewatches || 0) + 1;
    saveData();
    showToast(`🔄 «${item.name}» — ${item.rewatches} ${plural(item.rewatches, 'пересмотр', 'пересмотра', 'пересмотров')}`);
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
    const ratingInput = $('#editRating');

    if (status === 'В процессе') {
        wrap.style.display = 'block';
        ratingInput.disabled = true;
        ratingInput.value = '';
    } else {
        wrap.style.display = 'none';
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
        saveData();
        closeModal();
        showToast('💾 Сохранено!');
    } else {
        if (addItem(name, type, status, rating, rewatches, poster, watchedEpisodes, totalEpisodes)) {
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
        const url =
            `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&language=ru-RU`;
        const response = await fetch(url);
        if (!response.ok) throw new Error('TMDB error');
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
                    ${poster ? `<img src="${esc(poster)}" alt="${esc(title)}" />` :
                        '<div style="width:44px;height:66px;background:#10101a;border-radius:8px;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#52525b;"><i class="fas fa-film"></i></div>'}
                    <div class="info">
                        <div class="title">${esc(title)}${exists ? '<span class="exists-flag"><i class="fas fa-circle-check"></i>уже есть</span>' : ''}</div>
                        <div class="meta">${esc(mediaType)} ${year ? '· ' + esc(year) : ''} ${rating ? '⭐ ' + rating : ''}</div>
                    </div>
                    <button class="add-btn" ${exists ? 'style="opacity:0.35;pointer-events:none;"' : ''}><i class="fas fa-plus"></i></button>
                </div>`;
        }).join('');

    } catch (e) {
        resultsEl.innerHTML = '<div style="color:#f87171;padding:12px;">❌ Ошибка запроса. Проверь интернет.</div>';
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
    $('#detailPoster').src = item.poster || '';
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
    $('#detailRewatches').textContent = item.rewatches || 0;
    $('#detailType').textContent = item.type;
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
                        ${posterPath ? `<img src="${esc(posterPath)}" alt="${esc(name)}" />` :
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
    const url =
        `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(name)}&language=ru-RU`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('TMDB error');
    const data = await resp.json();
    if (!data.results || !data.results.length) return {};

    const first = data.results[0];
    const mediaType = first.media_type === 'movie' ? 'movie' : 'tv';
    const year = (first.release_date || first.first_air_date || '').slice(0, 4);

    const detail = {
        overview: first.overview || '',
        year,
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
        const similarUrl =
            `https://api.themoviedb.org/3/${mediaType}/${first.id}/similar?api_key=${TMDB_API_KEY}&language=ru-RU`;
        const similarResp = await fetch(similarUrl);
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
    const url =
        `https://api.themoviedb.org/3/genre/movie/list?api_key=${TMDB_API_KEY}&language=ru-RU`;
    const resp = await fetch(url);
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
        const url =
            `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(name)}&language=ru-RU`;
        const resp = await fetch(url);
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
function exportData() {
    const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'my_archive_backup.json';
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('📦 Бэкап скачан!');
}

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
//  КНОПКИ ШАПКИ И FAB
// ========================
$('#exportBtn').addEventListener('click', exportData);
$('#importBtn').addEventListener('click', () => $('#importInput').click());
$('#importInput').addEventListener('change', importData);
$('#fabAdd').addEventListener('click', openAddModal);

// ========================
//  ЗАПУСК
// ========================
setView(viewMode);
loadData();
console.log('🎬 Киноархив загружен! Всего записей:', items.length);
