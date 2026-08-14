// Синхронизация архива между устройствами через Vercel KV (Upstash REST).
// Настройка в Vercel (Environment Variables):
//   KV_REST_API_URL  — https://<key>.upstash.io
//   KV_REST_API_TOKEN — REST-токен Upstash
//   KV_KEY           — ключ хранения (по умолчанию kino:archive:v1)
//   SYNC_SECRET      — необязательный секрет: если задан, клиент обязан
//                      слать заголовок x-sync-secret с этим же значением.

const KV_KEY = process.env.KV_KEY || 'kino:archive:v1';

function needSetup() {
    return !process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN;
}

async function kvGet() {
    const url = process.env.KV_REST_API_URL.replace(/\/+$/, '') + '/get/' + encodeURIComponent(KV_KEY);
    const r = await fetch(url, {
        headers: { Authorization: 'Bearer ' + process.env.KV_REST_API_TOKEN }
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !j.result) return null;
    try {
        return JSON.parse(j.result);
    } catch (e) {
        return null;
    }
}

async function kvSet(value) {
    const url = process.env.KV_REST_API_URL.replace(/\/+$/, '') + '/set/' + encodeURIComponent(KV_KEY);
    const r = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: 'Bearer ' + process.env.KV_REST_API_TOKEN,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(JSON.stringify(value))
    });
    return r.ok;
}

export default async function handler(req, res) {
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sync-secret');
        return res.status(204).end();
    }

    if (needSetup()) {
        return res.status(501).json({ error: 'KV_NOT_CONFIGURED' });
    }

    if (process.env.SYNC_SECRET && req.headers['x-sync-secret'] !== process.env.SYNC_SECRET) {
        return res.status(401).json({ error: 'BAD_SECRET' });
    }

    if (req.method === 'GET') {
        const snap = await kvGet();
        if (!snap) return res.json({ updatedAt: 0, data: null });
        return res.json(snap);
    }

    if (req.method === 'PUT') {
        let body;
        try {
            body = JSON.parse(req.body || '{}');
        } catch (e) {
            return res.status(400).json({ error: 'BAD_JSON' });
        }
        if (!body || typeof body.updatedAt !== 'number' || !Array.isArray(body.data)) {
            return res.status(400).json({ error: 'BAD_PAYLOAD' });
        }
        const prev = await kvGet();
        if (prev && prev.updatedAt > body.updatedAt) {
            return res.json({ ok: false, conflict: true, updatedAt: prev.updatedAt });
        }
        const ok = await kvSet({ updatedAt: body.updatedAt, data: body.data });
        if (!ok) return res.status(502).json({ error: 'KV_WRITE_FAILED' });
        return res.json({ ok: true, updatedAt: body.updatedAt });
    }

    return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
}
