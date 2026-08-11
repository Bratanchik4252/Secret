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
const TRASH_KEY = 'kinoTrash';
const FOLDERS_KEY = 'kinoFolders';
const SIZE_KEY = 'kinoCardSize';
const WEEK_KEY = 'kinoWeekToast';
const TRASH_TTL = 30 * 24 * 3600 * 1000;

let items = [];
let trash = loadJSON(TRASH_KEY, []);
let folders = loadJSON(FOLDERS_KEY, []);
let typeFilter = 'all';
let statusFilter = 'all';
let decadeFilter = 'all';
let sortMode = 'rating-desc';
let viewMode = localStorage.getItem(VIEW_KEY) || 'grid';
let theme = localStorage.getItem(THEME_KEY) || 'dark';
let cardSize = localStorage.getItem(SIZE_KEY) || 'm';
let editId = null;
let toastTimer = null;
let searchTimer = null;
let dragId = null;
let promptCallback = null;
let rateId = null;
let detailId = null;

// ========================
//  ХЕЛПЕРЫ
// ========================
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

function loadJSON(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
        return fallback;
    }
}

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
    'На паузе': 'status-pause',
    'Буду смотреть': 'status-plan'
};
const STATUS_ICONS = {
    'Просмотрено': '✅',
    'В процессе': '⏳',
    'На паузе': '⏸️',
    'Буду смотреть': '📌'
};
const TYPE_ICONS = { 'Фильм': '🎬', 'Сериал': '📺', 'Аниме': '🎌' };

const GENRE_COLORS = {
    'Фантастика': '#60a5fa',
    'Фэнтези': '#c084fc',
    'Драма': '#f87171',
    'Комедия': '#4ade80',
    'Боевик': '#fb923c',
    'Ужасы': '#a78bfa',
    'Триллер': '#2dd4bf',
    'Приключения': '#facc15',
    'Криминал': '#f472b6',
    'Детектив': '#94a3b8',
    'Мультфильм': '#f472b6',
    'Семейный': '#a3e635',
    'Мелодрама': '#fb7185',
    'Мистика': '#818cf8',
    'Военный': '#a8a29e',
    'Документальный': '#22d3ee',
    'Вестерн': '#d97706',
    'История': '#eab308',
    'Музыка': '#34d399',
    'Мюзикл': '#2dd4bf',
    'Телевизионный фильм': '#64748b'
};

function genreColor(name) {
    return GENRE_COLORS[name] || '#888888';
}

function genreTagHtml(names, limit) {
    return (names || []).slice(0, limit || 2).map(g =>
        `<span class="genre-tag" style="background:${genreColor(g)}22;color:${genreColor(g)};">${esc(g)}</span>`
    ).join('');
}

const CLASSICS = [
    { name: 'Крёстный отец', type: 'Фильм', year: 1972 },
    { name: 'Криминальное чтиво', type: 'Фильм', year: 1994 },
    { name: 'Матрица', type: 'Фильм', year: 1999 },
    { name: 'Начало', type: 'Фильм', year: 2010 },
    { name: 'Форрест Гамп', type: 'Фильм', year: 1994 },
    { name: 'Список Шиндлера', type: 'Фильм', year: 1993 },
    { name: 'Зелёная миля', type: 'Фильм', year: 1999 },
    { name: 'Гладиатор', type: 'Фильм', year: 2000 },
    { name: 'Терминатор 2: Судный день', type: 'Фильм', year: 1991 },
    { name: 'Молчание ягнят', type: 'Фильм', year: 1991 },
    { name: 'Отступники', type: 'Фильм', year: 2006 },
    { name: 'Большой куш', type: 'Фильм', year: 2000 },
    { name: 'Остров проклятых', type: 'Фильм', year: 2010 },
    { name: 'Достать ножи', type: 'Фильм', year: 2019 },
    { name: 'Дюна', type: 'Фильм', year: 2021 },
    { name: 'Аватар', type: 'Фильм', year: 2009 },
    { name: 'Титаник', type: 'Фильм', year: 1997 },
    { name: 'Хатико: Самый верный друг', type: 'Фильм', year: 2009 },
    { name: 'Побег из Шоушенка', type: 'Фильм', year: 1994 },
    { name: 'Назад в будущее', type: 'Фильм', year: 1985 },
    { name: 'Индиана Джонс: В поисках утраченного ковчега', type: 'Фильм', year: 1981 },
    { name: 'Крепкий орешек', type: 'Фильм', year: 1988 },
    { name: 'Один дома', type: 'Фильм', year: 1990 },
    { name: 'Гарри Поттер и философский камень', type: 'Фильм', year: 2001 },
    { name: 'Властелин колец: Братство кольца', type: 'Фильм', year: 2001 },
    { name: '12 разгневанных мужчин', type: 'Фильм', year: 1957 },
    { name: 'Драйв', type: 'Фильм', year: 2011 },
    { name: 'Ла-Ла Ленд', type: 'Фильм', year: 2016 },
    { name: 'Одержимость', type: 'Фильм', year: 2014 },
    { name: 'Интерстеллар', type: 'Фильм', year: 2014 },
    { name: 'Унесённые призраками', type: 'Аниме', year: 2001 },
    { name: 'Мой сосед Тоторо', type: 'Аниме', year: 1988 },
    { name: 'Во все тяжкие', type: 'Сериал', year: 2008 },
    { name: 'Игра престолов', type: 'Сериал', year: 2011 },
    { name: 'Шерлок', type: 'Сериал', year: 2010 },
    { name: 'Друзья', type: 'Сериал', year: 1994 },
    { name: 'Чернобыль', type: 'Сериал', year: 2019 }
];

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
    if (item.genres === undefined) item.genres = [];
    if (item.overview === undefined) item.overview = '';
    if (item.runtime === undefined) item.runtime = null;
    if (item.important === undefined) item.important = false;
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
    purgeTrash();
    weeklySummary();
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
        filtered = filtered.filter(item =>
            typeFilter === 'important' ? item.important : item.type === typeFilter);
    }
    if (statusFilter !== 'all') {
        filtered = filtered.filter(item => item.status === statusFilter);
    }
    if (decadeFilter !== 'all') {
        filtered = filtered.filter(item =>
            item.year && Math.floor(item.year / 10) * 10 === parseInt(decadeFilter, 10));
    }
    if (query) {
        const mode = $('#searchMode') ? $('#searchMode').value : 'name';
        filtered = filtered.filter(item => {
            const nameHit = item.name.toLowerCase().includes(query);
            if (mode === 'all') {
                const genresHit = (item.genres || []).some(g => String(g).toLowerCase().includes(query));
                const yearHit = item.year && String(item.year).includes(query);
                const statusHit = (item.status || '').toLowerCase().includes(query);
                const overviewHit = (item.overview || '').toLowerCase().includes(query);
                return nameHit || genresHit || yearHit || statusHit || overviewHit;
            }
            return nameHit;
        });
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
    const lvl = getLevel(items.length);
    $('#levelVal').textContent = lvl.name;
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
    return `<div class="l-rating ${m.cls}" data-rate title="Быстрая оценка">${m.txt}</div>`;
}

function posterHtml(item, cls) {
    if (item.poster) {
        return posterTag(item.poster, item.name, cls === 'grid' ? 'grid' : 'list');
    }
    return posterFallbackHtml(cls === 'grid' ? 'grid' : 'list', item.name);
}

function progressHtml(item) {
    if (item.type !== 'Сериал' && item.type !== 'Аниме') return '';
    if (item.status !== 'В процессе' && item.status !== 'На паузе') return '';
    const watched = item.watchedEpisodes || 0;
    const total = item.totalEpisodes || 0;
    const pct = total > 0 ? Math.min(100, Math.round((watched / total) * 100)) : 0;
    const left = total > 0 ? ` · осталось ${Math.max(0, total - watched)}` : '';
    return `
        <div class="progress-wrap"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="progress-label">${watched}/${total} серий · ${pct}%${left}</div>`;
}

function render() {
    const filtered = getFiltered();
    renderStats();

    const cardsEl = $('#cards');
    const emptyEl = $('#emptyState');

    const dnd = sortMode === 'manual';
    cardsEl.className = viewMode === 'grid' ? 'cards' : 'cards list';
    if (cardSize !== 'm') cardsEl.classList.add('size-' + cardSize);
    if (dnd) cardsEl.classList.add('dnd');

    $('#decadeFilters').style.display = items.some(i => i.year) ? 'flex' : 'none';
    $('#sizeToggle').style.display = viewMode === 'grid' ? 'inline-flex' : 'none';
    $('#sizeS').classList.toggle('active', cardSize === 's');
    $('#sizeM').classList.toggle('active', cardSize === 'm');
    $('#sizeL').classList.toggle('active', cardSize === 'l');
    $('#menuTrashCount').textContent = trash.length ? trash.length : '';
    renderFolders();
    renderClassics();
    renderRecent();

    const oldestId = items.length
        ? items.slice().sort((a, b) => a.id - b.id)[0].id : null;

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
                ? `<button class="act-finish" title="Посмотрел!"><i class="fas fa-check"></i></button>
                   <button class="act-pause" title="На паузу"><i class="fas fa-pause"></i></button>`
                : item.status === 'На паузе'
                    ? `<button class="act-start" title="Продолжить"><i class="fas fa-play"></i></button>
                       <button class="act-finish" title="Посмотрел!"><i class="fas fa-check"></i></button>`
                    : item.status === 'Буду смотреть'
                        ? `<button class="act-start" title="Начать смотреть"><i class="fas fa-play"></i></button>` : '';
            const rewatchBtn = item.status === 'Просмотрено'
                ? `<button class="act-rewatch" title="+1 пересмотр"><i class="fas fa-rotate-right"></i></button>` : '';
            const starBtn = `<button class="act-star" title="Важное"><i class="${item.important ? 'fas' : 'far'} fa-star"></i></button>`;
            const cornerStar = item.important ? '<div class="corner-star"><i class="fas fa-star"></i></div>' : '';
            const cornerOld = item.id === oldestId
                ? '<div class="corner-old" title="Хранитель истории — самая старая запись"><i class="fas fa-landmark"></i></div>' : '';
            const tintColor = ratingMeta(item.rating).color;
            const genreTags = item.genres && item.genres.length
                ? `<div class="genre-tags">${genreTagHtml(item.genres, 2)}</div>` : '';
            return `
                <div class="gcard" data-id="${item.id}" data-action="open" ${dnd ? 'draggable="true"' : ''}>
                    <div class="poster-wrap" style="--tint:${tintColor}">
                        ${posterHtml(item, 'grid')}
                        ${cornerStar}${cornerOld}
                        ${ratingRingHtml(item.rating)}
                        <div class="gcard-actions" data-actions>
                            ${quickBtn}
                            ${rewatchBtn}
                            ${starBtn}
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
                        ${genreTags}${rewatch}${tmdbText}
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
                ? `<button class="act-finish" title="Посмотрел!"><i class="fas fa-check"></i></button>
                   <button class="act-pause" title="На паузу"><i class="fas fa-pause"></i></button>`
                : item.status === 'На паузе'
                    ? `<button class="act-start" title="Продолжить"><i class="fas fa-play"></i></button>
                       <button class="act-finish" title="Посмотрел!"><i class="fas fa-check"></i></button>`
                    : item.status === 'Буду смотреть'
                        ? `<button class="act-start" title="Начать смотреть"><i class="fas fa-play"></i></button>` : '';
            const rewatchBtn = item.status === 'Просмотрено'
                ? `<button class="act-rewatch" title="+1 пересмотр"><i class="fas fa-rotate-right"></i></button>` : '';
            const starBtn = `<button class="act-star" title="Важное"><i class="${item.important ? 'fas' : 'far'} fa-star"></i></button>`;
            const watchingProgress = (item.status === 'В процессе' || item.status === 'На паузе') &&
                (item.type === 'Сериал' || item.type === 'Аниме')
                ? `<span>${item.watchedEpisodes || 0}/${item.totalEpisodes || '?'} серий</span>` : '';
            return `
                <div class="list-item" data-id="${item.id}" data-action="open" ${dnd ? 'draggable="true"' : ''}>
                    ${posterHtml(item, 'list')}
                    <div class="l-info">
                        <div class="l-title">${item.important ? '<span class="l-important" title="Важное">⭐</span> ' : ''}${esc(item.name)}</div>
                        <div class="l-meta">
                            <span class="badge ${typeBadge}">${esc(item.type || '?')}</span>
                            <span class="badge ${statusBadge}">${esc(item.status || '?')}</span>
                            ${yearBadge}
                            ${watchingProgress}
                            ${rewatch}
                            ${tmdbText}
                        </div>
                    </div>
                    ${ratingBadgeHtml(item.rating)}
                    <div class="l-actions">
                        ${quickBtn}
                        ${rewatchBtn}
                        ${starBtn}
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
        } else if (btn.classList.contains('act-pause')) {
            e.stopPropagation();
            pauseItem(id);
        } else if (btn.classList.contains('act-star')) {
            e.stopPropagation();
            toggleImportant(id);
        }
        return;
    }
    const rateEl = e.target.closest('.rating-ring') || e.target.closest('.l-rating');
    if (rateEl) {
        e.stopPropagation();
        openRate(id);
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

function addItem(name, type, status, rating, rewatches, poster, watchedEpisodes, totalEpisodes, watchedAt, important, silent) {
    const exists = items.some(item =>
        item.name.toLowerCase() === name.toLowerCase() && item.type === type);
    if (exists) {
        if (!silent) showToast('⚠️ Такой уже есть в списке!', true);
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
        genres: [],
        overview: '',
        runtime: null,
        important: !!important
    });
    saveData();
    if (!silent) showToast('✅ Добавлено!');
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

function pauseItem(id) {
    const item = findItem(id);
    if (!item) return;
    item.status = 'На паузе';
    saveData();
    showToast(`⏸️ «${item.name}» — на паузе`);
}

function toggleImportant(id) {
    const item = findItem(id);
    if (!item) return;
    item.important = !item.important;
    saveData();
    showToast(item.important ? `⭐ «${item.name}» — в важном!` : `«${item.name}» больше не важное`);
}

function confirmDelete(id) {
    const item = findItem(id);
    if (!item) return;
    showConfirm(`Удалить «${item.name}»?`, () => {
        items = items.filter(i => i.id != id);
        trash.push({ item: item, deletedAt: Date.now() });
        saveTrash();
        saveData();
        showToast('🗑️ Удалено. Восстановить можно из корзины');
    });
}

// ========================
//  КОРЗИНА
// ========================
function saveTrash() {
    try {
        localStorage.setItem(TRASH_KEY, JSON.stringify(trash));
    } catch (e) { /* ignore */ }
}

function purgeTrash() {
    const cutoff = Date.now() - TRASH_TTL;
    const before = trash.length;
    trash = trash.filter(t => t.deletedAt > cutoff);
    if (trash.length !== before) saveTrash();
}

function restoreItem(id) {
    const idx = trash.findIndex(t => t.item.id == id);
    if (idx === -1) return;
    const [t] = trash.splice(idx, 1);
    items.push(t.item);
    saveTrash();
    saveData();
    renderTrash();
    showToast('♻️ Восстановлено!');
}

function purgeItem(id) {
    trash = trash.filter(t => t.item.id != id);
    saveTrash();
    renderTrash();
    showToast('🗑️ Удалено навсегда');
}

function emptyTrash() {
    if (!trash.length) return;
    showConfirm(`Очистить корзину (${trash.length} шт.)?`, () => {
        trash = [];
        saveTrash();
        renderTrash();
        showToast('🗑️ Корзина пуста');
    });
}

function renderTrash() {
    $('#trashCount').textContent = trash.length ? `(${trash.length})` : '';
    $('#menuTrashCount').textContent = trash.length ? trash.length : '';
    const el = $('#trashList');
    if (!trash.length) {
        el.innerHTML = '<div class="trash-empty">Корзина пуста</div>';
    } else {
        el.innerHTML = trash.map(t => `
            <div class="trash-item" data-trash-id="${t.item.id}">
                ${t.item.poster
                    ? `<img class="trash-thumb" src="${esc(t.item.poster)}" alt="" loading="lazy" onerror="this.style.display='none'">`
                    : '<div class="trash-thumb" style="background:var(--border);"></div>'}
                <div class="trash-info">
                    <div class="trash-name">${esc(t.item.name)}</div>
                    <div class="trash-date">удалено ${new Date(t.deletedAt).toLocaleDateString('ru-RU')}</div>
                </div>
                <button class="t-restore" data-trash-act="restore" title="Восстановить">♻️</button>
                <button class="t-purge" data-trash-act="purge" title="Удалить навсегда">🗑️</button>
            </div>`).join('');
    }
    $('#trashModal').classList.add('show');
}

$('#trashList').addEventListener('click', function(e) {
    const btn = e.target.closest('[data-trash-act]');
    const row = e.target.closest('[data-trash-id]');
    if (!btn || !row) return;
    if (btn.dataset.trashAct === 'restore') restoreItem(row.dataset.trashId);
    else purgeItem(row.dataset.trashId);
});

$('#trashClear').addEventListener('click', emptyTrash);

function closeTrash() {
    $('#trashModal').classList.remove('show');
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
    $('#editImportant').checked = false;
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
    $('#editImportant').checked = !!item.important;
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

    if (status === 'В процессе' || status === 'На паузе') {
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
    const rating = status === 'В процессе' || status === 'На паузе' || status === 'Буду смотреть'
        ? 0 : (parseInt($('#editRating').value) || 0);
    const rewatches = parseInt($('#editRewatches').value) || 0;
    const poster = $('#editPoster').value.trim();
    const watchedEpisodes = parseInt($('#editWatchedEpisodes').value) || 0;
    const totalEpisodes = parseInt($('#editTotalEpisodes').value) || 0;
    const important = $('#editImportant').checked;

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
        item.important = important;
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
        if (addItem(name, type, status, rating, rewatches, poster, watchedEpisodes, totalEpisodes, watchedAt, important)) {
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
                     data-result-rating="${rating}" data-result-poster="${esc(poster)}" data-result-year="${year}">
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
    const { resultName: name, resultType: type, resultRating: rating, resultPoster: poster, resultYear: year } = row.dataset;
    const exists = items.some(i =>
        i.name.toLowerCase() === name.toLowerCase() && i.type === type);
    if (exists) {
        showToast('⚠️ Уже в списке!', true);
        return;
    }
    const added = addItem(name, type, 'Просмотрено', parseFloat(rating) || 0, 0, poster, 0, 0);
    if (added) {
        const item = items[items.length - 1];
        if (year && !isNaN(parseInt(year, 10))) item.year = parseInt(year, 10);
        saveData();
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
    detailId = id;

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
    $('#detailGenres').innerHTML = item.genres && item.genres.length
        ? item.genres.map(g => `<span class="genre-chip" style="color:${genreColor(g)};border-color:${genreColor(g)}44;">${esc(g)}</span>`).join('')
        : '';
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
    $('#detailRuntime').textContent = item.runtime
        ? `⏱️ ${Math.floor(item.runtime / 60)} ч ${item.runtime % 60} мин` : '';
    $('#detailImportantBtn').innerHTML = item.important
        ? '<i class="fas fa-star"></i> В избранном'
        : '<i class="far fa-star"></i> В избранное';
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
        if (detail.runtime) {
            $('#detailRuntime').textContent = `⏱️ ${Math.floor(detail.runtime / 60)} ч ${detail.runtime % 60} мин`;
        }

        let changed = false;
        if (item.year === null && detail.year) { item.year = detail.year; changed = true; }
        if (item.tmdbRating === null && detail.rating) { item.tmdbRating = detail.rating; changed = true; }
        if ((!item.genres || !item.genres.length) && detail.genres && detail.genres.length) {
            item.genres = detail.genres.map(g => g.name).filter(Boolean);
            changed = true;
        }
        if (!item.overview && detail.overview) { item.overview = detail.overview; changed = true; }
        if (item.runtime === null && detail.runtime) { item.runtime = detail.runtime; changed = true; }
        if (changed) saveData();

        if (detail.genres && detail.genres.length) {
            $('#detailGenres').innerHTML = detail.genres
                .map(g => `<span class="genre-chip" style="color:${genreColor(g.name)};border-color:${genreColor(g.name)}44;">${esc(g.name)}</span>`).join('');
        } else if (!item.genres || !item.genres.length) {
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

function toggleDetailImportant() {
    if (!detailId) return;
    toggleImportant(detailId);
    const item = findItem(detailId);
    if (!item) return;
    $('#detailImportantBtn').innerHTML = item.important
        ? '<i class="fas fa-star"></i> В избранном'
        : '<i class="far fa-star"></i> В избранное';
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
        runtime: first.runtime || null,
        similar: []
    };

    if (detail.genres.length) {
        try {
            const genreMap = await fetchGenreMap();
            detail.genres = detail.genres.map(id => ({ name: genreMap[id] || 'Жанр' }));
        } catch (e) { /* ignore */ }
    }

    if (!detail.runtime) {
        try {
            const dResp = await tmdbFetch(`/${mediaType}/${first.id}?language=ru-RU`);
            if (dResp.ok) {
                const d = await dResp.json();
                detail.runtime = mediaType === 'movie'
                    ? (d.runtime || null)
                    : ((d.episode_run_time && d.episode_run_time[0]) || null);
            }
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
                const y = parseInt((first.release_date || first.first_air_date || '').slice(0, 4), 10);
                if (!isNaN(y)) newItem.year = y;
                if (first.runtime) newItem.runtime = first.runtime;
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
//  БЫСТРАЯ ОЦЕНКА
// ========================
function openRate(id) {
    rateId = id;
    const item = findItem(id);
    if (!item) return;
    $('#rateTitle').textContent = `«${item.name}»`;
    const cur = item.rating || 0;
    $$('#rateGrid .rate-btn').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.rate, 10) === cur);
    });
    $('#rateModal').classList.add('show');
}

function setRate(val) {
    const item = findItem(rateId);
    if (!item) return;
    item.rating = val;
    saveData();
    closeRate();
    if (val) showToast(`⭐ «${item.name}» — ${val}/10`);
    else showToast('⭐ Оценка сброшена');
}

function closeRate() {
    $('#rateModal').classList.remove('show');
    rateId = null;
}

$('#rateGrid').addEventListener('click', function(e) {
    const btn = e.target.closest('.rate-btn');
    if (!btn) return;
    setRate(parseInt(btn.dataset.rate, 10) || 0);
});

// ========================
//  ЭКСПОРТ / ИМПОРТ
// ========================
function parseCSV(text) {
    const rows = [];
    text.split(/\r?\n/).forEach(line => {
        if (!line.trim()) return;
        const cols = [];
        let cur = '';
        let inQ = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inQ) {
                if (ch === '"') {
                    if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
                } else cur += ch;
            } else if (ch === '"') inQ = true;
            else if (ch === ';') { cols.push(cur); cur = ''; }
            else cur += ch;
        }
        cols.push(cur);
        rows.push(cols);
    });
    return rows;
}

function importCSV(text) {
    const rows = parseCSV(text);
    if (rows.length < 2) return 0;
    const header = rows[0].map(h => h.trim().toLowerCase().replace(/ё/g, 'е'));
    const idx = {
        name: header.indexOf('название'),
        type: header.indexOf('тип'),
        status: header.indexOf('статус'),
        rating: header.indexOf('моя оценка'),
        rewatches: header.indexOf('пересмотры'),
        year: header.indexOf('год'),
        watchedAt: header.indexOf('дата просмотра'),
        poster: header.indexOf('постер')
    };
    let count = 0;
    rows.slice(1).forEach(r => {
        const name = idx.name !== -1 ? r[idx.name] : r[0];
        if (!name || !name.trim()) return;
        const type = idx.type !== -1 ? (r[idx.type] || 'Фильм') : 'Фильм';
        const status = idx.status !== -1 ? (r[idx.status] || 'Просмотрено') : 'Просмотрено';
        const rating = idx.rating !== -1 ? parseInt(r[idx.rating]) || 0 : 0;
        const rewatches = idx.rewatches !== -1 ? parseInt(r[idx.rewatches]) || 0 : 0;
        const watchedAt = idx.watchedAt !== -1 ? r[idx.watchedAt] : '';
        const poster = idx.poster !== -1 ? r[idx.poster] : '';
        if (addItem(name, type, status, rating, rewatches, poster, 0, 0, watchedAt, false, true)) {
            const item = items[items.length - 1];
            if (idx.year !== -1 && r[idx.year]) {
                const y = parseInt(r[idx.year], 10);
                if (!isNaN(y)) item.year = y;
            }
            count++;
        }
    });
    saveData();
    return count;
}

function importData(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        if (ext === 'csv') {
            const n = importCSV(e.target.result);
            showToast(n ? `✅ Импортировано записей: ${n}` : '❌ Не удалось прочитать CSV', !n);
        } else {
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
        }
    };
    reader.readAsText(file);
    event.target.value = '';
}

// ========================
//  ДУБЛИКАТЫ
// ========================
function findDuplicates() {
    const map = {};
    items.forEach(i => {
        const k = i.type + '|' + i.name.trim().toLowerCase();
        (map[k] = map[k] || []).push(i);
    });
    return Object.values(map).filter(g => g.length > 1);
}

function openDuplicates() {
    const groups = findDuplicates();
    const el = $('#dupList');
    if (!groups.length) {
        el.innerHTML = '<div class="trash-empty">🎉 Дубликатов нет!</div>';
    } else {
        el.innerHTML = groups.map(g => `
            <div class="dup-group">
                <div class="dup-title">«${esc(g[0].name)}» — ${g.length} шт.</div>
                ${g.map((item, ii) => `
                    <div class="dup-row">
                        <span class="dup-name">${esc(item.name)}</span>
                        ${ii === 0
                            ? '<span class="dup-keep">✅ оставляем</span>'
                            : `<button class="dup-del" data-dup-id="${item.id}">🗑️ удалить</button>`}
                    </div>`).join('')}
            </div>`).join('');
    }
    $('#duplicatesModal').classList.add('show');
}

$('#dupList').addEventListener('click', function(e) {
    const btn = e.target.closest('.dup-del');
    if (!btn) return;
    const item = findItem(btn.dataset.dupId);
    if (!item) return;
    items = items.filter(i => i.id != item.id);
    trash.push({ item: item, deletedAt: Date.now() });
    saveTrash();
    saveData();
    openDuplicates();
    showToast('🗑️ Дубль удалён');
});

function closeDuplicates() {
    $('#duplicatesModal').classList.remove('show');
}

// ========================
//  МЕНЮ ШАПКИ
// ========================
$('#menuBtn').addEventListener('click', function(e) {
    e.stopPropagation();
    $('#mainMenu').classList.toggle('show');
});

$('#mainMenu').addEventListener('click', function(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    $('#mainMenu').classList.remove('show');
    const act = btn.dataset.action;
    if (act === 'achievements') renderAchievements();
    else if (act === 'analytics') renderAnalytics();
    else if (act === 'trash') renderTrash();
    else if (act === 'duplicates') openDuplicates();
    else if (act === 'export-json') exportJSON();
    else if (act === 'export-md') exportMarkdown();
    else if (act === 'export-csv') exportCSV();
    else if (act === 'import') $('#importInput').click();
});

$('#importInput').addEventListener('change', importData);

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
function syncChips() {
    $$('#typeFilters .chip').forEach(b => b.classList.toggle('active', b.dataset.filter === typeFilter));
    $$('#statusFilters .chip').forEach(b => b.classList.toggle('active', b.dataset.status === statusFilter));
    $$('#decadeFilters .chip').forEach(b => b.classList.toggle('active', b.dataset.decade === decadeFilter));
}

$('#typeFilters').addEventListener('click', function(e) {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    typeFilter = btn.dataset.filter;
    syncChips();
    render();
});

$('#statusFilters').addEventListener('click', function(e) {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    statusFilter = btn.dataset.status;
    syncChips();
    render();
});

$('#decadeFilters').addEventListener('click', function(e) {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    decadeFilter = btn.dataset.decade;
    syncChips();
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

function setCardSize(s) {
    cardSize = s;
    try {
        localStorage.setItem(SIZE_KEY, s);
    } catch (e) { /* ignore */ }
    render();
}

$('#sizeS').addEventListener('click', () => setCardSize('s'));
$('#sizeM').addEventListener('click', () => setCardSize('m'));
$('#sizeL').addEventListener('click', () => setCardSize('l'));

// ========================
//  ПАПКИ (сохранённые фильтры)
// ========================
function renderFolders() {
    const row = $('#folderFilters');
    if (!folders.length) {
        row.style.display = 'none';
        row.innerHTML = '';
        return;
    }
    row.style.display = 'flex';
    row.innerHTML = folders.map((f, i) => `
        <button class="chip folder-chip" data-folder="${i}">
            <i class="far fa-folder"></i> ${esc(f.name)} <span class="folder-x" data-folder-del="${i}">✕</span>
        </button>`).join('');
}

$('#folderFilters').addEventListener('click', function(e) {
    const del = e.target.closest('[data-folder-del]');
    if (del) {
        e.stopPropagation();
        folders.splice(parseInt(del.dataset.folderDel, 10), 1);
        try { localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders)); } catch (err) { /* ignore */ }
        renderFolders();
        return;
    }
    const chip = e.target.closest('[data-folder]');
    if (!chip) return;
    const f = folders[parseInt(chip.dataset.folder, 10)];
    if (!f) return;
    typeFilter = f.type || 'all';
    statusFilter = f.status || 'all';
    decadeFilter = f.decade || 'all';
    sortMode = f.sort || 'rating-desc';
    $('#searchInput').value = f.query || '';
    $('#sortSelect').value = sortMode;
    $('#searchMode').value = f.searchMode || 'name';
    syncChips();
    render();
    showToast(`📁 Папка «${f.name}»`);
});

function saveFolder() {
    const name = $('#promptInput').value.trim();
    if (!name) {
        showToast('Введите название папки', true);
        return;
    }
    folders.push({
        name,
        type: typeFilter,
        status: statusFilter,
        decade: decadeFilter,
        query: ($('#searchInput').value || '').trim(),
        sort: sortMode,
        searchMode: $('#searchMode').value
    });
    try { localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders)); } catch (err) { /* ignore */ }
    closePrompt();
    renderFolders();
    showToast('📁 Папка сохранена!');
}

$('#saveFilterBtn').addEventListener('click', () => {
    openPrompt('📁 Имя для папки', 'Например: Хочу пересмотреть', '', saveFolder);
});

// ========================
//  ПРОМПТ
// ========================
function openPrompt(title, placeholder, initial, cb) {
    $('#promptTitle').textContent = title;
    $('#promptInput').placeholder = placeholder || '';
    $('#promptInput').value = initial || '';
    promptCallback = cb;
    $('#promptModal').classList.add('show');
    setTimeout(() => $('#promptInput').focus(), 80);
}

function closePrompt() {
    $('#promptModal').classList.remove('show');
    promptCallback = null;
}

$('#promptOk').addEventListener('click', () => {
    const cb = promptCallback;
    if (cb) cb();
});
$('#promptCancel').addEventListener('click', closePrompt);
$('#promptClose').addEventListener('click', closePrompt);

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
    else if ($('#rateModal').classList.contains('show')) closeRate();
    else if ($('#trashModal').classList.contains('show')) closeTrash();
    else if ($('#analyticsModal').classList.contains('show')) closeAnalytics();
    else if ($('#achievementsModal').classList.contains('show')) closeAchievements();
    else if ($('#duplicatesModal').classList.contains('show')) closeDuplicates();
    else if ($('#promptModal').classList.contains('show')) closePrompt();
    else if ($('#confirmModal').classList.contains('show')) closeConfirm();
    else if ($('#editModal').classList.contains('show')) closeModal();
}

document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeTopModal();
});

const CLOSE_FNS = {
    editModal: closeModal,
    detailModal: closeDetail,
    confirmModal: closeConfirm,
    rateModal: closeRate,
    trashModal: closeTrash,
    analyticsModal: closeAnalytics,
    achievementsModal: closeAchievements,
    duplicatesModal: closeDuplicates,
    promptModal: closePrompt
};
Object.keys(CLOSE_FNS).forEach(id => {
    document.getElementById(id).addEventListener('click', function(e) {
        if (e.target === this) CLOSE_FNS[id]();
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

$('#menuBtn').addEventListener('click', function(e) {
    e.stopPropagation();
    $$('.export-menu').forEach(m => m.classList.remove('show'));
    $('#mainMenu').classList.toggle('show');
});

document.addEventListener('click', function(e) {
    if (!e.target.closest('.export-wrap')) {
        $$('.export-menu').forEach(m => m.classList.remove('show'));
    }
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
//  АНАЛИТИКА
// ========================
const WEEK_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTH_LABELS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function weekDayOf(ts) {
    return (new Date(ts).getDay() + 6) % 7;
}

function computeAnalytics() {
    const res = {
        hours: 0,
        hoursKnown: 0,
        avgRewatches: 0,
        months: {},
        week: [0, 0, 0, 0, 0, 0, 0],
        topGenres: {},
        decades: {},
        monthCounts: {},
        streak: 0
    };
    const daySet = {};
    items.forEach(i => {
        if (i.id) {
            const d = new Date(i.id);
            if (!isNaN(d)) {
                const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                res.week[weekDayOf(i.id)]++;
                res.monthCounts[mk] = (res.monthCounts[mk] || 0) + 1;
                daySet[mk + '-' + d.getDate()] = 1;
            }
        }
        if (i.rating > 0 && i.watchedAt) {
            const mk = i.watchedAt.slice(0, 7);
            if (!res.months[mk]) res.months[mk] = { sum: 0, n: 0 };
            res.months[mk].sum += i.rating;
            res.months[mk].n++;
        }
        if (i.year) {
            const dec = Math.floor(i.year / 10) * 10;
            res.decades[dec] = (res.decades[dec] || 0) + 1;
        }
        (i.genres || []).forEach(g => { res.topGenres[g] = (res.topGenres[g] || 0) + 1; });
        res.avgRewatches += i.rewatches || 0;
        if (i.runtime && i.status === 'Просмотрено') {
            res.hours += i.runtime * (1 + (i.rewatches || 0));
        }
        if (i.runtime) res.hoursKnown++;
    });
    res.hours = Math.round(res.hours / 60);
    res.avgRewatches = items.length ? (res.avgRewatches / items.length).toFixed(1) : '0';

    const today = new Date();
    for (let k = 0; k < 1000; k++) {
        const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - k);
        const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (daySet[mk + '-' + d.getDate()]) res.streak++;
        else if (k > 0) break;
    }
    return res;
}

function renderAnalytics() {
    const a = computeAnalytics();

    let bestMonth = null;
    let bestCount = 0;
    Object.keys(a.monthCounts).forEach(mk => {
        if (a.monthCounts[mk] > bestCount) { bestCount = a.monthCounts[mk]; bestMonth = mk; }
    });
    const bestMonthLabel = bestMonth
        ? `${MONTH_LABELS[parseInt(bestMonth.slice(5), 10) - 1]} ${bestMonth.slice(0, 4)}` : '—';
    const hoursNote = !a.hours && items.length
        ? '<div class="an-none">Хронометраж подтянется после открытия деталей фильмов</div>' : '';

    const statsHtml = `
        <div class="an-stats">
            <div class="an-stat-card"><div class="v">${a.hours} ч</div><div class="k">часов просмотрено</div></div>
            <div class="an-stat-card"><div class="v">${a.avgRewatches}</div><div class="k">среднее пересмотров</div></div>
            <div class="an-stat-card"><div class="v sm">${bestMonthLabel}</div><div class="k">активный месяц · ${bestCount} шт</div></div>
            <div class="an-stat-card"><div class="v">${a.streak}🔥</div><div class="k">дней подряд</div></div>
        </div>${hoursNote}`;

    const months = Object.keys(a.months).sort();
    const monthsHtml = months.length ? months.map(mk => {
        const m = a.months[mk];
        const avg = Math.round((m.sum / m.n) * 10) / 10;
        const label = MONTH_LABELS[parseInt(mk.slice(5), 10) - 1] + '.' + mk.slice(2, 4);
        return `<div class="an-bar-row"><span class="lb">${label}</span><div class="an-bar-track"><div class="an-bar-fill" style="width:${avg * 10}%"></div></div><span class="vl">${avg}</span></div>`;
    }).join('') : '<div class="an-none">Нет просмотренных с оценками</div>';

    const genres = Object.entries(a.topGenres).sort((x, y) => y[1] - x[1]).slice(0, 8);
    const maxG = genres.length ? genres[0][1] : 1;
    const genresHtml = genres.length ? genres.map(([g, c]) => `
        <div class="an-bar-row"><span class="lb" title="${esc(g)}">${esc(g)}</span><div class="an-bar-track"><div class="an-bar-fill" style="width:${Math.round(c / maxG * 100)}%"></div></div><span class="vl">${c}</span></div>`).join('')
        : '<div class="an-none">Открой детали фильмов — жанры подтянутся из TMDB</div>';

    const decades = Object.keys(a.decades).map(Number).sort((x, y) => x - y);
    const maxD = decades.length ? Math.max(...decades.map(d => a.decades[d])) : 1;
    const decadesHtml = decades.length ? decades.map(d => `
        <div class="an-bar-row"><span class="lb">${d}-е</span><div class="an-bar-track"><div class="an-bar-fill" style="width:${Math.round(a.decades[d] / maxD * 100)}%"></div></div><span class="vl">${a.decades[d]}</span></div>`).join('')
        : '<div class="an-none">Нет данных о годах выпуска</div>';

    const maxW = Math.max(...a.week, 1);
    const weekHtml = a.week.map((c, i) => `
        <div class="an-week-col"><div class="an-week-bar" style="height:${Math.round(c / maxW * 100)}%"></div><span class="an-week-lbl">${WEEK_LABELS[i]}</span></div>`).join('');

    $('#analyticsBody').innerHTML = `
        <div class="an-block"><h4>Сводка</h4>${statsHtml}</div>
        <div class="an-block"><h4>Средняя оценка по месяцам</h4>${monthsHtml}</div>
        <div class="an-block"><h4>Топ жанров</h4>${genresHtml}</div>
        <div class="an-block"><h4>Фильмы по десятилетиям</h4>${decadesHtml}</div>
        <div class="an-block"><h4>Дни недели (добавления)</h4><div class="an-week">${weekHtml}</div></div>`;
    $('#analyticsModal').classList.add('show');
}

function closeAnalytics() {
    $('#analyticsModal').classList.remove('show');
}

// ========================
//  ДОСТИЖЕНИЯ И УРОВНИ
// ========================
function getLevel(n) {
    if (n >= 200) return { name: 'Легенда кино', next: null };
    if (n >= 100) return { name: 'Эксперт', next: 200 };
    if (n >= 50) return { name: 'Знаток', next: 100 };
    if (n >= 20) return { name: 'Киноман', next: 50 };
    if (n >= 5) return { name: 'Зритель', next: 20 };
    return { name: 'Новичок', next: 5 };
}

function checkAchievements() {
    const total = items.length;
    const watched = items.filter(i => i.status === 'Просмотрено').length;
    const rewatches = items.reduce((s, i) => s + (i.rewatches || 0), 0);
    const rated9 = items.filter(i => i.rating >= 9).length;
    const genres = new Set(items.flatMap(i => i.genres || []));
    const anime = items.filter(i => i.type === 'Аниме').length;
    const serials = items.filter(i => i.type === 'Сериал').length;
    const a = computeAnalytics();
    const list = [
        { icon: '🎬', name: 'Первые шаги', desc: 'добавь первый фильм', cur: Math.min(total, 1), need: 1, done: total >= 1 },
        { icon: '📺', name: 'Сериаломан', desc: '10 сериалов в коллекции', cur: Math.min(serials, 10), need: 10, done: serials >= 10 },
        { icon: '🎌', name: 'Аниме-фанат', desc: '10 аниме в коллекции', cur: Math.min(anime, 10), need: 10, done: anime >= 10 },
        { icon: '🍿', name: 'Киномарафон', desc: '50 просмотренных', cur: Math.min(watched, 50), need: 50, done: watched >= 50 },
        { icon: '🔄', name: 'Мастер пересмотров', desc: '10 пересмотров', cur: Math.min(rewatches, 10), need: 10, done: rewatches >= 10 },
        { icon: '⭐', name: 'Строгий критик', desc: '10 оценок 9–10', cur: Math.min(rated9, 10), need: 10, done: rated9 >= 10 },
        { icon: '🎭', name: 'Разносторонний', desc: '5 разных жанров', cur: Math.min(genres.size, 5), need: 5, done: genres.size >= 5 },
        { icon: '🔥', name: 'Серия недели', desc: '7 дней подряд с добавлениями', cur: Math.min(a.streak, 7), need: 7, done: a.streak >= 7 },
        { icon: '🏛️', name: 'Хранитель истории', desc: 'самая старая запись в коллекции', cur: items.length ? 1 : 0, need: 1, done: items.length > 0 },
        { icon: '🏆', name: 'Легенда', desc: '100 фильмов в коллекции', cur: Math.min(total, 100), need: 100, done: total >= 100 }
    ];
    return { level: getLevel(total), list };
}

function renderAchievements() {
    const { level, list } = checkAchievements();
    const doneCount = list.filter(a => a.done).length;
    $('#achLevelName').textContent = level.name;
    $('#achLevelSub').textContent = `Уровень «${level.name}» · ${items.length} записей · выполнено ${doneCount} из ${list.length}`;
    $('#achGrid').innerHTML = list.map(a => `
        <div class="ach-item${a.done ? '' : ' locked'}">
            <div class="ach-icon">${a.icon}</div>
            <div class="ach-info">
                <div class="ach-name">${a.name}</div>
                <div class="ach-desc">${a.desc}</div>
                <div class="ach-bar"><div class="fill" style="width:${Math.min(100, Math.round(a.cur / a.need * 100))}%"></div></div>
            </div>
        </div>`).join('');
    $('#achievementsModal').classList.add('show');
}

function closeAchievements() {
    $('#achievementsModal').classList.remove('show');
}

// ========================
//  КУЛЬТОВАЯ КЛАССИКА
// ========================
function renderClassics() {
    const section = $('#classicsSection');
    const query = ($('#searchInput').value || '').trim();
    const missing = CLASSICS.filter(c => !items.some(i => i.name.trim().toLowerCase() === c.name.toLowerCase()));
    if (!missing.length || query) {
        section.style.display = 'none';
        return;
    }
    section.style.display = 'block';
    $('#classicsRow').innerHTML = missing.slice(0, 12).map(c => `
        <div class="classic-item" data-classic-name="${esc(c.name)}" data-classic-type="${c.type}">
            <div class="classic-icon"><i class="fas fa-film"></i></div>
            <div class="classic-name">${esc(c.name)}</div>
            <div class="classic-year">${c.year}</div>
            <button class="classic-add">+ Добавить</button>
        </div>`).join('');
}

$('#classicsRow').addEventListener('click', function(e) {
    const btn = e.target.closest('.classic-add');
    if (!btn) return;
    const el = btn.closest('[data-classic-name]');
    if (!el) return;
    if (addItem(el.dataset.classicName, el.dataset.classicType, 'Буду смотреть', 0, 0, '', 0, 0, '')) {
        render();
        showToast('📌 Добавлено в «Буду смотреть»!');
    }
});

// ========================
//  ЕЖЕНЕДЕЛЬНАЯ СВОДКА
// ========================
function weeklySummary() {
    try {
        const now = new Date();
        const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
        let added = 0;
        let before = 0;
        items.forEach(i => {
            const d = new Date(i.id);
            if (!isNaN(d) && d > weekStart) added++;
            else if (!isNaN(d) && d > new Date(weekStart.getTime() - 7 * 86400000)) before++;
        });
        if (localStorage.getItem(WEEK_KEY) !== now.toDateString() && added > 0) {
            const diff = added - before;
            const diffText = diff > 0 ? ` (+${diff} к прошлой)` : diff < 0 ? ` (${diff} к прошлой)` : '';
            showToast(`📈 За неделю добавлено: ${added}${diffText}`);
            localStorage.setItem(WEEK_KEY, now.toDateString());
        }
    } catch (e) { /* ignore */ }
}

// ========================
//  ФОНОВАЯ ДОЗАГРУЗКА TMDB (год + рейтинг + жанры + хронометраж)
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
                    if (!item.overview && first.overview) item.overview = first.overview;
                    if (item.runtime === null && first.runtime) item.runtime = first.runtime;
                    if ((!item.genres || !item.genres.length) && first.genre_ids && first.genre_ids.length) {
                        try {
                            const genreMap = await fetchGenreMap();
                            item.genres = first.genre_ids.map(id => genreMap[id]).filter(Boolean);
                        } catch (e) { /* ignore */ }
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
$('#fabAdd').addEventListener('click', openAddModal);

// ========================
//  ЗАПУСК
// ========================
applyTheme();
setView(viewMode);
loadData();
backfillTMDB();
console.log('🎬 Киноархив загружен! Всего записей:', items.length);
