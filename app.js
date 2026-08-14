// ========================
//  TMDB API
// ========================
const TMDB_API_KEY = '40f8044a3992bf1a264badac3ca33f28';

// Авторизация TMDB: api_key в query-параметрах (работает с ключом v3).
// При 401/403 пробуем Bearer-заголовок на случай будущих v4-токенов.
async function tmdbFetch(path) {
    const base = 'https://api.themoviedb.org/3';
    const sep = path.includes('?') ? '&' : '?';

    let resp = await fetch(`${base}${path}${sep}api_key=${TMDB_API_KEY}`);

    if (resp.status === 401 || resp.status === 403) {
        resp = await fetch(base + path, {
            headers: { Authorization: `Bearer ${TMDB_API_KEY}` }
        });
    }
    return resp;
}

// ========================
//  ПОСТЕРЫ (постоянный кэш в IndexedDB)
// ========================
// Обложки скачиваются один раз (через прокси wsrv.nl, т.к. image.tmdb.org
// часто заблокирован) и хранятся в IndexedDB. При перерисовке интерфейса
// и перезагрузке страницы обложки подставляются мгновенно из кэша.
const posterBlobCache = new Map();   // url -> objectURL (память)
const posterFetchQueue = new Map();  // url -> Promise (дедупликация)
const POSTER_DB_NAME = 'kinoPostersDB';
const POSTER_DB_STORE = 'posters';
let posterDB = null;

function openPosterDB() {
    if (posterDB) return Promise.resolve(posterDB);
    return new Promise(resolve => {
        try {
            const req = indexedDB.open(POSTER_DB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(POSTER_DB_STORE)) db.createObjectStore(POSTER_DB_STORE);
            };
            req.onsuccess = () => { posterDB = req.result; resolve(posterDB); };
            req.onerror = () => { posterDB = null; resolve(null); };
        } catch (e) {
            resolve(null);
        }
    });
}

function idbGetPoster(url) {
    return openPosterDB().then(db => new Promise(resolve => {
        if (!db) return resolve(null);
        try {
            const tx = db.transaction(POSTER_DB_STORE, 'readonly');
            const req = tx.objectStore(POSTER_DB_STORE).get(url);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        } catch (e) {
            resolve(null);
        }
    }));
}

function idbPutPoster(url, blob) {
    openPosterDB().then(db => {
        if (!db) return;
        try {
            const tx = db.transaction(POSTER_DB_STORE, 'readwrite');
            tx.objectStore(POSTER_DB_STORE).put(blob, url);
        } catch (e) { /* ignore */ }
    });
}

async function fetchPosterBlob(url) {
    try {
        const resp = await fetch(url);
        if (resp.ok) {
            const blob = await resp.blob();
            if (blob && blob.size > 100) return blob;
        }
    } catch (e) { /* ignore */ }
    try {
        const proxied = 'https://wsrv.nl/?url=' + encodeURIComponent(url) + '&w=500';
        const resp = await fetch(proxied);
        if (resp.ok) {
            const blob = await resp.blob();
            if (blob && blob.size > 100) return blob;
        }
    } catch (e) { /* ignore */ }
    return null;
}

// Возвращает blob-URL для картинки (из памяти / IndexedDB / сети).
function ensurePosterCached(url) {
    if (posterBlobCache.has(url)) return Promise.resolve(posterBlobCache.get(url));
    if (posterFetchQueue.has(url)) return posterFetchQueue.get(url);

    const p = idbGetPoster(url).then(blob => {
        if (blob) {
            const obj = URL.createObjectURL(blob);
            posterBlobCache.set(url, obj);
            return obj;
        }
        return fetchPosterBlob(url).then(blob => {
            if (blob) {
                const obj = URL.createObjectURL(blob);
                posterBlobCache.set(url, obj);
                idbPutPoster(url, blob);
                return obj;
            }
            posterBlobCache.set(url, url);
            return url;
        });
    }).catch(() => url);

    posterFetchQueue.set(url, p);
    p.then(() => posterFetchQueue.delete(url), () => posterFetchQueue.delete(url));
    return p;
}

// Проходится по всем картинкам на странице и подменяет их на кэшированные
// blob-URL. Вызывается после каждого перерендера.
function warmPosterCache() {
    const imgs = document.querySelectorAll('img[src^="http"]');
    const pending = [];
    imgs.forEach(img => {
        const src = img.src;
        if (!src || src.startsWith('blob:')) return;
        const cached = posterBlobCache.get(src);
        if (cached) {
            img.src = cached;
        } else {
            pending.push({ img, src });
        }
    });
    let i = 0;
    const step = async () => {
        while (i < pending.length) {
            const { img, src } = pending[i++];
            const obj = await ensurePosterCached(src);
            if (obj && obj !== src && img.isConnected && !img.src.startsWith('blob:')) {
                img.src = obj;
            }
        }
    };
    for (let c = 0; c < 6 && c < pending.length; c++) step();
}

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

// Запасной путь для картинок: грузим через кэш/прокси wsrv.nl,
// а если и он не смог — плейсхолдер.
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
    ensurePosterCached(url).then(src => {
        if (!img.isConnected) return;
        if (src && src !== url && !img.src.startsWith('blob:')) {
            img.src = src;
        } else if (!img.src.startsWith('blob:')) {
            if (mode === 'hero') {
                img.style.display = 'none';
                const fb = document.getElementById('detailHeroFallback');
                if (fb) fb.style.display = 'flex';
            } else {
                img.outerHTML = posterFallbackHtml(mode, name);
            }
        }
    });
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
let viewMode = 'grid';
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

const COLLECTIONS = [
    {
        name: 'Гарри Поттер', icon: '🪄',
        films: [
            { name: 'Гарри Поттер и философский камень', type: 'Фильм', year: 2001 },
            { name: 'Гарри Поттер и Тайная комната', type: 'Фильм', year: 2002 },
            { name: 'Гарри Поттер и узник Азкабана', type: 'Фильм', year: 2004 },
            { name: 'Гарри Поттер и Кубок огня', type: 'Фильм', year: 2005 },
            { name: 'Гарри Поттер и Орден Феникса', type: 'Фильм', year: 2007 },
            { name: 'Гарри Поттер и Принц-полукровка', type: 'Фильм', year: 2009 },
            { name: 'Гарри Поттер и Дары Смерти: Часть 1', type: 'Фильм', year: 2010 },
            { name: 'Гарри Поттер и Дары Смерти: Часть 2', type: 'Фильм', year: 2011 }
        ]
    },
    {
        name: 'Марвел (MCU)', icon: '🕷️',
        films: [
            { name: 'Железный человек', type: 'Фильм', year: 2008 },
            { name: 'Невероятный Халк', type: 'Фильм', year: 2008 },
            { name: 'Железный человек 2', type: 'Фильм', year: 2010 },
            { name: 'Тор', type: 'Фильм', year: 2011 },
            { name: 'Первый мститель', type: 'Фильм', year: 2011 },
            { name: 'Мстители', type: 'Фильм', year: 2012 },
            { name: 'Железный человек 3', type: 'Фильм', year: 2013 },
            { name: 'Тор 2: Царство тьмы', type: 'Фильм', year: 2013 },
            { name: 'Первый мститель: Другая война', type: 'Фильм', year: 2014 },
            { name: 'Стражи Галактики', type: 'Фильм', year: 2014 },
            { name: 'Мстители: Эра Альтрона', type: 'Фильм', year: 2015 },
            { name: 'Человек-муравей', type: 'Фильм', year: 2015 },
            { name: 'Первый мститель: Противостояние', type: 'Фильм', year: 2016 },
            { name: 'Доктор Стрэндж', type: 'Фильм', year: 2016 },
            { name: 'Стражи Галактики. Часть 2', type: 'Фильм', year: 2017 },
            { name: 'Человек-паук: Возвращение домой', type: 'Фильм', year: 2017 },
            { name: 'Тор: Рагнарёк', type: 'Фильм', year: 2017 },
            { name: 'Чёрная Пантера', type: 'Фильм', year: 2018 },
            { name: 'Мстители: Война бесконечности', type: 'Фильм', year: 2018 },
            { name: 'Человек-муравей и Оса', type: 'Фильм', year: 2018 },
            { name: 'Капитан Марвел', type: 'Фильм', year: 2019 },
            { name: 'Мстители: Финал', type: 'Фильм', year: 2019 },
            { name: 'Человек-паук: Вдали от дома', type: 'Фильм', year: 2019 },
            { name: 'Чёрная вдова', type: 'Фильм', year: 2021 },
            { name: 'Шан-Чи и Легенда Десяти Колец', type: 'Фильм', year: 2021 },
            { name: 'Вечные', type: 'Фильм', year: 2021 },
            { name: 'Человек-паук: Нет пути домой', type: 'Фильм', year: 2021 },
            { name: 'Доктор Стрэндж: В мультивселенной безумия', type: 'Фильм', year: 2022 },
            { name: 'Тор: Любовь и гром', type: 'Фильм', year: 2022 },
            { name: 'Чёрная Пантера: Ваканда навеки', type: 'Фильм', year: 2022 },
            { name: 'Человек-муравей и Оса: Квантомания', type: 'Фильм', year: 2023 },
            { name: 'Стражи Галактики. Часть 3', type: 'Фильм', year: 2023 }
        ]
    },
    {
        name: 'Трансформеры', icon: '🤖',
        films: [
            { name: 'Трансформеры', type: 'Фильм', year: 2007 },
            { name: 'Трансформеры 2: Месть Падших', type: 'Фильм', year: 2009 },
            { name: 'Трансформеры 3: Тёмная сторона Луны', type: 'Фильм', year: 2011 },
            { name: 'Трансформеры 4: Эпоха истребления', type: 'Фильм', year: 2014 },
            { name: 'Трансформеры 5: Последний рыцарь', type: 'Фильм', year: 2017 }
        ]
    },
    {
        name: 'Кунг-фу Панда', icon: '🐼',
        films: [
            { name: 'Кунг-фу Панда', type: 'Фильм', year: 2008 },
            { name: 'Кунг-фу Панда 2', type: 'Фильм', year: 2011 },
            { name: 'Кунг-фу Панда 3', type: 'Фильм', year: 2016 },
            { name: 'Кунг-фу Панда 4', type: 'Фильм', year: 2024 }
        ]
    },
    {
        name: 'Бэтмен', icon: '🦇',
        films: [
            { name: 'Бэтмен: Начало', type: 'Фильм', year: 2005 },
            { name: 'Тёмный рыцарь', type: 'Фильм', year: 2008 },
            { name: 'Тёмный рыцарь: Возрождение легенды', type: 'Фильм', year: 2012 },
            { name: 'Бэтмен', type: 'Фильм', year: 2022 }
        ]
    },
    {
        name: 'Бегущий в лабиринте', icon: '🌀',
        films: [
            { name: 'Бегущий в лабиринте', type: 'Фильм', year: 2014 },
            { name: 'Бегущий в лабиринте: Испытание огнём', type: 'Фильм', year: 2015 },
            { name: 'Бегущий в лабиринте: Лекарство от смерти', type: 'Фильм', year: 2018 }
        ]
    },
    {
        name: 'Дэдпул', icon: '🔫',
        films: [
            { name: 'Дэдпул', type: 'Фильм', year: 2016 },
            { name: 'Дэдпул 2', type: 'Фильм', year: 2018 },
            { name: 'Дэдпул и Росомаха', type: 'Фильм', year: 2024 }
        ]
    },
    {
        name: 'Властелин колец', icon: '💍',
        films: [
            { name: 'Властелин колец: Братство кольца', type: 'Фильм', year: 2001 },
            { name: 'Властелин колец: Две крепости', type: 'Фильм', year: 2002 },
            { name: 'Властелин колец: Возвращение короля', type: 'Фильм', year: 2003 }
        ]
    },
    {
        name: 'Хоббит', icon: '⚔️',
        films: [
            { name: 'Хоббит: Нежданное путешествие', type: 'Фильм', year: 2012 },
            { name: 'Хоббит: Пустошь Смауга', type: 'Фильм', year: 2013 },
            { name: 'Хоббит: Битва пяти воинств', type: 'Фильм', year: 2014 }
        ]
    },
    {
        name: 'Пираты Карибского моря', icon: '🏴‍☠️',
        films: [
            { name: 'Пираты Карибского моря: Проклятие Чёрной жемчужины', type: 'Фильм', year: 2003 },
            { name: 'Пираты Карибского моря: Сундук мертвеца', type: 'Фильм', year: 2006 },
            { name: 'Пираты Карибского моря: На краю света', type: 'Фильм', year: 2007 },
            { name: 'Пираты Карибского моря: На странных берегах', type: 'Фильм', year: 2011 },
            { name: 'Пираты Карибского моря: Мертвецы не рассказывают сказки', type: 'Фильм', year: 2017 }
        ]
    },
    {
        name: 'Форсаж', icon: '🏎️',
        films: [
            { name: 'Форсаж', type: 'Фильм', year: 2001 },
            { name: 'Двойной форсаж', type: 'Фильм', year: 2003 },
            { name: 'Тройной форсаж: Токийский дрифт', type: 'Фильм', year: 2006 },
            { name: 'Форсаж 4', type: 'Фильм', year: 2009 },
            { name: 'Форсаж 5', type: 'Фильм', year: 2011 },
            { name: 'Форсаж 6', type: 'Фильм', year: 2013 },
            { name: 'Форсаж 7', type: 'Фильм', year: 2015 },
            { name: 'Форсаж 8', type: 'Фильм', year: 2017 },
            { name: 'Форсаж: Хоббс и Шоу', type: 'Фильм', year: 2019 },
            { name: 'Форсаж 9', type: 'Фильм', year: 2021 }
        ]
    },
    {
        name: 'Звёздные войны', icon: '⚔️',
        films: [
            { name: 'Звёздные войны: Скрытая угроза', type: 'Фильм', year: 1999 },
            { name: 'Звёздные войны: Атака клонов', type: 'Фильм', year: 2002 },
            { name: 'Звёздные войны: Месть ситхов', type: 'Фильм', year: 2005 },
            { name: 'Изгой-один: Звёздные войны. Истории', type: 'Фильм', year: 2016 },
            { name: 'Звёздные войны: Пробуждение силы', type: 'Фильм', year: 2015 },
            { name: 'Звёздные войны: Последние джедаи', type: 'Фильм', year: 2017 },
            { name: 'Звёздные войны: Скайуокер. Восход', type: 'Фильм', year: 2019 }
        ]
    },
    {
        name: 'Дюна', icon: '🏜️',
        films: [
            { name: 'Дюна', type: 'Фильм', year: 2021 },
            { name: 'Дюна: Часть вторая', type: 'Фильм', year: 2024 }
        ]
    },
    {
        name: 'Индиана Джонс', icon: '🤠',
        films: [
            { name: 'Индиана Джонс: В поисках утраченного ковчега', type: 'Фильм', year: 1981 },
            { name: 'Индиана Джонс и храм судьбы', type: 'Фильм', year: 1984 },
            { name: 'Индиана Джонс и последний крестовый поход', type: 'Фильм', year: 1989 },
            { name: 'Индиана Джонс и Королевство хрустального черепа', type: 'Фильм', year: 2008 },
            { name: 'Индиана Джонс и колесо судьбы', type: 'Фильм', year: 2023 }
        ]
    },
    {
        name: 'Аниме-хиты', icon: '🎌',
        films: [
            { name: 'Токийский Гуль', type: 'Аниме', year: 2014 },
            { name: 'Магическая битва', type: 'Аниме', year: 2020 },
            { name: 'Блюлок', type: 'Аниме', year: 2022 },
            { name: 'Баскетбол Курокко', type: 'Аниме', year: 2012 },
            { name: 'Соло Левелинг', type: 'Аниме', year: 2024 },
            { name: 'Реинкарнация безработного', type: 'Аниме', year: 2021 },
            { name: 'Атака титанов', type: 'Аниме', year: 2013 }
        ]
    },
    {
        name: 'Матрица', icon: '🕶️',
        films: [
            { name: 'Матрица', type: 'Фильм', year: 1999 },
            { name: 'Матрица: Перезагрузка', type: 'Фильм', year: 2003 },
            { name: 'Матрица: Революция', type: 'Фильм', year: 2003 },
            { name: 'Матрица: Воскрешение', type: 'Фильм', year: 2021 }
        ]
    },
    {
        name: 'Джон Уик', icon: '🐕',
        films: [
            { name: 'Джон Уик', type: 'Фильм', year: 2014 },
            { name: 'Джон Уик 2', type: 'Фильм', year: 2017 },
            { name: 'Джон Уик 3', type: 'Фильм', year: 2019 },
            { name: 'Джон Уик 4', type: 'Фильм', year: 2023 }
        ]
    },
    {
        name: 'Миссия невыполнима', icon: '🎖️',
        films: [
            { name: 'Миссия невыполнима', type: 'Фильм', year: 1996 },
            { name: 'Миссия невыполнима 2', type: 'Фильм', year: 2000 },
            { name: 'Миссия невыполнима 3', type: 'Фильм', year: 2006 },
            { name: 'Миссия невыполнима: Протокол Фантом', type: 'Фильм', year: 2011 },
            { name: 'Миссия невыполнима: Племя изгоев', type: 'Фильм', year: 2015 },
            { name: 'Миссия невыполнима: Последствия', type: 'Фильм', year: 2018 },
            { name: 'Миссия невыполнима: Смертельная расплата. Часть 1', type: 'Фильм', year: 2023 }
        ]
    },
    {
        name: 'Терминатор', icon: '🦾',
        films: [
            { name: 'Терминатор', type: 'Фильм', year: 1984 },
            { name: 'Терминатор 2: Судный день', type: 'Фильм', year: 1991 },
            { name: 'Терминатор 3: Восстание машин', type: 'Фильм', year: 2003 },
            { name: 'Терминатор: Да придёт спаситель', type: 'Фильм', year: 2009 },
            { name: 'Терминатор: Генезис', type: 'Фильм', year: 2015 },
            { name: 'Терминатор: Тёмные судьбы', type: 'Фильм', year: 2019 }
        ]
    },
    {
        name: 'Рэмбо', icon: '🏹',
        films: [
            { name: 'Рэмбо: Первая кровь', type: 'Фильм', year: 1982 },
            { name: 'Рэмбо: Первая кровь 2', type: 'Фильм', year: 1985 },
            { name: 'Рэмбо III', type: 'Фильм', year: 1988 },
            { name: 'Рэмбо IV', type: 'Фильм', year: 2008 },
            { name: 'Рэмбо: Последняя кровь', type: 'Фильм', year: 2019 }
        ]
    },
    {
        name: 'Крепкий орешек', icon: '💥',
        films: [
            { name: 'Крепкий орешек', type: 'Фильм', year: 1988 },
            { name: 'Крепкий орешек 2', type: 'Фильм', year: 1990 },
            { name: 'Крепкий орешек 3: Возмездие', type: 'Фильм', year: 1995 },
            { name: 'Крепкий орешек 4.0', type: 'Фильм', year: 2007 },
            { name: 'Крепкий орешек: Хороший день, чтобы умереть', type: 'Фильм', year: 2013 }
        ]
    },
    {
        name: 'Шрек', icon: '🟢',
        films: [
            { name: 'Шрек', type: 'Фильм', year: 2001 },
            { name: 'Шрек 2', type: 'Фильм', year: 2004 },
            { name: 'Шрек Третий', type: 'Фильм', year: 2007 },
            { name: 'Шрек навсегда', type: 'Фильм', year: 2010 }
        ]
    },
    {
        name: 'Ледниковый период', icon: '🧊',
        films: [
            { name: 'Ледниковый период', type: 'Фильм', year: 2002 },
            { name: 'Ледниковый период 2: Глобальное потепление', type: 'Фильм', year: 2006 },
            { name: 'Ледниковый период 3: Эра динозавров', type: 'Фильм', year: 2009 },
            { name: 'Ледниковый период 4: Континентальный дрейф', type: 'Фильм', year: 2012 },
            { name: 'Ледниковый период: Столкновение неизбежно', type: 'Фильм', year: 2016 }
        ]
    },
    {
        name: 'Гадкий я и Миньоны', icon: '🍌',
        films: [
            { name: 'Гадкий я', type: 'Фильм', year: 2010 },
            { name: 'Гадкий я 2', type: 'Фильм', year: 2013 },
            { name: 'Гадкий я 3', type: 'Фильм', year: 2017 },
            { name: 'Гадкий я 4', type: 'Фильм', year: 2024 },
            { name: 'Миньоны', type: 'Фильм', year: 2015 },
            { name: 'Миньоны: Грювитация', type: 'Фильм', year: 2022 }
        ]
    },
    {
        name: 'История игрушек', icon: '🤠',
        films: [
            { name: 'История игрушек', type: 'Фильм', year: 1995 },
            { name: 'История игрушек 2', type: 'Фильм', year: 1999 },
            { name: 'История игрушек: Большой побег', type: 'Фильм', year: 2010 },
            { name: 'История игрушек 4', type: 'Фильм', year: 2019 }
        ]
    },
    {
        name: 'Как приручить дракона', icon: '🐲',
        films: [
            { name: 'Как приручить дракона', type: 'Фильм', year: 2010 },
            { name: 'Как приручить дракона 2', type: 'Фильм', year: 2014 },
            { name: 'Как приручить дракона 3', type: 'Фильм', year: 2019 }
        ]
    },
    {
        name: 'Холодное сердце', icon: '❄️',
        films: [
            { name: 'Холодное сердце', type: 'Фильм', year: 2013 },
            { name: 'Холодное сердце 2', type: 'Фильм', year: 2019 }
        ]
    },
    {
        name: 'Веном', icon: '🖤',
        films: [
            { name: 'Веном', type: 'Фильм', year: 2018 },
            { name: 'Веном 2', type: 'Фильм', year: 2021 },
            { name: 'Веном: Последний танец', type: 'Фильм', year: 2024 }
        ]
    },
    {
        name: 'Соник', icon: '💨',
        films: [
            { name: 'Соник в кино', type: 'Фильм', year: 2020 },
            { name: 'Соник 2 в кино', type: 'Фильм', year: 2022 },
            { name: 'Соник 3 в кино', type: 'Фильм', year: 2024 }
        ]
    },
    {
        name: 'Аватар', icon: '🌌',
        films: [
            { name: 'Аватар', type: 'Фильм', year: 2009 },
            { name: 'Аватар: Путь воды', type: 'Фильм', year: 2022 }
        ]
    },
    {
        name: 'Монстраверс', icon: '🦖',
        films: [
            { name: 'Годзилла', type: 'Фильм', year: 2014 },
            { name: 'Конг: Остров черепа', type: 'Фильм', year: 2017 },
            { name: 'Годзилла 2: Король монстров', type: 'Фильм', year: 2019 },
            { name: 'Годзилла против Конга', type: 'Фильм', year: 2021 },
            { name: 'Годзилла и Конг: Новая империя', type: 'Фильм', year: 2024 }
        ]
    },
    {
        name: 'Голодные игры', icon: '🔥',
        films: [
            { name: 'Голодные игры', type: 'Фильм', year: 2012 },
            { name: 'Голодные игры: И вспыхнет пламя', type: 'Фильм', year: 2013 },
            { name: 'Голодные игры: Сойка-пересмешница. Часть 1', type: 'Фильм', year: 2014 },
            { name: 'Голодные игры: Сойка-пересмешница. Часть 2', type: 'Фильм', year: 2015 },
            { name: 'Голодные игры: Баллада о змеях и певчих птицах', type: 'Фильм', year: 2023 }
        ]
    },
    {
        name: 'Дивергент', icon: '✂️',
        films: [
            { name: 'Дивергент', type: 'Фильм', year: 2014 },
            { name: 'Дивергент, глава 2: Инсургент', type: 'Фильм', year: 2015 },
            { name: 'Дивергент, глава 3: За стеной', type: 'Фильм', year: 2016 }
        ]
    },
    {
        name: 'Сумерки', icon: '🌒',
        films: [
            { name: 'Сумерки', type: 'Фильм', year: 2008 },
            { name: 'Сумерки. Сага. Новолуние', type: 'Фильм', year: 2009 },
            { name: 'Сумерки. Сага. Затмение', type: 'Фильм', year: 2010 },
            { name: 'Сумерки. Сага. Рассвет — Часть 1', type: 'Фильм', year: 2011 },
            { name: 'Сумерки. Сага. Рассвет — Часть 2', type: 'Фильм', year: 2012 }
        ]
    },
    {
        name: 'Оно', icon: '🎈',
        films: [
            { name: 'Оно', type: 'Фильм', year: 2017 },
            { name: 'Оно 2', type: 'Фильм', year: 2019 }
        ]
    },
    {
        name: 'Заклятие', icon: '🕯️',
        films: [
            { name: 'Заклятие', type: 'Фильм', year: 2013 },
            { name: 'Заклятие 2', type: 'Фильм', year: 2016 },
            { name: 'Заклятие 3: По воле дьявола', type: 'Фильм', year: 2021 }
        ]
    },
    {
        name: 'Люди Икс', icon: '⚡',
        films: [
            { name: 'Люди Икс', type: 'Фильм', year: 2000 },
            { name: 'Люди Икс 2', type: 'Фильм', year: 2003 },
            { name: 'Люди Икс: Последняя битва', type: 'Фильм', year: 2006 },
            { name: 'Люди Икс: Первый класс', type: 'Фильм', year: 2011 },
            { name: 'Люди Икс: Дни минувшего будущего', type: 'Фильм', year: 2014 },
            { name: 'Люди Икс: Апокалипсис', type: 'Фильм', year: 2016 },
            { name: 'Логан', type: 'Фильм', year: 2017 }
        ]
    },
    {
        name: 'Человек-паук (до MCU)', icon: '🕸️',
        films: [
            { name: 'Человек-паук', type: 'Фильм', year: 2002 },
            { name: 'Человек-паук 2', type: 'Фильм', year: 2004 },
            { name: 'Человек-паук 3: Враг в отражении', type: 'Фильм', year: 2007 },
            { name: 'Новый Человек-паук', type: 'Фильм', year: 2012 },
            { name: 'Новый Человек-паук: Высокое напряжение', type: 'Фильм', year: 2014 }
        ]
    },
    {
        name: 'Расширенная вселенная DC', icon: '🦸',
        films: [
            { name: 'Человек из стали', type: 'Фильм', year: 2013 },
            { name: 'Бэтмен против Супермена: На заре справедливости', type: 'Фильм', year: 2016 },
            { name: 'Отряд самоубийц', type: 'Фильм', year: 2016 },
            { name: 'Чудо-женщина', type: 'Фильм', year: 2017 },
            { name: 'Лига справедливости', type: 'Фильм', year: 2017 },
            { name: 'Аквамен', type: 'Фильм', year: 2018 },
            { name: 'Шазам!', type: 'Фильм', year: 2019 },
            { name: 'Хищные птицы: Потрясающая история Харли Квинн', type: 'Фильм', year: 2020 },
            { name: 'Чудо-женщина: 1984', type: 'Фильм', year: 2020 },
            { name: 'Отряд самоубийц: Миссия навылет', type: 'Фильм', year: 2021 },
            { name: 'Чёрный Адам', type: 'Фильм', year: 2022 },
            { name: 'Шазам! Ярость богов', type: 'Фильм', year: 2023 },
            { name: 'Флэш', type: 'Фильм', year: 2023 },
            { name: 'Аквамен и потерянное царство', type: 'Фильм', year: 2023 },
            { name: 'Синий жук', type: 'Фильм', year: 2023 }
        ]
    },
    {
        name: 'Джокер', icon: '🤡',
        films: [
            { name: 'Джокер', type: 'Фильм', year: 2019 },
            { name: 'Джокер: Безумие на двоих', type: 'Фильм', year: 2024 }
        ]
    },
    {
        name: 'Джеймс Бонд (Крэйг)', icon: '🕴️',
        films: [
            { name: 'Казино Рояль', type: 'Фильм', year: 2006 },
            { name: 'Квант милосердия', type: 'Фильм', year: 2008 },
            { name: '007: Координаты «Скайфолл»', type: 'Фильм', year: 2012 },
            { name: '007: Спектр', type: 'Фильм', year: 2015 },
            { name: 'Не время умирать', type: 'Фильм', year: 2021 }
        ]
    },
    {
        name: 'Kingsman', icon: '🎩',
        films: [
            { name: 'Kingsman: Секретная служба', type: 'Фильм', year: 2014 },
            { name: 'Kingsman: Золотое кольцо', type: 'Фильм', year: 2017 },
            { name: 'King\'s Man: Начало', type: 'Фильм', year: 2021 }
        ]
    },
    {
        name: 'Рокки', icon: '🥊',
        films: [
            { name: 'Рокки', type: 'Фильм', year: 1976 },
            { name: 'Рокки 2', type: 'Фильм', year: 1979 },
            { name: 'Рокки 3', type: 'Фильм', year: 1982 },
            { name: 'Рокки 4', type: 'Фильм', year: 1985 },
            { name: 'Рокки 5', type: 'Фильм', year: 1990 },
            { name: 'Рокки Бальбоа', type: 'Фильм', year: 2006 }
        ]
    },
    {
        name: 'Крид', icon: '🥊',
        films: [
            { name: 'Крид: Наследие Рокки', type: 'Фильм', year: 2015 },
            { name: 'Крид 2', type: 'Фильм', year: 2018 },
            { name: 'Крид 3', type: 'Фильм', year: 2023 }
        ]
    },
    {
        name: 'Хищник', icon: '👽',
        films: [
            { name: 'Хищник', type: 'Фильм', year: 1987 },
            { name: 'Хищник 2', type: 'Фильм', year: 1990 },
            { name: 'Хищники', type: 'Фильм', year: 2010 },
            { name: 'Хищник', type: 'Фильм', year: 2018 },
            { name: 'Добыча', type: 'Фильм', year: 2022 }
        ]
    },
    {
        name: 'Чужой', icon: '🛸',
        films: [
            { name: 'Чужой', type: 'Фильм', year: 1979 },
            { name: 'Чужие', type: 'Фильм', year: 1986 },
            { name: 'Чужой 3', type: 'Фильм', year: 1992 },
            { name: 'Чужой: Воскрешение', type: 'Фильм', year: 1997 },
            { name: 'Прометей', type: 'Фильм', year: 2012 },
            { name: 'Чужой: Завет', type: 'Фильм', year: 2017 }
        ]
    },
    {
        name: 'Планета обезьян', icon: '🐵',
        films: [
            { name: 'Восстание планеты обезьян', type: 'Фильм', year: 2011 },
            { name: 'Планета обезьян: Революция', type: 'Фильм', year: 2014 },
            { name: 'Планета обезьян: Война', type: 'Фильм', year: 2017 },
            { name: 'Планета обезьян: Новое царство', type: 'Фильм', year: 2024 }
        ]
    },
    {
        name: 'Тихое место', icon: '🔇',
        films: [
            { name: 'Тихое место', type: 'Фильм', year: 2018 },
            { name: 'Тихое место 2', type: 'Фильм', year: 2020 },
            { name: 'Тихое место: День первый', type: 'Фильм', year: 2024 }
        ]
    },
    {
        name: 'Обитель зла', icon: '🧟',
        films: [
            { name: 'Обитель зла', type: 'Фильм', year: 2002 },
            { name: 'Обитель зла 2: Апокалипсис', type: 'Фильм', year: 2004 },
            { name: 'Обитель зла 3', type: 'Фильм', year: 2007 },
            { name: 'Обитель зла 4: Жизнь после смерти', type: 'Фильм', year: 2010 },
            { name: 'Обитель зла: Возмездие', type: 'Фильм', year: 2012 },
            { name: 'Обитель зла: Последняя глава', type: 'Фильм', year: 2016 }
        ]
    },
    {
        name: 'Мортал Комбат', icon: '🗡️',
        films: [
            { name: 'Мортал Комбат', type: 'Фильм', year: 1995 },
            { name: 'Мортал Комбат 2: Истребление', type: 'Фильм', year: 1997 },
            { name: 'Мортал Комбат', type: 'Фильм', year: 2021 }
        ]
    },
    {
        name: 'Сериалы-легенды', icon: '📺',
        films: [
            { name: 'Игра престолов', type: 'Сериал', year: 2011 },
            { name: 'Во все тяжкие', type: 'Сериал', year: 2008 },
            { name: 'Друзья', type: 'Сериал', year: 1994 },
            { name: 'Шерлок', type: 'Сериал', year: 2010 },
            { name: 'Теория большого взрыва', type: 'Сериал', year: 2007 },
            { name: 'Офис', type: 'Сериал', year: 2005 },
            { name: 'Сверхъестественное', type: 'Сериал', year: 2005 },
            { name: 'Ходячие мертвецы', type: 'Сериал', year: 2010 },
            { name: 'Мир Дикого запада', type: 'Сериал', year: 2016 },
            { name: 'Секретные материалы', type: 'Сериал', year: 1993 },
            { name: 'Остаться в живых', type: 'Сериал', year: 2004 },
            { name: 'Настоящий детектив', type: 'Сериал', year: 2014 }
        ]
    },
    {
        name: 'Мадагаскар', icon: '🦁',
        films: [
            { name: 'Мадагаскар', type: 'Фильм', year: 2005 },
            { name: 'Мадагаскар 2', type: 'Фильм', year: 2008 },
            { name: 'Мадагаскар 3', type: 'Фильм', year: 2012 },
            { name: 'Пингвины Мадагаскара', type: 'Фильм', year: 2014 }
        ]
    },
    {
        name: 'Головоломка', icon: '🧠',
        films: [
            { name: 'Головоломка', type: 'Фильм', year: 2015 },
            { name: 'Головоломка 2', type: 'Фильм', year: 2024 }
        ]
    },
    {
        name: 'Суперсемейка', icon: '🦸',
        films: [
            { name: 'Суперсемейка', type: 'Фильм', year: 2004 },
            { name: 'Суперсемейка 2', type: 'Фильм', year: 2018 }
        ]
    },
    {
        name: 'Тачки', icon: '🏎️',
        films: [
            { name: 'Тачки', type: 'Фильм', year: 2006 },
            { name: 'Тачки 2', type: 'Фильм', year: 2011 },
            { name: 'Тачки 3', type: 'Фильм', year: 2017 }
        ]
    },
    {
        name: 'Шерлок Холмс', icon: '🕵️',
        films: [
            { name: 'Шерлок Холмс', type: 'Фильм', year: 2009 },
            { name: 'Шерлок Холмс: Игра теней', type: 'Фильм', year: 2011 }
        ]
    },
    {
        name: 'Один дома', icon: '🎄',
        films: [
            { name: 'Один дома', type: 'Фильм', year: 1990 },
            { name: 'Один дома 2: Потерянный в Нью-Йорке', type: 'Фильм', year: 1992 },
            { name: 'Один дома 3', type: 'Фильм', year: 1997 },
            { name: 'Один дома 4', type: 'Фильм', year: 2002 }
        ]
    },
    {
        name: 'Астрал', icon: '😱',
        films: [
            { name: 'Астрал', type: 'Фильм', year: 2011 },
            { name: 'Астрал: Глава 2', type: 'Фильм', year: 2013 },
            { name: 'Астрал: Глава 3', type: 'Фильм', year: 2015 },
            { name: 'Астрал: Последний ключ', type: 'Фильм', year: 2018 }
        ]
    },
    {
        name: 'Ральф', icon: '🕹️',
        films: [
            { name: 'Ральф', type: 'Фильм', year: 2012 },
            { name: 'Ральф против интернета', type: 'Фильм', year: 2018 }
        ]
    },
    {
        name: 'Моана', icon: '🌊',
        films: [
            { name: 'Моана', type: 'Фильм', year: 2016 },
            { name: 'Моана 2', type: 'Фильм', year: 2024 }
        ]
    }
];

// ========================
//  РАСШИРЕННЫЕ КОЛЛЕКЦИИ (добиваем до 1000 позиций)
// ========================
(function extendCollections() {
    const f = arr => arr.map(([n, y]) => ({ name: n, type: 'Фильм', year: y }));
    const s = arr => arr.map(([n, y]) => ({ name: n, type: 'Сериал', year: y }));
    const a = arr => arr.map(([n, y]) => ({ name: n, type: 'Аниме', year: y }));
    const coll = (name, icon, films) => ({ name, icon, films });
    const seasons = (name, icon, type, startYear, count) => coll(name, icon,
        Array.from({ length: count }, (_, i) => ({ name: `${name} ${i + 1} сезон`, type, year: startYear + i })));

    COLLECTIONS.push(
        coll('Дисней: Классика', '🏰', f([
            ['Белоснежка и семь гномов', 1937], ['Пиноккио', 1940], ['Фантазия', 1940],
            ['Дамбо', 1941], ['Бэмби', 1942], ['Салют, друзья!', 1943], ['Трое кабальеро', 1944],
            ['Золушка', 1950], ['Алиса в Стране чудес', 1951], ['Питер Пэн', 1953],
            ['Леди и Бродяга', 1955], ['Спящая красавица', 1959], ['101 далматинец', 1961],
            ['Меч в камне', 1963], ['Книга джунглей', 1967], ['Коты-аристократы', 1970],
            ['Робин Гуд', 1973], ['Множество приключений Винни-Пуха', 1977], ['Спасатели', 1977],
            ['Лис и пёс', 1981], ['Чёрный котёл', 1985], ['Великий мышиный сыщик', 1986],
            ['Оливер и Компания', 1988], ['Русалочка', 1989], ['Спасатели в Австралии', 1990],
            ['Красавица и Чудовище', 1991], ['Аладдин', 1992], ['Король Лев', 1994],
            ['Покахонтас', 1995], ['Горбун из Нотр-Дама', 1996], ['Геркулес', 1997],
            ['Мулан', 1998], ['Тарзан', 1999], ['Фантазия 2000', 1999], ['Динозавр', 2000],
            ['Похождения императора', 2000], ['Атлантида: Затерянный мир', 2001],
            ['Лило и Стич', 2002], ['Планета сокровищ', 2002], ['Братец медвежонок', 2003],
            ['Не бей копытом', 2004], ['Цыплёнок Цыпа', 2005], ['В гости к Робинсонам', 2007],
            ['Вольт', 2008], ['Принцесса и лягушка', 2009], ['Рапунцель: Запутанная история', 2010],
            ['Медвежонок Винни и его друзья', 2011], ['Город героев', 2014], ['Зверополис', 2016],
            ['Райя и последний дракон', 2021], ['Энканто', 2021], ['Странный мир', 2022],
            ['Заветное желание', 2023]
        ])),
        coll('Пиксар: Коллекция', '🧸', f([
            ['Приключения Флика', 1998], ['Корпорация монстров', 2001], ['В поисках Немо', 2003],
            ['ВАЛЛ-И', 2008], ['Вверх', 2009], ['Рататуй', 2007], ['Храбрая сердцем', 2012],
            ['Университет монстров', 2013], ['Хороший динозавр', 2015], ['В поисках Дори', 2016],
            ['Тайна Коко', 2017], ['Вперёд', 2020], ['Душа', 2020], ['Лука', 2021],
            ['Я краснею', 2022], ['Базз Лайтер', 2022], ['Элементарно', 2023]
        ])),
        coll('Дримворкс', '🐉', f([
            ['Спирит: Душа прерий', 2002], ['Синдбад: Легенда семи морей', 2003],
            ['Лесная братва', 2006], ['Би Муви: Медовый заговор', 2007], ['Хортон', 2008],
            ['Монстры против пришельцев', 2009], ['Мегамозг', 2010], ['Кот в сапогах', 2011],
            ['Дом', 2015], ['Босс-молокосос', 2017], ['Как Гринч украл Рождество', 2018],
            ['Тролли', 2016], ['Тролли: Мировой тур', 2020], ['Босс-молокосос 2: Семейный бизнес', 2021],
            ['Кот в сапогах: Последнее желание', 2022], ['Тролли: Группа в сборе', 2023]
        ])),
        coll('Студия Гибли', '✨', f([
            ['Навсикая из Долины ветров', 1984], ['Небесный замок Лапута', 1986],
            ['Мой сосед Тоторо', 1988], ['Ведьмина служба доставки', 1989], ['Принцесса Мононоке', 1997],
            ['Мои соседи Ямада', 1999], ['Унесённые призраками', 2001], ['Кот возвращается', 2002],
            ['Ходячий замок', 2004], ['Рыбка Поньо на утёсе', 2008], ['Ариэтти из страны лилипутов', 2010],
            ['Со склонов Кокурико', 2011], ['Ветер крепчает', 2013], ['Сказание о принцессе Кагуе', 2013],
            ['Когда была Марни', 2014], ['Шёпот сердца', 1995]
        ])),
        coll('Макото Синкай', '🌌', f([
            ['За облаками', 2003], ['Пять сантиметров в секунду', 2007], ['Сад изящных слов', 2013],
            ['Твоё имя', 2016], ['Дитя погоды', 2019], ['Сузуме', 2022]
        ])),
        coll('Дисней: Ремейки', '🏯', f([
            ['Золушка', 2015], ['Книга джунглей', 2016], ['Красавица и Чудовище', 2017],
            ['Дамбо', 2019], ['Аладдин', 2019], ['Король Лев', 2019], ['Малефисента', 2014],
            ['Малефисента: Владычица тьмы', 2019], ['Мулан', 2020], ['Пиноккио', 2022],
            ['Питер Пэн и Венди', 2023], ['Русалочка', 2023]
        ])),
        coll('Человек-паук: Вселенные', '🕸️', f([
            ['Человек-паук: Через вселенные', 2018], ['Человек-паук: Паутина вселенных', 2023]
        ])),
        coll('Фантастические твари', '✨', f([
            ['Фантастические твари и где они обитают', 2016],
            ['Фантастические твари: Преступления Грин-де-Вальда', 2018],
            ['Фантастические твари: Тайны Дамблдора', 2022]
        ])),
        coll('Пятница 13-е', '🏕️', f([
            ['Пятница 13-е', 1980], ['Пятница 13-е — Часть 2', 1981], ['Пятница 13-е — Часть 3 в 3D', 1982],
            ['Пятница 13-е — Часть 4: Последняя глава', 1984], ['Пятница 13-е — Часть 5: Новое начало', 1985],
            ['Пятница 13-е — Часть 6: Джейсон жив', 1986], ['Пятница 13-е — Часть 7: Новая кровь', 1988],
            ['Пятница 13-е — Часть 8: Джейсон штурмует Манхэттен', 1989],
            ['Джейсон отправляется в ад: Последняя пятница', 1993], ['Джейсон X', 2001],
            ['Фредди против Джейсона', 2003], ['Пятница 13-е', 2009]
        ])),
        coll('Кошмар на улице Вязов', '🖐️', f([
            ['Кошмар на улице Вязов', 1984], ['Кошмар на улице Вязов 2: Месть Фредди', 1985],
            ['Кошмар на улице Вязов 3: Воины сна', 1987], ['Кошмар на улице Вязов 4: Повелитель сна', 1988],
            ['Кошмар на улице Вязов 5: Дитя сна', 1989], ['Фредди мёртв: Последний кошмар', 1991],
            ['Новый кошмар Уэса Крэйвена', 1994], ['Кошмар на улице Вязов', 2010]
        ])),
        coll('Пила', '🧩', f([
            ['Пила: Игра на выживание', 2004], ['Пила 2', 2005], ['Пила 3', 2006], ['Пила 4', 2007],
            ['Пила 5', 2008], ['Пила 6', 2009], ['Пила 7', 2010], ['Пила 8', 2017],
            ['Пила: Спираль', 2021], ['Пила 10', 2023]
        ])),
        coll('Пункт назначения', '🛩️', f([
            ['Пункт назначения', 2000], ['Пункт назначения 2', 2003], ['Пункт назначения 3', 2006],
            ['Пункт назначения 4', 2009], ['Пункт назначения 5', 2011]
        ])),
        coll('Крик', '🔪', f([
            ['Крик', 1996], ['Крик 2', 1997], ['Крик 3', 2000], ['Крик 4', 2011],
            ['Крик 5', 2022], ['Крик 6', 2023]
        ])),
        coll('Хэллоуин', '🎃', f([
            ['Хэллоуин', 1978], ['Хэллоуин 2', 1981], ['Хэллоуин 3: Сезон ведьм', 1982],
            ['Хэллоуин 4: Возвращение Майкла Майерса', 1988], ['Хэллоуин 5: Месть Майкла Майерса', 1989],
            ['Хэллоуин 6: Проклятие Майкла Майерса', 1995], ['Хэллоуин: 20 лет спустя', 1998],
            ['Хэллоуин: Воскрешение', 2002], ['Хэллоуин', 2007], ['Хэллоуин 2', 2009],
            ['Хэллоуин', 2018], ['Хэллоуин убивает', 2021], ['Хэллоуин заканчивается', 2022]
        ])),
        coll('Кинг Конг', '🦍', f([
            ['Кинг Конг', 1933], ['Кинг Конг', 1976], ['Кинг Конг', 2005], ['Конг: Остров черепа', 2017]
        ])),
        coll('Джеймс Бонд: Классика', '🕴️', f([
            ['Доктор Ноу', 1962], ['Из России с любовью', 1963], ['Голдфингер', 1964],
            ['Шаровая молния', 1965], ['Живёшь только дважды', 1967],
            ['На секретной службе Её Величества', 1969], ['Бриллианты навсегда', 1971],
            ['Живи и дай умереть', 1973], ['Человек с золотым пистолетом', 1974],
            ['Шпион, который меня любил', 1977], ['Лунный гонщик', 1979], ['Только для твоих глаз', 1981],
            ['Осьминожка', 1983], ['Вид на убийство', 1985], ['Искры из глаз', 1987],
            ['Лицензия на убийство', 1989], ['Золотой глаз', 1995], ['Завтра не умрёт никогда', 1997],
            ['И целого мира мало', 1999], ['Умри, но не сейчас', 2002]
        ])),
        coll('Стартрек', '🚀', f([
            ['Звёздный путь: Фильм', 1979], ['Звёздный путь 2: Гнев Хана', 1982],
            ['Звёздный путь 3: В поисках Спока', 1984], ['Звёздный путь 4: Дорога домой', 1986],
            ['Звёздный путь 5: Последний рубеж', 1989], ['Звёздный путь 6: Неоткрытая страна', 1991],
            ['Звёздный путь: Поколения', 1994], ['Звёздный путь: Первый контакт', 1996],
            ['Звёздный путь: Восстание', 1998], ['Звёздный путь: Возмездие', 2002],
            ['Звёздный путь', 2009], ['Стартрек: Возмездие', 2013], ['Стартрек: Бесконечность', 2016]
        ])),
        coll('Полицейская академия', '👮', f([
            ['Полицейская академия', 1984], ['Полицейская академия 2: Их первое задание', 1985],
            ['Полицейская академия 3: Переподготовка', 1986], ['Полицейская академия 4: Гражданское патрулирование', 1987],
            ['Полицейская академия 5: Место назначения — Майами Бич', 1988],
            ['Полицейская академия 6: Город в осаде', 1989], ['Полицейская академия 7: Миссия в Москве', 1994]
        ])),
        coll('Назад в будущее', '⚡', f([
            ['Назад в будущее', 1985], ['Назад в будущее 2', 1989], ['Назад в будущее 3', 1990]
        ])),
        coll('Американский пирог', '🥧', f([
            ['Американский пирог', 1999], ['Американский пирог 2', 2001], ['Американский пирог: Свадьба', 2003],
            ['Американский пирог 4: Лагерь', 2005], ['Американский пирог 5: Голая миля', 2006],
            ['Американский пирог 6: Переезд', 2007], ['Американский пирог 7: Книга любви', 2009],
            ['Американский пирог: Девчонки рулят', 2020]
        ])),
        coll('Такси', '🚕', f([
            ['Такси', 1998], ['Такси 2', 2000], ['Такси 3', 2003], ['Такси 4', 2007], ['Такси 5', 2018]
        ])),
        coll('Перевозчик', '🚚', f([
            ['Перевозчик', 2002], ['Перевозчик 2', 2005], ['Перевозчик 3', 2008],
            ['Перевозчик: Наследие', 2015]
        ])),
        coll('Безумный Макс', '🔥', f([
            ['Безумный Макс', 1979], ['Безумный Макс 2: Воин дороги', 1981],
            ['Безумный Макс 3: Под куполом грома', 1985], ['Безумный Макс: Дорога ярости', 2015],
            ['Фуриоса: Хроники Безумного Макса', 2024]
        ])),
        coll('Дрожь земли', '🐛', f([
            ['Дрожь земли', 1990], ['Дрожь земли 2: Повторный удар', 1996], ['Дрожь земли 3', 2001],
            ['Дрожь земли 4: Легенда начинается', 2004], ['Дрожь земли 5: Кровное родство', 2015],
            ['Дрожь земли 6: Холодный день в аду', 2018]
        ])),
        coll('Робокоп', '🤖', f([
            ['Робокоп', 1987], ['Робокоп 2', 1990], ['Робокоп 3', 1993], ['Робокоп', 2014]
        ])),
        coll('От заката до рассвета', '🧛', f([
            ['От заката до рассвета', 1996], ['От заката до рассвета 2: Кровавые деньги из Техаса', 1999],
            ['От заката до рассвета 3: Дочь палача', 2000]
        ])),
        coll('Остин Пауэрс', '💂', f([
            ['Остин Пауэрс: Человек-загадка международного масштаба', 1997],
            ['Остин Пауэрс: Шпион, который меня соблазнил', 1999], ['Остин Пауэрс: Голдмембер', 2002]
        ])),
        coll('Три богатыря', '🐎', f([
            ['Алёша Попович и Тугарин Змей', 2004], ['Добрыня Никитич и Змей Горыныч', 2006],
            ['Илья Муромец и Соловей-Разбойник', 2007], ['Три богатыря и Шамаханская царица', 2010],
            ['Три богатыря на дальних берегах', 2012], ['Три богатыря. Ход конём', 2014],
            ['Три богатыря и морской царь', 2016], ['Три богатыря и принцесса Египта', 2017],
            ['Три богатыря и наследница престола', 2018], ['Три богатыря и Конь на троне', 2021],
            ['Три богатыря и Пуп Земли', 2023]
        ])),
        coll('Ёлки', '🎄', f([
            ['Ёлки', 2010], ['Ёлки 2', 2011], ['Ёлки 3', 2013], ['Ёлки 1914', 2014], ['Ёлки 5', 2016],
            ['Ёлки новые', 2017], ['Ёлки последние', 2018]
        ])),
        coll('Смешарики. Кино', '⭕', f([
            ['Смешарики. Начало', 2011], ['Смешарики. Легенда о золотом драконе', 2016],
            ['Смешарики снимают кино', 2023]
        ])),
        coll('Лего-фильмы', '🧱', f([
            ['Лего. Фильм', 2014], ['Лего Бэтмен: Фильм', 2017], ['Лего Ниндзяго: Фильм', 2017],
            ['Лего. Фильм 2', 2019]
        ])),
        coll('Черепашки-ниндзя', '🐢', f([
            ['Черепашки-ниндзя', 1990], ['Черепашки-ниндзя 2: Тайна изумрудного зелья', 1991],
            ['Черепашки-ниндзя 3', 1993], ['Черепашки-ниндзя', 2007], ['Черепашки-ниндзя', 2014],
            ['Черепашки-ниндзя 2: Из тени', 2016], ['Черепашки-ниндзя: Погром мутантов', 2023]
        ])),
        coll('Покемон: Фильмы', '⚡', f([
            ['Покемон: Фильм первый', 1998], ['Покемон: Сила Один', 1999],
            ['Покемон: Заклинатель идолов', 2000], ['Покемон: Навстречу судьбе', 2000]
        ])),
        coll('Скуби-Ду', '🐕', f([
            ['Скуби-Ду', 2002], ['Скуби-Ду 2: Монстры на свободе', 2004], ['Скуби-Ду! Начало', 2009]
        ])),
        seasons('Симпсоны', '🍩', 'Сериал', 1989, 22),
        seasons('Гриффины', '🐔', 'Сериал', 1999, 20),
        seasons('Южный Парк', '⛄', 'Сериал', 1997, 24),
        seasons('Губка Боб Квадратные Штаны', '🧽', 'Сериал', 1999, 13),
        seasons('Рик и Морти', '🛸', 'Сериал', 2013, 7),
        seasons('Время приключений', '⚔️', 'Сериал', 2010, 10),
        seasons('Гравити Фолз', '🌲', 'Сериал', 2012, 2),
        seasons('Удивительный мир Гамбола', '🐟', 'Сериал', 2011, 6),
        seasons('Свинка Пеппа', '🐷', 'Сериал', 2004, 8),
        seasons('Мой маленький пони', '🦄', 'Сериал', 2010, 9),
        seasons('Футурама', '🤖', 'Сериал', 1999, 7),
        seasons('Наруто', '🍥', 'Аниме', 2002, 5),
        seasons('Наруто: Ураганные хроники', '🌀', 'Аниме', 2007, 8),
        seasons('Атака титанов', '⚔️', 'Аниме', 2013, 4),
        seasons('Магическая битва', '🔮', 'Аниме', 2020, 2),
        seasons('Моя геройская академия', '💥', 'Аниме', 2016, 8),
        seasons('Блич', '⚔️', 'Аниме', 2004, 5),
        seasons('Ван-Пис', '🏴‍☠️', 'Аниме', 1999, 4),
        seasons('Стальной алхимик: Братство', '⚗️', 'Аниме', 2009, 2),
        seasons('Тетрадь смерти', '📓', 'Аниме', 2006, 2),
        seasons('Клинок, рассекающий демонов', '🌊', 'Аниме', 2019, 4),
        seasons('Сага о Винланде', '🛡️', 'Аниме', 2019, 2),
        seasons('Семья шпиона', '🕵️', 'Аниме', 2022, 2),
        seasons('Класс убийц', '🎯', 'Аниме', 2016, 2),
        seasons('Один Панч Мен', '👊', 'Аниме', 2015, 2),
        seasons('Хантер × Хантер', '✋', 'Аниме', 2011, 2),
        seasons('ДжоДжо: Невероятные приключения', '⭐', 'Аниме', 2012, 4),
        seasons('Моб Психо 100', '🧠', 'Аниме', 2016, 3),
        seasons('Токийские мстители', '🏍️', 'Аниме', 2021, 3),
        seasons('Реинкарнация безработного', '🐉', 'Аниме', 2021, 2),
        seasons('Семь смертных грехов', '🦁', 'Аниме', 2014, 4),
        seasons('Обещанный Неверленд', '🌾', 'Аниме', 2019, 2),
        coll('Аниме-фильмы', '🎞️', a([
            ['Акира', 1988], ['Призрак в доспехах', 1995], ['Паразит', 2014], ['Ковбой Бибоп', 1998],
            ['Евангелион', 1995], ['Твоё имя', 2016]
        ])),
        coll('Человек-бензопила', '🪚', a([
            ['Человек-бензопила', 2022]
        ])),
        seasons('Игра престолов', '🐉', 'Сериал', 2011, 8),
        seasons('Дом Дракона', '🐲', 'Сериал', 2022, 2),
        seasons('Во все тяжкие', '🧪', 'Сериал', 2008, 5),
        seasons('Лучше звоните Солу', '☎️', 'Сериал', 2015, 6),
        seasons('Друзья', '☕', 'Сериал', 1994, 10),
        seasons('Теория большого взрыва', '🔬', 'Сериал', 2007, 12),
        seasons('Офис', '📎', 'Сериал', 2005, 9),
        seasons('Анатомия страсти', '🩺', 'Сериал', 2005, 13),
        seasons('Секретные материалы', '🛸', 'Сериал', 1993, 11),
        seasons('Шерлок', '🕵️', 'Сериал', 2010, 4),
        seasons('Ходячие мертвецы', '🧟', 'Сериал', 2010, 11),
        seasons('Сверхъестественное', '🚗', 'Сериал', 2005, 15),
        seasons('Доктор Хаус', '💊', 'Сериал', 2004, 8),
        seasons('Острые козырьки', '🎩', 'Сериал', 2013, 6),
        seasons('Ведьмак', '🐺', 'Сериал', 2019, 3),
        seasons('Мандалорец', '🪖', 'Сериал', 2019, 3),
        seasons('Локи', '🗿', 'Сериал', 2021, 2),
        seasons('Что если...?', '🔀', 'Сериал', 2021, 2),
        seasons('Пацаны', '🍺', 'Сериал', 2019, 4),
        seasons('Тед Лассо', '⚽', 'Сериал', 2020, 3),
        seasons('Бриджертоны', '💃', 'Сериал', 2020, 3),
        seasons('Эйфория', '🌀', 'Сериал', 2019, 2),
        seasons('Очень странные дела', '🚲', 'Сериал', 2016, 4),
        seasons('Корона', '👑', 'Сериал', 2016, 5),
        seasons('Наследники', '🏢', 'Сериал', 2018, 4),
        coll('Звёздные войны: Сериалы', '🌠', s([
            ['Андо', 2022], ['Андо 2 сезон', 2025], ['Асока', 2023],
            ['Оби-Ван Кеноби', 2022], ['Книга Бобы Фетта', 2021], ['Скелетная команда', 2024],
            ['Звёздные войны: Видения', 2021], ['Звёздные войны: Восстание', 2018]
        ])),
        coll('MCU: Сериалы', '🛡️', s([
            ['Ванда/Вижн', 2021], ['Сокол и Зимний Солдат', 2021], ['Женщина-Халк', 2022],
            ['Лунный рыцарь', 2022], ['Мисс Марвел', 2022], ['Секретное вторжение', 2023],
            ['Эхо', 2024], ['Агата', 2024]
        ])),
        seasons('Маша и Медведь', '🐻', 'Сериал', 2009, 6),
        seasons('Фиксики', '🔧', 'Сериал', 2010, 4),
        seasons('Барбоскины', '🐶', 'Сериал', 2011, 4),
        seasons('Лунтик', '🌙', 'Сериал', 2006, 8)
    );
})();

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
    if (item.tmdbId === undefined) item.tmdbId = null;
    if (item.tmdbType === undefined) item.tmdbType = null;
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
    trackAchievementUnlocks();
}

function saveData(silent) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch (e) { /* ignore */ }
    if (silent) renderStats();
    else render();
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
    renderRecent();

    const oldestId = items.length
        ? items.slice().sort((a, b) => a.id - b.id)[0].id : null;

    if (!filtered.length) {
        cardsEl.innerHTML = '';
        emptyEl.style.display = 'block';
        return;
    }
    emptyEl.style.display = 'none';

    cardsEl.innerHTML = filtered.map(item => buildGridCard(item, oldestId)).join('');
    warmPosterCache();
}

function buildCardActions(item) {
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
    return `<div class="gcard-actions" data-actions>
        ${quickBtn}
        ${rewatchBtn}
        ${starBtn}
        <button class="act-edit" title="Редактировать"><i class="fas fa-pen"></i></button>
        <button class="act-delete" title="Удалить"><i class="fas fa-trash"></i></button>
    </div>`;
}

function buildCardBody(item) {
    const typeBadge = TYPE_BADGES[item.type] || '';
    const statusBadge = STATUS_BADGES[item.status] || '';
    const yearBadge = item.year ? `<span class="badge year">${item.year}</span>` : '';
    const tmdbText = item.tmdbRating ? `<span class="gtmdb">TMDB ⭐ ${item.tmdbRating}</span>` : '';
    const rewatch = item.rewatches > 0
        ? `<span class="grewatch"><i class="fas fa-rotate-right"></i> ×${item.rewatches}</span>` : '';
    const genreTags = item.genres && item.genres.length
        ? `<div class="genre-tags">${genreTagHtml(item.genres, 2)}</div>` : '';
    return `<div class="gcard-body">
        <div class="gtitle">${esc(item.name)}</div>
        <div class="gmeta">
            <span class="badge ${typeBadge}">${TYPE_ICONS[item.type] || ''} ${esc(item.type || '?')}</span>
            <span class="badge ${statusBadge}">${STATUS_ICONS[item.status] || ''} ${esc(item.status || '?')}</span>
            ${yearBadge}
        </div>
        ${progressHtml(item)}
        ${genreTags}${rewatch}${tmdbText}
    </div>`;
}

function buildGridCard(item, oldestId) {
    const cornerStar = item.important ? '<div class="corner-star"><i class="fas fa-star"></i></div>' : '';
    const cornerOld = item.id === oldestId
        ? '<div class="corner-old" title="Хранитель истории — самая старая запись"><i class="fas fa-landmark"></i></div>' : '';
    const dnd = sortMode === 'manual';
    return `
        <div class="gcard" data-id="${item.id}" data-action="open" ${dnd ? 'draggable="true"' : ''}>
            <div class="poster-wrap" style="--tint:${ratingMeta(item.rating).color}">
                ${posterHtml(item, 'grid')}
                ${cornerStar}${cornerOld}
                ${ratingRingHtml(item.rating)}
                ${buildCardActions(item)}
            </div>
            ${buildCardBody(item)}
        </div>`;
}

function updateCardInPlace(id) {
    const item = findItem(id);
    if (!item) return;
    const card = document.querySelector(`#cards .gcard[data-id="${id}"]`);
    if (!card) return;
    const actionsEl = card.querySelector('.gcard-actions');
    if (actionsEl) actionsEl.outerHTML = buildCardActions(item);
    const ringEl = card.querySelector('.rating-ring');
    if (ringEl) ringEl.outerHTML = ratingRingHtml(item.rating);
    const starEl = card.querySelector('.corner-star');
    if (starEl) starEl.outerHTML = item.important ? '<div class="corner-star"><i class="fas fa-star"></i></div>' : '';
    const bodyEl = card.querySelector('.gcard-body');
    if (bodyEl) bodyEl.outerHTML = buildCardBody(item);
    renderStats();
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

function addItem(name, type, status, rating, rewatches, poster, watchedEpisodes, totalEpisodes, watchedAt, important, silent, tmdbId, tmdbType) {
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
        important: !!important,
        tmdbId: tmdbId != null ? tmdbId : null,
        tmdbType: tmdbType || null
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
        saveData(true);
        updateCardInPlace(id);
        showToast(`🔄 «${item.name}» — ${item.rewatches} ${plural(item.rewatches, 'пересмотр', 'пересмотра', 'пересмотров')}`);
    });
}

function markWatched(id) {
    const item = findItem(id);
    if (!item) return;
    item.status = 'Просмотрено';
    if (!item.watchedAt) item.watchedAt = todayISO();
    saveData(true);
    updateCardInPlace(id);
    showToast(`✅ «${item.name}» — просмотрено!`);
}

function startWatching(id) {
    const item = findItem(id);
    if (!item) return;
    item.status = 'В процессе';
    saveData(true);
    updateCardInPlace(id);
    showToast(`⏳ Начал смотреть «${item.name}»`);
}

function pauseItem(id) {
    const item = findItem(id);
    if (!item) return;
    item.status = 'На паузе';
    saveData(true);
    updateCardInPlace(id);
    showToast(`⏸️ «${item.name}» — на паузе`);
}

function toggleImportant(id) {
    const item = findItem(id);
    if (!item) return;
    item.important = !item.important;
    saveData(true);
    updateCardInPlace(id);
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
    warmPosterCache();
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
                     data-result-rating="${rating}" data-result-poster="${esc(poster)}" data-result-year="${year}"
                     data-result-id="${item.id}" data-result-media="${item.media_type}">
                    ${poster ? posterTag(poster, title, 'search') :
                        '<div class="sr-fallback"><i class="fas fa-film"></i></div>'}
                    <div class="info">
                        <div class="title">${esc(title)}${exists ? '<span class="exists-flag"><i class="fas fa-circle-check"></i>уже есть</span>' : ''}</div>
                        <div class="meta">${esc(mediaType)} ${year ? '· ' + esc(year) : ''} ${rating ? '⭐ ' + rating : ''}</div>
                    </div>
                    <button class="add-btn" ${exists ? 'style="opacity:0.35;pointer-events:none;"' : ''}><i class="fas fa-plus"></i></button>
                </div>`;
        }).join('');
        warmPosterCache();

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
    const { resultName: name, resultType: type, resultRating: rating, resultPoster: poster, resultYear: year, resultId: tmdbId, resultMedia: mediaType } = row.dataset;
    const exists = items.some(i =>
        i.name.toLowerCase() === name.toLowerCase() && i.type === type);
    if (exists) {
        showToast('⚠️ Уже в списке!', true);
        return;
    }
    const added = addItem(name, type, 'Просмотрено', parseFloat(rating) || 0, 0, poster, 0, 0, '', false, false, parseInt(tmdbId) || null, mediaType);
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
    $('#detailRuntime').textContent = formatRuntime(item.runtime, item.type);
    $('#detailEpisodes').textContent = item.type !== 'Фильм'
        ? `📺 ${item.watchedEpisodes || 0}${item.totalEpisodes ? ' / ' + item.totalEpisodes : ''} серий` : '';
    $('#detailImportantBtn').innerHTML = item.important
        ? '<i class="fas fa-star"></i> В избранном'
        : '<i class="far fa-star"></i> В избранное';
    $('#detailModal').classList.add('show');
    warmPosterCache();

    fetchTMDBDetail(item).then(detail => {
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
            $('#detailRuntime').textContent = formatRuntime(detail.runtime, item.type);
        }
        if (detail.episodes && item.type !== 'Фильм') {
            $('#detailEpisodes').textContent = `📺 ${item.watchedEpisodes || 0} / ${detail.episodes} серий`;
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
        if ((item.tmdbId == null || item.tmdbId === 0) && detail.tmdbId) {
            item.tmdbId = detail.tmdbId;
            item.tmdbType = detail.tmdbType || (item.type === 'Фильм' ? 'movie' : 'tv');
            changed = true;
        }
        if (item.type !== 'Фильм' && !item.totalEpisodes && detail.episodes) {
            item.totalEpisodes = detail.episodes;
            changed = true;
        }
        if (changed) saveData(true);

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
        warmPosterCache();
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

function formatRuntime(min, type) {
    if (!min) return '';
    if (type === 'Фильм') return `⏱️ ${Math.floor(min / 60)} ч ${min % 60} мин`;
    return `⏱️ ~${Math.floor(min / 60)} ч ${min % 60} мин / серия`;
}

async function fetchTMDBDetail(item) {
    let tmdbId = item.tmdbId;
    let tmdbType = item.tmdbType;
    let first = null;

    if (tmdbId == null || tmdbId === 0) {
        const resp = await tmdbFetch(`/search/multi?query=${encodeURIComponent(item.name)}&language=ru-RU`);
        if (!resp.ok) throw new Error('TMDB error');
        const data = await resp.json();
        if (!data.results || !data.results.length) return {};
        const wantMovie = item.type === 'Фильм';
        const exact = data.results.filter(r => (r.title || r.name || '').toLowerCase() === item.name.toLowerCase());
        first = exact.find(r => (r.media_type === 'movie') === wantMovie)
            || exact[0]
            || data.results.find(r => (r.media_type === 'movie') === wantMovie)
            || data.results[0];
        tmdbId = first.id;
        tmdbType = first.media_type === 'movie' ? 'movie' : 'tv';
    }

    try {
        const dResp = await tmdbFetch(`/${tmdbType}/${tmdbId}?language=ru-RU&append_to_response=similar`);
        if (dResp.ok) {
            const d = await dResp.json();
            return {
                overview: d.overview || '',
                year: (d.release_date || d.first_air_date || '').slice(0, 4),
                rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
                genres: (d.genres || []).map(g => ({ name: g.name })).filter(g => g.name),
                runtime: tmdbType === 'movie'
                    ? (d.runtime || null)
                    : ((d.episode_run_time && d.episode_run_time[0]) || null),
                episodes: tmdbType === 'movie' ? null : (d.number_of_episodes || null),
                similar: (d.similar && d.similar.results) || [],
                tmdbId,
                tmdbType
            };
        }
    } catch (e) { /* ignore */ }

    if (!first) return {};

    const detail = {
        overview: first.overview || '',
        year: (first.release_date || first.first_air_date || '').slice(0, 4),
        rating: first.vote_average ? Math.round(first.vote_average * 10) / 10 : null,
        genres: [],
        runtime: first.runtime || null,
        episodes: null,
        similar: [],
        tmdbId,
        tmdbType
    };
    if (first.genre_ids && first.genre_ids.length) {
        try {
            const genreMap = await fetchGenreMap();
            detail.genres = first.genre_ids.map(id => ({ name: genreMap[id] })).filter(g => g.name);
        } catch (e) { /* ignore */ }
    }
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
            if (addItem(title, type, 'Буду смотреть', rating, 0, poster, 0, 0, '', false, false, first.id, first.media_type === 'movie' ? 'movie' : 'tv')) {
                const newItem = items[items.length - 1];
                const y = parseInt((first.release_date || first.first_air_date || '').slice(0, 4), 10);
                if (!isNaN(y)) newItem.year = y;
                if (first.runtime) newItem.runtime = first.runtime;
                if (first.media_type === 'tv' && first.number_of_episodes) newItem.totalEpisodes = first.number_of_episodes;
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
    saveData(true);
    updateCardInPlace(rateId);
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
    else if (act === 'collections') renderCollections();
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
    viewMode = 'grid';
    try {
        localStorage.setItem(VIEW_KEY, 'grid');
    } catch (e) { /* ignore */ }
    $('#viewGrid').classList.add('active');
    render();
}

$('#viewGrid').addEventListener('click', () => setView('grid'));

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
    else if ($('#collectionsModal').classList.contains('show')) closeCollections();
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
    collectionsModal: closeCollections,
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
        streak: 0,
        episodes: 0,
        serialsWatched: 0
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
        if (i.runtime) {
            let minutes = i.runtime;
            if (i.type !== 'Фильм') {
                const eps = i.status === 'Просмотрено'
                    ? (i.totalEpisodes || i.watchedEpisodes || 1)
                    : (i.watchedEpisodes || 1);
                minutes = i.runtime * eps;
            }
            if (i.status === 'Просмотрено') res.hours += minutes * (1 + (i.rewatches || 0));
            else if (i.status === 'В процессе') res.hours += minutes;
        }
        if (i.runtime) res.hoursKnown++;
        if (i.type !== 'Фильм') {
            const eps = i.status === 'Просмотрено'
                ? (i.totalEpisodes || i.watchedEpisodes || 0)
                : (i.watchedEpisodes || 0);
            res.episodes += eps;
            if (i.status === 'Просмотрено') res.serialsWatched++;
        }
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
    const hoursNote = !a.hoursKnown && items.length
        ? '<div class="an-none">Хронометраж подтянется автоматически из TMDB</div>' : '';

    const statsHtml = `
        <div class="an-stats">
            <div class="an-stat-card"><div class="v">${a.hours} ч</div><div class="k">часов просмотрено</div></div>
            <div class="an-stat-card"><div class="v">${a.episodes}</div><div class="k">серий/эпизодов</div></div>
            <div class="an-stat-card"><div class="v">${a.serialsWatched}</div><div class="k">завершено сериалов</div></div>
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
const LEVELS = [
    [1, 'Новичок'],
    [2, 'Начинающий'],
    [3, 'Любопытный'],
    [4, 'Исследователь'],
    [5, 'Зритель'],
    [7, 'Постоянный зритель'],
    [8, 'Завсегдатай'],
    [10, 'Киностарт'],
    [12, 'Кинофан'],
    [15, 'Кинофил'],
    [18, 'Ценитель кино'],
    [20, 'Киноман'],
    [25, 'Синемафан'],
    [30, 'Синематографист'],
    [40, 'Кинокритик'],
    [50, 'Знаток'],
    [60, 'Архивариус'],
    [75, 'Профи'],
    [90, 'Мастер коллекций'],
    [100, 'Эксперт'],
    [120, 'Ветеран кино'],
    [150, 'Мастер'],
    [180, 'Хранитель плёнок'],
    [200, 'Легенда кино'],
    [250, 'Кинокомандор'],
    [300, 'Гуру'],
    [400, 'Кинопионер'],
    [500, 'Икона'],
    [600, 'Кинопророк'],
    [750, 'Миф'],
    [900, 'Киноимператор'],
    [1000, 'Живая легенда'],
    [1200, 'Титан кино'],
    [1500, 'Неутомимый'],
    [2000, 'Коллекционер'],
    [2500, 'Хранитель архивов'],
    [3000, 'Бог кино'],
    [4000, 'Легенда вселенной'],
    [5000, 'Бессмертный'],
    [7500, 'Кинобожество'],
    [10000, 'Творец вселенной']
];

function getLevel(n) {
    let name = LEVELS[0][1];
    let next = null;
    for (let i = 0; i < LEVELS.length; i++) {
        if (n >= LEVELS[i][0]) {
            name = LEVELS[i][1];
            next = i + 1 < LEVELS.length ? LEVELS[i + 1][0] : null;
        }
    }
    return { name, next };
}

function checkAchievements() {
    const total = items.length;
    const watched = items.filter(i => i.status === 'Просмотрено').length;
    const films = items.filter(i => i.type === 'Фильм').length;
    const rewatches = items.reduce((s, i) => s + (i.rewatches || 0), 0);
    const rated9 = items.filter(i => i.rating >= 9).length;
    const rated10 = items.filter(i => i.rating === 10).length;
    const ratedCount = items.filter(i => i.rating > 0).length;
    const genres = new Set(items.flatMap(i => i.genres || []));
    const anime = items.filter(i => i.type === 'Аниме').length;
    const serials = items.filter(i => i.type === 'Сериал').length;
    const important = items.filter(i => i.important).length;
    const tmdbHigh = items.filter(i => i.tmdbRating && i.tmdbRating >= 8.5).length;
    const decades = new Set(items.filter(i => i.year).map(i => Math.floor(i.year / 10) * 10)).size;
    const a = computeAnalytics();
    const ratedSum = items.reduce((s, i) => s + (i.rating > 0 ? i.rating : 0), 0);
    const avgRating = ratedCount ? Math.round(ratedSum / ratedCount * 10) / 10 : 0;
    const longFilms = items.filter(i => i.runtime && i.runtime >= 180).length;
    const lowTmdb = items.filter(i => i.tmdbRating && i.tmdbRating > 0 && i.tmdbRating < 5.5).length;
    const watched7d = items.filter(i => i.watchedAt && !isNaN(Date.parse(i.watchedAt)) &&
        (Date.now() - Date.parse(i.watchedAt)) < 7 * 86400000).length;
    const isCollDone = name => {
        const c = COLLECTIONS.find(x => x.name === name);
        return !!c && c.films.length > 0 && c.films.every(f => {
            const it = findCollectionItem(f);
            return it && it.status === 'Просмотрено';
        });
    };
    const collectionsDone = COLLECTIONS.filter(c => c.films.length > 0 && c.films.every(f => {
        const it = findCollectionItem(f);
        return it && it.status === 'Просмотрено';
    })).length;

    let night = 0, morning = 0, maxDay = 0;
    const dayCounts = {};
    items.forEach(i => {
        const d = new Date(i.id);
        if (isNaN(d)) return;
        const h = d.getHours();
        if (h >= 22 || h < 5) night++;
        if (h >= 5 && h < 9) morning++;
        const dk = d.toDateString();
        dayCounts[dk] = (dayCounts[dk] || 0) + 1;
    });
    maxDay = Math.max(...Object.values(dayCounts), 0);

    const oldest = items.length
        ? items.slice().sort((x, y) => x.id - y.id)[0] : null;

    const list = [
        { icon: '🎬', name: 'Первые шаги', desc: 'добавь первую запись', cur: Math.min(total, 1), need: 1, done: total >= 1, special: true },
        { icon: '🚀', name: 'Киностарт', desc: '5 записей в коллекции', cur: Math.min(total, 5), need: 5, done: total >= 5, special: true },
        { icon: '📚', name: 'Двадцатка', desc: '20 записей в коллекции', cur: Math.min(total, 20), need: 20, done: total >= 20, special: true },
        { icon: '📀', name: 'Полтинник', desc: '50 записей в коллекции', cur: Math.min(total, 50), need: 50, done: total >= 50, special: true },
        { icon: '💎', name: 'Сотня', desc: '100 записей в коллекции', cur: Math.min(total, 100), need: 100, done: total >= 100, special: true },
        { icon: '👑', name: 'Король архива', desc: '200 записей в коллекции', cur: Math.min(total, 200), need: 200, done: total >= 200, special: true },
        { icon: '📺', name: 'Сериаломан', desc: '10 сериалов в коллекции', cur: Math.min(serials, 10), need: 10, done: serials >= 10, special: true },
        { icon: '📡', name: 'Серийный маньяк', desc: '25 сериалов в коллекции', cur: Math.min(serials, 25), need: 25, done: serials >= 25, special: true },
        { icon: '🎌', name: 'Аниме-фанат', desc: '10 аниме в коллекции', cur: Math.min(anime, 10), need: 10, done: anime >= 10, special: true },
        { icon: '🌸', name: 'Сенпай', desc: '25 аниме в коллекции', cur: Math.min(anime, 25), need: 25, done: anime >= 25, special: true },
        { icon: '🍿', name: 'Киномарафон', desc: '50 просмотренных', cur: Math.min(watched, 50), need: 50, done: watched >= 50, special: true },
        { icon: '🎪', name: 'Мега-марафон', desc: '250 просмотренных', cur: Math.min(watched, 250), need: 250, done: watched >= 250, special: true },
        { icon: '🎟️', name: 'Киноман дня', desc: '8 добавлений за один день', cur: Math.min(maxDay, 8), need: 8, done: maxDay >= 8, special: true },
        { icon: '🔄', name: 'Мастер пересмотров', desc: '10 пересмотров', cur: Math.min(rewatches, 10), need: 10, done: rewatches >= 10, special: true },
        { icon: '🔁', name: 'Вечный повтор', desc: '50 пересмотров', cur: Math.min(rewatches, 50), need: 50, done: rewatches >= 50, special: true },
        { icon: '⭐', name: 'Строгий критик', desc: '10 оценок 9–10', cur: Math.min(rated9, 10), need: 10, done: rated9 >= 10, special: true },
        { icon: '💯', name: 'Идеальный вкус', desc: '5 оценок 10/10', cur: Math.min(rated10, 5), need: 5, done: rated10 >= 5, special: true },
        { icon: '✍️', name: 'Оценщик', desc: 'оценено 50 записей', cur: Math.min(ratedCount, 50), need: 50, done: ratedCount >= 50, special: true },
        { icon: '🎭', name: 'Разносторонний', desc: '5 разных жанров', cur: Math.min(genres.size, 5), need: 5, done: genres.size >= 5, special: true },
        { icon: '🌈', name: 'Всеядный', desc: '15 разных жанров', cur: Math.min(genres.size, 15), need: 15, done: genres.size >= 15, special: true },
        { icon: '🔥', name: 'Серия недели', desc: '7 дней подряд с добавлениями', cur: Math.min(a.streak, 7), need: 7, done: a.streak >= 7, special: true },
        { icon: '⚡', name: 'Месяц марафона', desc: '30 дней подряд', cur: Math.min(a.streak, 30), need: 30, done: a.streak >= 30, special: true },
        { icon: '🌙', name: 'Ночной кинозритель', desc: '10 добавлений после 22:00', cur: Math.min(night, 10), need: 10, done: night >= 10, special: true },
        { icon: '☀️', name: 'Ранняя пташка', desc: '10 добавлений до 9:00', cur: Math.min(morning, 10), need: 10, done: morning >= 10, special: true },
        { icon: '🏛️', name: 'Хранитель истории', desc: 'самая старая запись в коллекции', cur: oldest ? 1 : 0, need: 1, done: !!oldest, special: true },
        { icon: '🗺️', name: 'Первопроходец', desc: oldest ? `первая запись — «${oldest.name}»` : 'добавь первую запись', cur: oldest ? 1 : 0, need: 1, done: !!oldest, special: true },
        { icon: '⏱️', name: 'Кинотеоретик', desc: '100 часов просмотра', cur: Math.min(a.hours, 100), need: 100, done: a.hours >= 100, special: true },
        { icon: '⏳', name: 'Одержимый зритель', desc: '500 часов просмотра', cur: Math.min(a.hours, 500), need: 500, done: a.hours >= 500, special: true },
        { icon: '🎞️', name: 'Эпизодист', desc: '100 серий/эпизодов просмотрено', cur: Math.min(a.episodes, 100), need: 100, done: a.episodes >= 100, special: true },
        { icon: '🎬', name: 'Завершитель', desc: '10 сериалов просмотрено целиком', cur: Math.min(a.serialsWatched, 10), need: 10, done: a.serialsWatched >= 10, special: true },
        { icon: '📅', name: 'Коллекция десятилетий', desc: 'фильмы из 5 десятилетий', cur: Math.min(decades, 5), need: 5, done: decades >= 5, special: true },
        { icon: '🎖️', name: 'Оскароносец', desc: '5 записей с рейтингом TMDB 8.5+', cur: Math.min(tmdbHigh, 5), need: 5, done: tmdbHigh >= 5, special: true },
        { icon: '❤️', name: 'Любимое', desc: '10 важных записей', cur: Math.min(important, 10), need: 10, done: important >= 10, special: true },
        { icon: '🏆', name: 'Легенда', desc: '100 фильмов в коллекции', cur: Math.min(films, 100), need: 100, done: films >= 100, special: true },
        { icon: '🗃️', name: 'Кинобиблиотека', desc: '250 записей в коллекции', cur: Math.min(total, 250), need: 250, done: total >= 250, special: true },
        { icon: '🏰', name: 'Кинодворец', desc: '500 записей в коллекции', cur: Math.min(total, 500), need: 500, done: total >= 500, special: true },
        { icon: '🌌', name: 'Киновселенная', desc: '1000 записей в коллекции', cur: Math.min(total, 1000), need: 1000, done: total >= 1000, special: true },
        { icon: '🎞️', name: 'Фильмофил', desc: '150 фильмов в коллекции', cur: Math.min(films, 150), need: 150, done: films >= 150, special: true },
        { icon: '📼', name: 'Магнат кино', desc: '300 фильмов в коллекции', cur: Math.min(films, 300), need: 300, done: films >= 300, special: true },
        { icon: '📺', name: 'Сериалополия', desc: '50 сериалов в коллекции', cur: Math.min(serials, 50), need: 50, done: serials >= 50, special: true },
        { icon: '🎌', name: 'Отаку', desc: '50 аниме в коллекции', cur: Math.min(anime, 50), need: 50, done: anime >= 50, special: true },
        { icon: '🍜', name: 'Хранитель аниме', desc: '100 аниме в коллекции', cur: Math.min(anime, 100), need: 100, done: anime >= 100, special: true },
        { icon: '🎟️', name: 'Абонемент на всё', desc: '25 добавлений за один день', cur: Math.min(maxDay, 25), need: 25, done: maxDay >= 25, special: true },
        { icon: '🎡', name: 'Рекорд дня', desc: '50 добавлений за один день', cur: Math.min(maxDay, 50), need: 50, done: maxDay >= 50, special: true },
        { icon: '🔁', name: 'Повторная классика', desc: '25 пересмотров', cur: Math.min(rewatches, 25), need: 25, done: rewatches >= 25, special: true },
        { icon: '♻️', name: 'Вечный цикл', desc: '100 пересмотров', cur: Math.min(rewatches, 100), need: 100, done: rewatches >= 100, special: true },
        { icon: '⭐', name: 'Взыскательный', desc: '25 оценок 9–10', cur: Math.min(rated9, 25), need: 25, done: rated9 >= 25, special: true },
        { icon: '💯', name: 'Перфекционист', desc: '20 оценок 10/10', cur: Math.min(rated10, 20), need: 20, done: rated10 >= 20, special: true },
        { icon: '✍️', name: 'Главный критик', desc: '100 оценок', cur: Math.min(ratedCount, 100), need: 100, done: ratedCount >= 100, special: true },
        { icon: '📊', name: 'Дотошный', desc: 'оценка у 95%+ записей', cur: total ? Math.round(ratedCount / total * 100) : 0, need: 95, done: total > 0 && ratedCount / total >= 0.95, special: true },
        { icon: '🎯', name: 'Эстет', desc: 'средняя оценка 9+', cur: avgRating, need: 9, done: ratedCount >= 10 && avgRating >= 9, special: true },
        { icon: '🏛️', name: 'Архив эпох', desc: 'фильмы из 8 десятилетий', cur: Math.min(decades, 8), need: 8, done: decades >= 8, special: true },
        { icon: '📜', name: 'Хранитель веков', desc: 'фильмы из 12 десятилетий', cur: Math.min(decades, 12), need: 12, done: decades >= 12, special: true },
        { icon: '🎨', name: 'Мастер жанров', desc: '25 разных жанров', cur: Math.min(genres.size, 25), need: 25, done: genres.size >= 25, special: true },
        { icon: '⏱️', name: 'Кинобесконечность', desc: '1000 часов просмотра', cur: Math.min(a.hours, 1000), need: 1000, done: a.hours >= 1000, special: true },
        { icon: '⏳', name: 'Властелин времени', desc: '1500 часов просмотра', cur: Math.min(a.hours, 1500), need: 1500, done: a.hours >= 1500, special: true },
        { icon: '📺', name: 'Серийный гигант', desc: '500 серий/эпизодов просмотрено', cur: Math.min(a.episodes, 500), need: 500, done: a.episodes >= 500, special: true },
        { icon: '🔢', name: 'Эпизодный рекорд', desc: '1000 серий/эпизодов просмотрено', cur: Math.min(a.episodes, 1000), need: 1000, done: a.episodes >= 1000, special: true },
        { icon: '🔥', name: 'Железная дисциплина', desc: '60 дней подряд', cur: Math.min(a.streak, 60), need: 60, done: a.streak >= 60, special: true },
        { icon: '🏆', name: 'Год кино', desc: '365 дней подряд', cur: Math.min(a.streak, 365), need: 365, done: a.streak >= 365, special: true },
        { icon: '🌙', name: 'Сова-киноман', desc: '50 добавлений после 22:00', cur: Math.min(night, 50), need: 50, done: night >= 50, special: true },
        { icon: '☀️', name: 'Утренний сеанс', desc: '50 добавлений до 9:00', cur: Math.min(morning, 50), need: 50, done: morning >= 50, special: true },
        { icon: '🎖️', name: 'Лауреат', desc: '25 записей с рейтингом TMDB 8.5+', cur: Math.min(tmdbHigh, 25), need: 25, done: tmdbHigh >= 25, special: true },
        { icon: '🏅', name: 'Оскар за всё', desc: '50 записей с рейтингом TMDB 8.5+', cur: Math.min(tmdbHigh, 50), need: 50, done: tmdbHigh >= 50, special: true },
        { icon: '🎬', name: 'Долгий сеанс', desc: '10 фильмов длиннее 3 часов', cur: Math.min(longFilms, 10), need: 10, done: longFilms >= 10, special: true },
        { icon: '🤡', name: 'Культовый мусор', desc: '5 записей с рейтингом TMDB ниже 5.5', cur: Math.min(lowTmdb, 5), need: 5, done: lowTmdb >= 5, special: true },
        { icon: '🍿', name: 'Запойный марафонец', desc: '5 просмотров за последнюю неделю', cur: Math.min(watched7d, 5), need: 5, done: watched7d >= 5, special: true },
        { icon: '📚', name: 'Собиратель', desc: '1 полностью собранная коллекция', cur: Math.min(collectionsDone, 1), need: 1, done: collectionsDone >= 1, special: true },
        { icon: '🖼️', name: 'Галерист', desc: '3 полностью собранные коллекции', cur: Math.min(collectionsDone, 3), need: 3, done: collectionsDone >= 3, special: true },
        { icon: '🏛️', name: 'Куратор', desc: '5 полностью собранных коллекций', cur: Math.min(collectionsDone, 5), need: 5, done: collectionsDone >= 5, special: true },
        { icon: '🏺', name: 'Директор музея', desc: '8 полностью собранных коллекций', cur: Math.min(collectionsDone, 8), need: 8, done: collectionsDone >= 8, special: true },
        { icon: '🗿', name: 'Эрмитаж', desc: '12 полностью собранных коллекций', cur: Math.min(collectionsDone, 12), need: 12, done: collectionsDone >= 12, special: true },
        { icon: '🪄', name: 'Выпускник Хогвартса', desc: 'вся коллекция «Гарри Поттер» просмотрена', cur: isCollDone('Гарри Поттер') ? 1 : 0, need: 1, done: isCollDone('Гарри Поттер'), special: true },
        { icon: '💍', name: 'Хранитель Кольца', desc: 'вся коллекция «Властелин колец» просмотрена', cur: isCollDone('Властелин колец') ? 1 : 0, need: 1, done: isCollDone('Властелин колец'), special: true },
        { icon: '🕷️', name: 'Мститель', desc: 'вся коллекция «Марвел (MCU)» просмотрена', cur: isCollDone('Марвел (MCU)') ? 1 : 0, need: 1, done: isCollDone('Марвел (MCU)'), special: true },
        { icon: '🏎️', name: 'Семья Торрето', desc: 'вся коллекция «Форсаж» просмотрена', cur: isCollDone('Форсаж') ? 1 : 0, need: 1, done: isCollDone('Форсаж'), special: true },
        { icon: '❤️', name: 'Фанатик', desc: '25 важных записей', cur: Math.min(important, 25), need: 25, done: important >= 25, special: true },
        { icon: '💗', name: 'Кумир', desc: '50 важных записей', cur: Math.min(important, 50), need: 50, done: important >= 50, special: true }
    ];
    // ============ МАССОВЫЕ ДОСТИЖЕНИЯ (всего ровно 1000) ============
    // Генерируем прогрессионные достижения по каждой метрике и добиваем
    // список до ровно 1000 позиций.
    const seq = (from, to, step) => {
        const r = [];
        for (let n = from; n <= to; n += step) r.push(n);
        return r;
    };
    const gen = [];
    const stepsGen = (icon, cur, makeName, makeDesc, nums) => {
        nums.forEach(n => gen.push({
            icon, name: makeName(n), desc: makeDesc(n),
            cur: Math.min(cur, n), need: n, done: cur >= n
        }));
    };

    const lim = 1000 - list.length;

    stepsGen('🎬', total,
        n => `${n} ${plural(n, 'запись', 'записи', 'записей')} в коллекции`,
        n => `собери ${n} ${plural(n, 'запись', 'записи', 'записей')}`,
        seq(1, 250, 1));
    stepsGen('📀', films,
        n => `${n} фильмов в коллекции`,
        n => `собери ${n} фильмов`,
        seq(20, 1000, 20));
    stepsGen('📺', serials,
        n => `${n} сериалов в коллекции`,
        n => `собери ${n} сериалов`,
        seq(5, 500, 5));
    stepsGen('🎌', anime,
        n => `${n} аниме в коллекции`,
        n => `собери ${n} аниме`,
        seq(5, 500, 5));
    stepsGen('🥇', rated9,
        n => `${n} оценок 9–10`,
        n => `поставь ${n} оценок 9–10`,
        seq(1, 100, 1));
    stepsGen('🔄', rewatches,
        n => `${n} пересмотров`,
        n => `набери ${n} пересмотров`,
        seq(1, 100, 1));
    stepsGen('✍️', ratedCount,
        n => `${n} оценок`,
        n => `оцени ${n} записей`,
        seq(10, 1000, 10));
    stepsGen('✅', watched,
        n => `${n} просмотренных`,
        n => `просмотри ${n} записей`,
        seq(10, 1000, 10));
    stepsGen('⏱️', a.hours,
        n => `${n} часов просмотра`,
        n => `набери ${n} часов просмотра`,
        seq(10, 1000, 10));
    stepsGen('🎞️', a.episodes,
        n => `${n} серий просмотрено`,
        n => `просмотри ${n} серий`,
        seq(10, 1000, 10));
    stepsGen('🔥', a.streak,
        n => `${n} дней подряд`,
        n => `держи серию ${n} дней подряд`,
        seq(1, 100, 1));
    stepsGen('📅', maxDay,
        n => `${n} добавлений за один день`,
        n => `добавь ${n} записей за один день`,
        seq(1, 100, 1));
    stepsGen('🌙', night,
        n => `${n} ночных добавлений`,
        n => `добавь ${n} записей после 22:00`,
        seq(1, 100, 1));
    stepsGen('☀️', morning,
        n => `${n} утренних добавлений`,
        n => `добавь ${n} записей до 9:00`,
        seq(1, 100, 1));
    stepsGen('🎨', genres.size,
        n => `${n} разных жанров`,
        n => `собери ${n} разных жанров`,
        seq(1, 40, 1));
    stepsGen('🏁', a.serialsWatched,
        n => `${n} завершённых сериалов`,
        n => `досмотри ${n} сериалов целиком`,
        seq(1, 50, 1));
    stepsGen('❤️', important,
        n => `${n} важных записей`,
        n => `отметь ${n} записей как важные`,
        seq(1, 50, 1));
    stepsGen('🎖️', tmdbHigh,
        n => `${n} записей с рейтингом TMDB 8.5+`,
        n => `собери ${n} записей с рейтингом TMDB 8.5+`,
        seq(1, 40, 1));
    stepsGen('🗓️', decades,
        n => `${n} десятилетий в коллекции`,
        n => `собери фильмы из ${n} десятилетий`,
        seq(1, 10, 1));

    list.push(...gen.slice(0, lim));
    return { level: getLevel(total), list };
}

function renderAchievements() {
    const { level, list } = checkAchievements();
    const doneCount = list.filter(a => a.done).length;
    $('#achLevelName').textContent = level.name;
    const nextText = level.next ? ` · до уровня: ${Math.max(0, level.next - items.length)}` : '';
    $('#achLevelSub').textContent = `Уровень «${level.name}» · ${items.length} записей · выполнено ${doneCount} из ${list.length}${nextText}`;
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

function trackAchievementUnlocks() {
    try {
        const { list } = checkAchievements();
        const done = list.filter(x => x.done).map(x => x.name);
        const saved = loadJSON('kinoAchUnlocked', []);
        const fresh = done.filter(n => !saved.includes(n));
        if (fresh.length) {
            localStorage.setItem('kinoAchUnlocked', JSON.stringify(done));
            setTimeout(() => showToast('🏆 Новое достижение: ' + fresh.slice(0, 2).join(', ') + (fresh.length > 2 ? ' и др.' : '')), 4500);
        }
    } catch (e) { /* ignore */ }
}

function closeAchievements() {
    $('#achievementsModal').classList.remove('show');
}

// ========================
//  КОЛЛЕКЦИИ ФИЛЬМОВ
// ========================
const COLL_POSTERS_KEY = 'kinoCollectionPosters';
const collPosterCache = loadJSON(COLL_POSTERS_KEY, {});
let collPrefetchBusy = false;

function normName(s) {
    return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function findCollectionItem(film) {
    const nm = normName(film.name);
    return items.find(i => normName(i.name) === nm);
}

function collectionsBodyHtml() {
    let fIdx = 0;
    return COLLECTIONS.map(c => {
        const done = c.films.filter(f => {
            const item = findCollectionItem(f);
            return item && item.status === 'Просмотрено';
        }).length;
        const itemsHtml = c.films.map(f => {
            const idx = fIdx++;
            const item = findCollectionItem(f);
            const poster = item && item.poster ? item.poster : collPosterCache[f.name + '|' + f.type];
            let cls = 'coll-chip';
            let badge = '';
            if (item && item.status === 'Просмотрено') {
                cls += ' watched';
                badge = '<div class="coll-check"><i class="fas fa-check"></i></div>';
            } else if (item) {
                cls += ' partial';
                badge = `<div class="coll-state">${STATUS_ICONS[item.status] || '⏳'}</div>`;
            } else {
                cls += ' new';
                badge = '<div class="coll-add-hint"><i class="fas fa-plus"></i></div>';
            }
            const img = poster
                ? `<img src="${esc(poster)}" alt="${esc(f.name)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">`
                : '<div class="coll-ph"><i class="fas fa-film"></i></div>';
            return `
                <div class="${cls}" data-coll-name="${esc(f.name)}" data-coll-type="${f.type}" data-fidx="${idx}" title="${esc(f.name)} (${f.year})">
                    ${img}${badge}
                    <div class="coll-name">${esc(f.name)}</div>
                </div>`;
        }).join('');
        return `
            <div class="coll-block">
                <div class="coll-head"><span class="coll-icon">${c.icon}</span> ${esc(c.name)} <span class="coll-count">${done}/${c.films.length}</span></div>
                <div class="coll-row">${itemsHtml}</div>
            </div>`;
    }).join('');
}

function renderCollections() {
    $('#collectionsBody').innerHTML = collectionsBodyHtml();
    $('#collectionsModal').classList.add('show');
    warmPosterCache();
    prefetchCollPosters();
}

function closeCollections() {
    $('#collectionsModal').classList.remove('show');
}

async function ensureCollPoster(film) {
    const key = film.name + '|' + film.type;
    if (collPosterCache[key]) return collPosterCache[key];
    try {
        const resp = await tmdbFetch(`/search/multi?query=${encodeURIComponent(film.name)}&language=ru-RU`);
        if (!resp.ok) return '';
        const data = await resp.json();
        const found = (data.results || []).find(r =>
            (r.title || r.name || '').toLowerCase() === film.name.toLowerCase()) || (data.results || [])[0];
        const p = found && found.poster_path ? `https://image.tmdb.org/t/p/w185${found.poster_path}` : '';
        collPosterCache[key] = p;
        try { localStorage.setItem(COLL_POSTERS_KEY, JSON.stringify(collPosterCache)); } catch (e) { /* ignore */ }
        return p;
    } catch (e) {
        return '';
    }
}

async function prefetchCollPosters() {
    if (collPrefetchBusy) return;
    collPrefetchBusy = true;
    const missing = [];
    let fIdx = 0;
    COLLECTIONS.forEach(c => c.films.forEach(f => {
        const item = findCollectionItem(f);
        if (!item && !collPosterCache[f.name + '|' + f.type]) missing.push({ film: f, idx: fIdx });
        fIdx++;
    }));
    for (const { film, idx } of missing) {
        const p = await ensureCollPoster(film);
        if (p) {
            const chip = document.querySelector(`#collectionsBody [data-fidx="${idx}"]`);
            if (chip) {
                const img = chip.querySelector('img');
                if (img) {
                    img.src = p;
                    img.style.display = 'block';
                } else {
                    const ph = chip.querySelector('.coll-ph');
                    if (ph) {
                        const nimg = document.createElement('img');
                        nimg.src = p;
                        nimg.alt = '';
                        nimg.loading = 'lazy';
                        nimg.referrerPolicy = 'no-referrer';
                        ph.replaceWith(nimg);
                    }
                }
            }
        }
        await new Promise(r => setTimeout(r, 250));
    }
    collPrefetchBusy = false;
    warmPosterCache();
}

$('#collectionsBody').addEventListener('click', async function(e) {
    const chip = e.target.closest('[data-coll-name]');
    if (!chip) return;
    const name = chip.dataset.collName;
    const type = chip.dataset.collType;
    const existing = findCollectionItem({ name, type });
    if (existing) {
        openDetail(existing.id);
        return;
    }
    showToast('🔍 Ищем и добавляем...');
    try {
        const resp = await tmdbFetch(`/search/multi?query=${encodeURIComponent(name)}&language=ru-RU`);
        if (!resp.ok) throw new Error('TMDB error');
        const data = await resp.json();
        const found = (data.results || []).find(r =>
            (r.title || r.name || '').toLowerCase() === name.toLowerCase()) || (data.results || [])[0];
        if (found) {
            const title = found.title || found.name || name;
            const ftype = found.media_type === 'tv' ? 'Сериал' : 'Фильм';
            const poster = found.poster_path ? `https://image.tmdb.org/t/p/w185${found.poster_path}` : '';
            const rating = found.vote_average ? Math.round(found.vote_average * 10) / 10 : 0;
            if (addItem(title, ftype, 'Буду смотреть', rating, 0, poster, 0, 0, '', false, false,
                found.id, found.media_type === 'movie' ? 'movie' : 'tv')) {
                const newItem = items[items.length - 1];
                const y = parseInt((found.release_date || found.first_air_date || '').slice(0, 4), 10);
                if (!isNaN(y)) newItem.year = y;
                saveData();
                renderCollections();
                showToast('📌 Добавлено в «Буду смотреть»!');
            }
        } else {
            showToast('❌ Не найден на TMDB', true);
        }
    } catch (e) {
        showToast('❌ Ошибка', true);
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
//  ФОНОВАЯ ДОЗАГРУЗКА TMDB (год + рейтинг + жанры + хронометраж + серии)
// ========================
const searchFailed = new Set();
let backfillRounds = 0;
const MAX_BACKFILL_ROUNDS = 4;

function needsDetail(item) {
    return !item.runtime || !item.overview || !(item.genres || []).length
        || (item.type !== 'Фильм' && !item.totalEpisodes);
}

function fillFromSearch(item, first) {
    item.tmdbId = first.id;
    item.tmdbType = first.media_type === 'movie' ? 'movie' : 'tv';
    if (item.year == null) {
        const y = parseInt((first.release_date || first.first_air_date || '').slice(0, 4), 10);
        if (!isNaN(y)) item.year = y;
    }
    if (item.tmdbRating == null && first.vote_average) {
        item.tmdbRating = Math.round(first.vote_average * 10) / 10;
    }
    if (!item.overview && first.overview) item.overview = first.overview;
    if (item.runtime == null && first.runtime) item.runtime = first.runtime;
}

function fillFromDetail(item, d) {
    if (item.type === 'Фильм') {
        if (item.runtime == null && d.runtime) item.runtime = d.runtime;
    } else {
        if (item.runtime == null && d.episode_run_time && d.episode_run_time[0]) {
            item.runtime = d.episode_run_time[0];
        }
        if (!item.totalEpisodes && d.number_of_episodes) item.totalEpisodes = d.number_of_episodes;
    }
    if (!item.overview && d.overview) item.overview = d.overview;
    if (item.year == null) {
        const y = parseInt((d.release_date || d.first_air_date || '').slice(0, 4), 10);
        if (!isNaN(y)) item.year = y;
    }
    if (item.tmdbRating == null && d.vote_average) {
        item.tmdbRating = Math.round(d.vote_average * 10) / 10;
    }
    if ((!item.genres || !item.genres.length) && d.genres && d.genres.length) {
        item.genres = d.genres.map(g => g.name).filter(Boolean);
    }
}

function backfillTMDB() {
    if (backfillRounds >= MAX_BACKFILL_ROUNDS) return;
    backfillRounds++;

    // tmdbId: 0 — поиск ранее не дал результата; пробуем снова (ранее такие
    // записи пропускались навсегда, поэтому у старых позиций не было ни
    // описания, ни похожих, ни хронометража в аналитике).
    const missing = items.filter(i => !i.tmdbId && !searchFailed.has(i.id) &&
        (needsDetail(i) || !i.year || !i.tmdbRating)).slice(0, 15);
    const noDetail = items.filter(i => i.tmdbId > 0 && needsDetail(i)).slice(0, 15);

    if (!missing.length && !noDetail.length) { backfillRounds--; return; }

    let pending = 0;
    let changed = false;
    const done = () => {
        if (--pending > 0) return;
        if (changed) {
            saveData(true);
            setTimeout(() => { backfillRounds--; backfillTMDB(); }, 3000);
        }
    };

    if (missing.length) {
        pending++;
        let k = 0;
        const tick = async () => {
            if (k >= missing.length) return done();
            const item = missing[k++];
            try {
                const resp = await tmdbFetch(`/search/multi?query=${encodeURIComponent(item.name)}&language=ru-RU`);
                if (resp.ok) {
                    const data = await resp.json();
                    const wantMovie = item.type === 'Фильм';
                    const exact = (data.results || []).filter(r =>
                        (r.title || r.name || '').toLowerCase() === item.name.toLowerCase());
                    const first = exact.find(r => (r.media_type === 'movie') === wantMovie)
                        || exact[0]
                        || (data.results || []).find(r => (r.media_type === 'movie') === wantMovie)
                        || (data.results || [])[0];
                    if (first) {
                        changed = true;
                        fillFromSearch(item, first);
                        if (needsDetail(item)) {
                            const dResp = await tmdbFetch(`/${item.tmdbType}/${item.tmdbId}?language=ru-RU`);
                            if (dResp.ok) {
                                const d = await dResp.json();
                                const before = needsDetail(item);
                                fillFromDetail(item, d);
                                if (needsDetail(item) !== before) changed = true;
                            }
                        }
                    } else {
                        searchFailed.add(item.id);
                    }
                } else {
                    searchFailed.add(item.id);
                }
            } catch (e) {
                searchFailed.add(item.id);
            }
            setTimeout(tick, 300);
        };
        tick();
    }

    if (noDetail.length) {
        pending++;
        let k = 0;
        const tick = async () => {
            if (k >= noDetail.length) return done();
            const item = noDetail[k++];
            try {
                const dResp = await tmdbFetch(`/${item.tmdbType}/${item.tmdbId}?language=ru-RU`);
                if (dResp.ok) {
                    const d = await dResp.json();
                    const before = needsDetail(item);
                    fillFromDetail(item, d);
                    if (needsDetail(item) !== before) changed = true;
                }
            } catch (e) { /* ignore */ }
            setTimeout(tick, 300);
        };
        tick();
    }
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
