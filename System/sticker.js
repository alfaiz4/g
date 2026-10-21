'use strict';
// lib/sticker.js
// Sticker maker AMAN (anti crash & restart).
//
// MASALAH YANG DIPERBAIKI:
//  wa-sticker-formatter + ffmpeg kadang melempar error native `free(): invalid size`
//  (bug memori di ffmpeg/sticker-formatter, muncul intermiten terutama pada GIF animasi
//  besar). Error native ini MEMBUNUH proses Node.js -> bot crash & restart.
//
// SOLUSI:
//  Konversi sticker dijalankan di CHILD PROCESS terpisah dengan timeout.
//  - Kalau child crash (free(): invalid size / SIGABRT), parent tetap hidup,
//    dan kita fallback: kirim gambar biasa / coba ulang dengan opsi lebih ringan.
//  - Input buffer di-tulis ke file tmp dulu (lebih stabil daripada kirim buffer
//    lewat stdin untuk file besar), child baca file, tulis sticker ke file output.
//  - Parent baca file output -> kirim sebagai sticker.
//
// API:
//   const { makeSticker } = require('./lib/sticker.js');
//   const webpBuffer = await makeSticker(mediaBuffer, { pack, author, type, quality });
//   // kalau gagal total -> throw (caller tangani: kirim gambar biasa / pesan error).

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Project root = parent of lib/ (tempat node_modules berada).
const PROJECT_ROOT = path.resolve(__dirname, '..');

function tmpFile(ext) {
    return path.join(os.tmpdir(), `stkr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
}

// Worker script (dijalankan di child process). Baca file input -> sticker -> tulis file output.
const WORKER_SRC = `
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const fs = require('fs');
(async () => {
  const [input, output, optsJson] = process.argv.slice(2);
  const opts = JSON.parse(optsJson || '{}');
  const buf = fs.readFileSync(input);
  const st = new Sticker(buf, {
    pack: opts.pack || '',
    author: opts.author || '',
    type: opts.type || StickerTypes.FULL,
    quality: typeof opts.quality === 'number' ? opts.quality : 60,
  });
  const out = await st.toBuffer();
  fs.writeFileSync(output, out);
  process.stdout.write('OK:' + out.length);
})().catch(e => {
  process.stdout.write('ERR:' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
`;

/**
 * Buat sticker webp dari buffer media (gambar/gif/video) secara AMAN di child process.
 * @param {Buffer} mediaBuffer
 * @param {object} opts { pack, author, type ('FULL'|'CROPPED'|'ROUNDED'|'DEFAULT'), quality }
 * @returns {Promise<Buffer>} webp sticker buffer
 */
function makeSticker(mediaBuffer, opts = {}) {
    return new Promise((resolve, reject) => {
        if (!Buffer.isBuffer(mediaBuffer) || mediaBuffer.length === 0) {
            return reject(new Error('media buffer kosong'));
        }
        const typeMap = {
            FULL: 'FULL', CROPPED: 'CROPPED', ROUNDED: 'ROUNDED', DEFAULT: 'DEFAULT',
        };
        const type = typeMap[opts.type] || 'FULL';

        const input = tmpFile('.in');
        const output = tmpFile('.webp');
        // Worker ditaruh di project root supaya child process bisa resolve
        // `wa-sticker-formatter` dari node_modules proyek.
        const worker = path.join(PROJECT_ROOT, `.stkr_worker_${Date.now()}.js`);

        try {
            fs.writeFileSync(input, mediaBuffer);
            fs.writeFileSync(worker, WORKER_SRC);
        } catch (e) {
            cleanup([input, output, worker]);
            return reject(new Error('gagal menulis file tmp sticker: ' + e.message));
        }

        const payload = JSON.stringify({
            pack: opts.pack || '',
            author: opts.author || '',
            type,
            quality: typeof opts.quality === 'number' ? opts.quality : 60,
        });

        const child = spawn(process.execPath, [worker, input, output, payload], {
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: PROJECT_ROOT,
            timeout: 45000, // hard kill child setelah 45s (anti hang)
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });

        let settled = false;
        const done = (fn) => { if (!settled) { settled = true; fn(); } };

        child.on('error', (err) => {
            cleanup([input, output, worker]);
            done(() => reject(new Error('child sticker gagal start: ' + err.message)));
        });

        child.on('close', (code, signal) => {
            // child crash dengan signal SIGABRT (free(): invalid size) -> code null, signal SIGABRT
            if (signal === 'SIGABRT' || (code !== 0 && !stdout.startsWith('OK:'))) {
                cleanup([input, output, worker]);
                const reason = signal ? `child killed by ${signal} (kemungkinan free(): invalid size di ffmpeg)` : `child exit code ${code}`;
                done(() => reject(new Error('sticker converter crash: ' + reason + (stderr ? ' | ' + stderr.slice(0, 200) : ''))));
                return;
            }
            // sukses: baca output
            if (fs.existsSync(output)) {
                const out = fs.readFileSync(output);
                cleanup([input, output, worker]);
                if (out && out.length > 0) { done(() => resolve(out)); return; }
            }
            cleanup([input, output, worker]);
            done(() => reject(new Error('sticker output kosong. stdout=' + stdout.slice(0, 200))));
        });

        // hard timeout fallback (selain spawn timeout)
        setTimeout(() => {
            if (!settled) {
                try { child.kill('SIGKILL'); } catch {}
            }
        }, 50000);
    });
}

function cleanup(files) {
    for (const f of files) {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
}

/**
 * Wrapper aman dengan RETRY + fallback.
 * - Coba buat sticker (child process). Kalau crash, retry sekali dengan quality lebih rendah.
 * - Kalau masih gagal, kembalikan null supaya caller bisa kirim media biasa (gambar/video)
 *   alih-alih crash.
 * @returns {Promise<Buffer|null>}
 */
async function safeSticker(mediaBuffer, opts = {}) {
    const baseOpts = { pack: opts.pack, author: opts.author, type: opts.type, quality: opts.quality ?? 60 };
    // attempt 1
    try { return await makeSticker(mediaBuffer, baseOpts); }
    catch (e1) {
        console.error('[sticker] attempt1 gagal:', e1.message || e1);
    }
    // attempt 2: quality lebih rendah
    try { return await makeSticker(mediaBuffer, { ...baseOpts, quality: 40 }); }
    catch (e2) {
        console.error('[sticker] attempt2 gagal:', e2.message || e2);
    }
    // attempt 3: type CROPPED (lebih ringan)
    try { return await makeSticker(mediaBuffer, { ...baseOpts, quality: 40, type: 'CROPPED' }); }
    catch (e3) {
        console.error('[sticker] attempt3 gagal:', e3.message || e3);
    }
    return null;
}

module.exports = { makeSticker, safeSticker };
