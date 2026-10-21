'use strict';
// lib/brat.js
// Helper untuk fitur brat (statis PNG) & bratvid (animasi GIF).
//
// MASALAH YANG DIPERBAIKI:
//  - Endpoint lama `https://api.nexray.eu.cc/maker/bratvidhd` HANG permanen
//    (tidak pernah merespons) -> request tak terbatas -> bot crash & restart.
//  - Endpoint nexray `bratvid` mengembalikan GIF tapi content-type diset salah
//    (`image/png`), jadi deteksi pakai content-type saja menipu.
//  - Endpoint `brat` (siputzx) sering 503 "All nodes failed".
//
// SOLUSI:
//  - Multi-source dengan fallback otomatis.
//  - Timeout KETAT + AbortController supaya tidak ada request yang hang selamanya.
//  - Deteksi tipe file pakai signature/magic bytes, BUKAN content-type header.
//  - Untuk bratvid (animasi) kembalikan Buffer GIF agar wa-sticker-formatter
//    bisa convert jadi sticker animasi.

const axios = require('axios');

// ---- Deteksi tipe file dari magic bytes (andalkan ini, bukan header) ----
function sniffType(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return 'unknown';
    // GIF: "GIF87a" / "GIF89a"
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    // WEBP: "RIFF" .... "WEBP"
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    return 'unknown';
}

// ---- Fetch buffer dengan timeout ketat + abort (anti hang) ----
async function fetchBuffer(url, { timeout = 20000, headers } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const res = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout,
            maxRedirects: 5,
            validateStatus: () => true,
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                ...(headers || {}),
            },
        });
        // Kalau respons JSON (biasanya error), lempar supaya fallback ke source lain.
        const ct = (res.headers['content-type'] || '').toLowerCase();
        const buf = Buffer.from(res.data || []);
        if (ct.includes('application/json')) {
            let txt = '';
            try { txt = JSON.parse(buf.toString('utf8')).message || JSON.parse(buf.toString('utf8')).error || buf.toString('utf8'); }
            catch { txt = buf.toString('utf8'); }
            throw new Error(`api error (HTTP ${res.status}): ${String(txt).slice(0, 120)}`);
        }
        if (res.status >= 400) {
            throw new Error(`http ${res.status}: ${buf.toString('utf8').slice(0, 120)}`);
        }
        if (!buf || buf.length < 64) throw new Error('buffer kosong/too small');
        return buf;
    } finally {
        clearTimeout(timer);
    }
}

// =====================================================
// BRAT STATIS (PNG) -> untuk sticker gambar diam
// =====================================================
// Sumber berurutan, ambil yang pertama berhasil & benar-benar PNG.
async function bratStatic(text) {
    const enc = encodeURIComponent(text);
    const sources = [
        `https://api.siputzx.my.id/api/m/brat?text=${enc}&isAnimated=false&delay=500`,
        `https://api.nexray.eu.cc/maker/brat?text=${enc}`,
        `https://api.nexray.eu.cc/maker/brathd?text=${enc}`,
        `https://api.nexray.eu.cc/maker/bratvid?text=${enc}`, // kadang GIF, filter di bawah
    ];
    const errs = [];
    for (const url of sources) {
        try {
            const buf = await fetchBuffer(url, { timeout: 18000 });
            const type = sniffType(buf);
            if (type === 'png') return buf;            // ideal: PNG statis
            if (type === 'gif' || type === 'webp') return buf; // animasi tetap dipakai (sticker bisa animasi)
            throw new Error(`tipe file tidak dikenal: ${type}`);
        } catch (e) {
            errs.push(`${url.split('?')[0]}: ${e.message || e}`);
        }
    }
    throw new Error('semua sumber brat gagal -> ' + errs.join(' | '));
}

// =====================================================
// BRATVID (animasi) -> untuk sticker video/animasi
// =====================================================
// Sumber berurutan, ambil yang pertama berhasil & berupa animasi (GIF/WEBP).
// PENTING: JANGAN pakai `bratvidhd` nexray (HANG permanen -> crash bot).
async function bratVideo(text) {
    const enc = encodeURIComponent(text);
    const sources = [
        `https://api.nexray.eu.cc/maker/bratvid?text=${enc}`,          // 200 OK GIF (ct salah, deteksi magic bytes)
        `https://api.siputzx.my.id/api/m/brat?text=${enc}&isAnimated=true`, // GIF animasi reliable
        `https://api.nexray.eu.cc/maker/brat?text=${enc}`,             // fallback terakhir (gif juga)
    ];
    const errs = [];
    for (const url of sources) {
        try {
            const buf = await fetchBuffer(url, { timeout: 22000 });
            const type = sniffType(buf);
            if (type === 'gif' || type === 'webp') return { buffer: buf, type };
            // kalau PNG (statis) tetap dikembalikan sebagai fallback supaya user tetap dapat sticker,
            // tapi tandai biar caller tahu bukan animasi.
            if (type === 'png') return { buffer: buf, type };
            throw new Error(`tipe file tidak dikenal: ${type}`);
        } catch (e) {
            errs.push(`${url.split('?')[0]}: ${e.message || e}`);
        }
    }
    throw new Error('semua sumber bratvid gagal -> ' + errs.join(' | '));
}

module.exports = { bratStatic, bratVideo, fetchBuffer, sniffType };
