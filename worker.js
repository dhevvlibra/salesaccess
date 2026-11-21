/**
 * Server Sales Quest (Cloudflare Worker + database D1)
 *
 * Pengaturan ada di wrangler.jsonc (nama Worker, ID database, ID grup).
 * Token bot diisi di dashboard Cloudflare: Settings → Variables and Secrets → BOT_TOKEN (tipe Secret).
 * Versi 4: + Kuis Meta Ads (seleksi SF digital), lihat bagian KUIS di bawah.
 */
const ASAL_APP = 'https://dhevvlibra.github.io';
const SHIFT_MULAI = 8 * 60;     // 08.00 WIB
const SHIFT_SELESAI = 17 * 60;  // 17.00 WIB
const EARLY_BIRD = 7 * 60 + 30; // 07.30 WIB
const TARGET_KUNJUNGAN = 5;
const STATUS = {
  closing:  { label: 'Closing', xp: 100 },
  tertarik: { label: 'Tertarik', xp: 10 },
  pikir:    { label: 'Pikir-pikir', xp: 0 },
  tidak:    { label: 'Nggak tertarik', xp: 0 },
};
const MISI = { tepat: 40, kunjungan: 60, closing: 100, pulang: 30 };
const LENCANA = {
  langkah1:     { nama: 'Langkah Pertama', xp: 20 },
  ketuk1:       { nama: 'Ketuk Pintu', xp: 20 },
  closing1:     { nama: 'Closing Perdana', xp: 50 },
  earlybird:    { nama: 'Early Bird', xp: 80 },
  streak7:      { nama: 'Api Seminggu', xp: 100 },
  hattrick:     { nama: 'Hattrick', xp: 100 },
  sempurna:     { nama: 'Hari Sempurna', xp: 100 },
  kunjungan50:  { nama: 'Penjelajah', xp: 100 },
  closing10:    { nama: 'Raja Closing', xp: 150 },
  hoki:         { nama: 'Hoki Banget', xp: 50 },
  kolektor:     { nama: 'Kolektor Hadiah', xp: 30 },
  kunjungan200: { nama: 'Sang Pengembara', xp: 300 },
  streak30:     { nama: 'Api Abadi', xp: 400 },
  closing50:    { nama: 'Legenda Closing', xp: 500 },
};
const KOTAK_HOKI = [[10, 40], [20, 30], [30, 18], [50, 10], [100, 2]]; // [XP, peluang %]
const MAKS_KIRIM_DM = 40; // batas pesan pribadi per pengumuman (batas akun gratis Cloudflare)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': ASAL_APP,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method === 'GET') {
      if (url.pathname === '/cari-grup') return cariGrup(env);
      if (url.pathname === '/pasang-bot-kuis') return pasangBotKuis(env, url.origin);
      return teks([
        'Server Sales Quest aktif ✅',
        `Database: ${env.DB ? 'tersambung' : 'BELUM tersambung'}`,
        `Token bot: ${env.BOT_TOKEN ? 'sudah diisi' : 'BELUM diisi'}`,
        `Grup laporan: ${env.CHAT_ID ? 'sudah diisi' : 'BELUM diisi'}`,
        'Kuis Meta Ads: siap',
        `Bot kuis: ${env.KUIS_BOT_TOKEN ? 'token sudah diisi' : 'BELUM diisi (pakai bot Sales Quest)'}`,
      ].join('\n'));
    }
    if (request.method === 'POST' && url.pathname === '/bot-kuis') return webhookKuis(request, env, ctx);
    if (request.method !== 'POST' || !url.pathname.startsWith('/api/')) return json({ ok: false, error: 'Alamat tidak dikenal' }, 404, cors);

    try {
      if (!env.DB) throw new Gagal('Server belum tersambung ke database', 500);
      await siapkanDB(env);
      let body = {};
      try { body = await request.json(); } catch (e) {}
      const rute = url.pathname.slice(5);
      // Kuis bisa pakai bot sendiri (KUIS_BOT_TOKEN). Kalau nggak diisi, pakai bot Sales Quest.
      const envKuis = t => Object.assign({}, env, { BOT_TOKEN: t || env.KUIS_BOT_TOKEN || env.BOT_TOKEN });
      // Peserta kuis cukup pakai kode akses: bisa dari browser biasa, nggak wajib Telegram
      if (rute.startsWith('kuis/') && !rute.startsWith('kuis/admin/') && rute !== 'kuis/saya') {
        const hasil = await jalankanKuis(rute, { env: envKuis(), db: env.DB, body: body || {}, ctx, initData: request.headers.get('X-Telegram-Init-Data') || '', tokenTg: [env.KUIS_BOT_TOKEN, env.BOT_TOKEN].filter(Boolean) });
        return json(Object.assign({ ok: true }, hasil), 200, cors);
      }
      if (rute.startsWith('kuis/admin/') || rute === 'kuis/saya') {
        const daftar = [env.KUIS_BOT_TOKEN, env.BOT_TOKEN].filter(Boolean);
        if (!daftar.length) throw new Gagal('Server belum diisi token bot kuis (KUIS_BOT_TOKEN)', 500);
        const data = request.headers.get('X-Telegram-Init-Data') || '';
        let user = null, token = null;
        for (const t of daftar) { user = await cekInitData(data, t); if (user) { token = t; break; } }
        if (!user) throw new Gagal('Buka app-nya lewat Telegram dulu', 401);
        const c = { env: envKuis(token), db: env.DB, tg: user, body: body || {}, ctx };
        if (rute === 'kuis/saya') return json(Object.assign({ ok: true }, await kuisSaya(c)), 200, cors);
        c.akun = await akunAktif(c);
        if (c.akun.peran !== 'admin') throw new Gagal('Menu ini khusus admin', 403);
        return json(Object.assign({ ok: true }, await jalankanKuisAdmin(rute, c)), 200, cors);
      }
      if (!env.BOT_TOKEN) throw new Gagal('Server belum diisi token bot', 500);
      const tgUser = await cekInitData(request.headers.get('X-Telegram-Init-Data') || '', env.BOT_TOKEN);
      if (!tgUser) throw new Gagal('Buka app-nya lewat Telegram dulu', 401);
      const c = { env, db: env.DB, tg: tgUser, body: body || {}, ctx };
      if (rute === 'foto') return await foto(c, cors);
      const hasil = await jalankan(rute, c);
      return json(Object.assign({ ok: true }, hasil), 200, cors);
    } catch (e) {
      if (e instanceof Gagal) return json({ ok: false, error: e.message, kode: e.kode }, e.status, cors);
      return json({ ok: false, error: 'Server error: ' + (e.message || e) }, 500, cors);
    }
  },
};

class Gagal extends Error {
  constructor(pesan, status = 400, kode) { super(pesan); this.status = status; this.kode = kode; }
}

async function jalankan(rute, c) {
  switch (rute) {
    case 'sesi': return sesi(c);
    case 'setup': return setup(c);
    case 'login': return login(c);
    case 'logout': return logout(c);
  }
  c.akun = await akunAktif(c);
  switch (rute) {
    case 'absen': return absen(c);
    case 'kunjungan': return kunjungan(c);
    case 'klaim': return klaim(c);
    case 'kotak': return bukaKotak(c);
    case 'rekap': return rekap(c);
    case 'peringkat': return peringkat(c);
    case 'hadiah': return daftarHadiah(c);
    case 'tukar': return tukarHadiah(c);
    case 'baca': return bacaPengumuman(c);
  }
  if (c.akun.peran !== 'admin') throw new Gagal('Menu ini khusus admin', 403);
  switch (rute) {
    case 'admin/pantau': return adminPantau(c);
    case 'admin/kunjungan': return adminKunjungan(c);
    case 'admin/tim': return adminTim(c);
    case 'admin/tambah': return adminTambah(c);
    case 'admin/ubah': return adminUbah(c);
    case 'admin/target': return adminTarget(c);
    case 'admin/program': return adminProgram(c);
    case 'admin/program-simpan': return adminProgramSimpan(c);
    case 'admin/program-akhiri': return adminProgramAkhiri(c);
    case 'admin/hadiah': return adminHadiah(c);
    case 'admin/hadiah-simpan': return adminHadiahSimpan(c);
    case 'admin/hadiah-hapus': return adminHadiahHapus(c);
    case 'admin/penukaran': return adminPenukaran(c);
    case 'admin/pengumuman': return adminPengumuman(c);
    case 'admin/pengumuman-kirim': return adminPengumumanKirim(c);
    case 'admin/pengumuman-hapus': return adminPengumumanHapus(c);
    case 'admin/excel': return adminExcel(c);
  }
  throw new Gagal('Perintah tidak dikenal', 404);
}

/* ================= DATABASE ================= */
let dbSiap = false;
async function siapkanDB(env) {
  if (dbSiap) return;
  const db = env.DB;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS akun (
      username TEXT PRIMARY KEY, nama TEXT NOT NULL, peran TEXT NOT NULL DEFAULT 'sales',
      hash TEXT NOT NULL, salt TEXT NOT NULL, aktif INTEGER NOT NULL DEFAULT 1,
      tg_id TEXT, tg_nama TEXT, xp INTEGER NOT NULL DEFAULT 0, dibuat INTEGER NOT NULL)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS akun_tg ON akun(tg_id)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS absen (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, tanggal TEXT NOT NULL, jenis TEXT NOT NULL,
      waktu INTEGER NOT NULL, lat REAL, lng REAL, acc INTEGER, foto TEXT, xp INTEGER NOT NULL DEFAULT 0,
      UNIQUE(username, tanggal, jenis))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS absen_tgl ON absen(tanggal)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kunjungan (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, tanggal TEXT NOT NULL, waktu INTEGER NOT NULL,
      nama TEXT NOT NULL, hp TEXT, alamat TEXT, status TEXT NOT NULL, paket TEXT, catatan TEXT,
      lat REAL, lng REAL, acc INTEGER, foto TEXT, xp INTEGER NOT NULL DEFAULT 0)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS kunj_tgl ON kunjungan(tanggal)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS kunj_user ON kunjungan(username, tanggal)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS klaim (
      username TEXT NOT NULL, tanggal TEXT NOT NULL, misi TEXT NOT NULL, xp INTEGER NOT NULL,
      PRIMARY KEY(username, tanggal, misi))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`),
  ]);
  // Versi 3: koin, catatan XP, lencana, kotak hoki, program, hadiah, target, pengumuman
  try { await db.prepare('ALTER TABLE akun ADD COLUMN koin INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { /* kolom sudah ada */ }
  const versi = await db.prepare(`SELECT v FROM meta WHERE k='versi'`).first();
  if (!versi || Number(versi.v) < 3) {
    const belum = `(SELECT COUNT(*) FROM meta WHERE k='versi' AND v='3') = 0`;
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS xp_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, tanggal TEXT NOT NULL, waktu INTEGER NOT NULL,
        sumber TEXT NOT NULL, xp INTEGER NOT NULL, ket TEXT)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS xp_tgl ON xp_log(tanggal)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS xp_user ON xp_log(username, tanggal)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS lencana (username TEXT NOT NULL, kode TEXT NOT NULL, waktu INTEGER NOT NULL, PRIMARY KEY(username, kode))`),
      db.prepare(`CREATE TABLE IF NOT EXISTS kotak (username TEXT NOT NULL, tanggal TEXT NOT NULL, waktu INTEGER NOT NULL, xp INTEGER NOT NULL, PRIMARY KEY(username, tanggal))`),
      db.prepare(`CREATE TABLE IF NOT EXISTS program (
        id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, jenis TEXT NOT NULL, kategori TEXT NOT NULL,
        kali REAL, target INTEGER, hadiah INTEGER, mulai TEXT NOT NULL, selesai TEXT NOT NULL,
        dibuat INTEGER NOT NULL, tuntas INTEGER, diakhiri INTEGER, dihapus INTEGER NOT NULL DEFAULT 0)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS hadiah (
        id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, deskripsi TEXT, harga INTEGER NOT NULL,
        stok INTEGER, aktif INTEGER NOT NULL DEFAULT 1, dihapus INTEGER NOT NULL DEFAULT 0, dibuat INTEGER NOT NULL)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS penukaran (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, hadiah_id INTEGER NOT NULL, nama_hadiah TEXT NOT NULL,
        harga INTEGER NOT NULL, status TEXT NOT NULL, waktu INTEGER NOT NULL, diproses INTEGER)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS target (username TEXT NOT NULL, bulan TEXT NOT NULL, closing INTEGER, kunjungan INTEGER, PRIMARY KEY(username, bulan))`),
      db.prepare(`CREATE TABLE IF NOT EXISTS pengumuman (
        id INTEGER PRIMARY KEY AUTOINCREMENT, judul TEXT NOT NULL, isi TEXT NOT NULL, oleh TEXT, waktu INTEGER NOT NULL,
        terkirim INTEGER NOT NULL DEFAULT 0, dihapus INTEGER NOT NULL DEFAULT 0)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS baca (username TEXT NOT NULL, pengumuman_id INTEGER NOT NULL, PRIMARY KEY(username, pengumuman_id))`),
      // Pindahkan XP lama ke catatan XP + jadikan koin, cuma sekali
      db.prepare(`INSERT INTO xp_log (username,tanggal,waktu,sumber,xp,ket) SELECT username,tanggal,waktu,'absen',xp,'Absen ' || jenis FROM absen WHERE xp>0 AND ${belum}`),
      db.prepare(`INSERT INTO xp_log (username,tanggal,waktu,sumber,xp,ket) SELECT username,tanggal,waktu,'kunjungan',xp,'Kunjungan ' || nama FROM kunjungan WHERE xp>0 AND ${belum}`),
      db.prepare(`INSERT INTO xp_log (username,tanggal,waktu,sumber,xp,ket) SELECT username,tanggal,0,'misi',xp,'Misi ' || misi FROM klaim WHERE xp>0 AND ${belum}`),
      db.prepare(`UPDATE akun SET koin = xp WHERE ${belum}`),
      db.prepare(`INSERT OR REPLACE INTO meta (k,v) VALUES ('versi','3')`),
    ]);
  }
  // Versi 4: kuis Meta Ads
  if (!versi || Number(versi.v) < 4) {
    await db.batch([...tabelKuis(db), db.prepare(`INSERT OR REPLACE INTO meta (k,v) VALUES ('versi','4')`)]);
  }
  // Versi 5: pendaftaran kuis lewat bot
  if (!versi || Number(versi.v) < 5) {
    for (const kol of ['tg_id TEXT', 'kode_sales TEXT', 'fb TEXT']) {
      try { await db.prepare(`ALTER TABLE kuis_kode ADD COLUMN ${kol}`).run(); } catch (e) { /* kolom sudah ada */ }
    }
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS kuis_daftar (
        tg_id TEXT PRIMARY KEY, tg_user TEXT, tg_nama TEXT, langkah TEXT NOT NULL, nama TEXT, kode_sales TEXT, fb TEXT,
        mulai INTEGER, dikirim INTEGER, diproses INTEGER, oleh TEXT, kode TEXT, alasan TEXT)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS kuis_daftar_langkah ON kuis_daftar(langkah, dikirim)`),
      db.prepare(`INSERT OR REPLACE INTO meta (k,v) VALUES ('versi','5')`),
    ]);
  }
  // Versi 6: tanda soal buatan AI
  if (!versi || Number(versi.v) < 6) {
    try { await db.prepare('ALTER TABLE kuis_soal ADD COLUMN sumber TEXT').run(); } catch (e) { /* kolom sudah ada */ }
    await db.prepare(`INSERT OR REPLACE INTO meta (k,v) VALUES ('versi','6')`).run();
  }
  // Versi 7: top up dana iklan (VA BCA) buat yang lulus
  if (!versi || Number(versi.v) < 7) {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS kuis_topup (
        kode TEXT PRIMARY KEY, tg_id TEXT, status TEXT NOT NULL, va TEXT, nominal INTEGER, nilai REAL,
        dibuat INTEGER, dikirim INTEGER, diproses INTEGER, oleh TEXT, alasan TEXT)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS kuis_topup_tg ON kuis_topup(tg_id)`),
      db.prepare(`INSERT OR REPLACE INTO meta (k,v) VALUES ('versi','7')`),
    ]);
  }
  dbSiap = true;
}
const semua = async stmt => (await stmt.all()).results || [];
const angka = (v, d = 0) => (v == null ? d : Number(v));

// Catat XP + koin (1 XP = 1 koin; koin bisa ditukar hadiah tanpa ngurangin level)
function stmtXP(c, username, xp, sumber, ket, now = Date.now()) {
  return [
    c.db.prepare('INSERT INTO xp_log (username,tanggal,waktu,sumber,xp,ket) VALUES (?,?,?,?,?,?)').bind(username, tanggalWIB(now), now, sumber, xp, ket || null),
    c.db.prepare('UPDATE akun SET xp = xp + ?, koin = koin + ? WHERE username=?').bind(xp, xp, username),
  ];
}

/* ================= AKUN ================= */
async function sesi(c) {
  const adaAdmin = await c.db.prepare(`SELECT 1 FROM akun WHERE peran='admin' LIMIT 1`).first();
  if (!adaAdmin) return { status: 'setup' };
  const a = await c.db.prepare('SELECT * FROM akun WHERE tg_id=?').bind(String(c.tg.id)).first();
  if (!a) return { status: 'login' };
  if (!a.aktif) return { status: 'login', pesan: 'Akun kamu lagi dinonaktifkan. Hubungi admin.' };
  c.akun = a;
  return Object.assign({ status: 'ok' }, await dataAkun(c));
}

async function setup(c) {
  const adaAdmin = await c.db.prepare(`SELECT 1 FROM akun WHERE peran='admin' LIMIT 1`).first();
  if (adaAdmin) throw new Gagal('Akun admin udah ada. Silakan login.', 409);
  const { nama, username, password } = cekIsianAkun(c.body);
  const salt = acak(16);
  await c.db.prepare('UPDATE akun SET tg_id=NULL WHERE tg_id=?').bind(String(c.tg.id)).run();
  await c.db.prepare('INSERT INTO akun (username,nama,peran,hash,salt,aktif,tg_id,tg_nama,xp,koin,dibuat) VALUES (?,?,?,?,?,1,?,?,0,0,?)')
    .bind(username, nama, 'admin', await hashPassword(password, salt), salt, String(c.tg.id), namaTg(c.tg), Date.now()).run();
  return sesi(c);
}

async function login(c) {
  const username = String(c.body.username || '').trim().toLowerCase();
  const password = String(c.body.password || '');
  if (!username || !password) throw new Gagal('Isi username dan password dulu');
  const a = await c.db.prepare('SELECT * FROM akun WHERE username=?').bind(username).first();
  if (!a || (await hashPassword(password, a.salt)) !== a.hash) throw new Gagal('Username atau password salah', 401);
  if (!a.aktif) throw new Gagal('Akun kamu lagi dinonaktifkan. Hubungi admin.', 403);
  const tgId = String(c.tg.id);
  if (a.tg_id && a.tg_id !== tgId) throw new Gagal('Akun ini udah dipakai di Telegram lain. Minta admin reset dulu.', 409);
  await c.db.batch([
    c.db.prepare('UPDATE akun SET tg_id=NULL WHERE tg_id=? AND username<>?').bind(tgId, username),
    c.db.prepare('UPDATE akun SET tg_id=?, tg_nama=? WHERE username=?').bind(tgId, namaTg(c.tg), username),
  ]);
  return sesi(c);
}

async function logout(c) {
  await c.db.prepare('UPDATE akun SET tg_id=NULL WHERE tg_id=?').bind(String(c.tg.id)).run();
  return { status: 'login' };
}

async function akunAktif(c) {
  const a = await c.db.prepare('SELECT * FROM akun WHERE tg_id=?').bind(String(c.tg.id)).first();
  if (!a) throw new Gagal('Sesi kamu udah habis. Login lagi ya.', 401, 'LOGIN');
  if (!a.aktif) throw new Gagal('Akun kamu lagi dinonaktifkan. Hubungi admin.', 403, 'LOGIN');
  return a;
}

function cekIsianAkun(b, wajibPassword = true) {
  const nama = String(b.nama || '').trim().slice(0, 60);
  const username = String(b.username || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!nama) throw new Gagal('Nama wajib diisi');
  if (!/^[a-z0-9._]{3,20}$/.test(username)) throw new Gagal('Username 3–20 karakter: huruf kecil, angka, titik, atau garis bawah');
  if (wajibPassword && password.length < 6) throw new Gagal('Password minimal 6 karakter');
  return { nama, username, password };
}

/* ================= DATA SALES ================= */
async function dataAkun(c) {
  const a = await c.db.prepare('SELECT * FROM akun WHERE username=?').bind(c.akun.username).first();
  c.akun = a;
  const akun = { username: a.username, nama: a.nama, peran: a.peran, xp: a.xp, koin: a.koin };
  if (a.peran === 'admin') return { akun };
  const now = Date.now(), tgl = tanggalWIB(now), bulan = tgl.slice(0, 7);
  const [absenHariIni, kunjHariIni, klaimHariIni, tglMasuk, tglRiwayat, xpHari, lencana, kotak, target, capaian, statKunj, statEarly, umum] = await c.db.batch([
    c.db.prepare('SELECT * FROM absen WHERE username=? AND tanggal=?').bind(a.username, tgl),
    c.db.prepare('SELECT * FROM kunjungan WHERE username=? AND tanggal=? ORDER BY waktu').bind(a.username, tgl),
    c.db.prepare('SELECT misi, xp FROM klaim WHERE username=? AND tanggal=?').bind(a.username, tgl),
    c.db.prepare(`SELECT tanggal FROM absen WHERE username=? AND jenis='masuk' ORDER BY tanggal DESC LIMIT 120`).bind(a.username),
    c.db.prepare(`SELECT tanggal FROM absen WHERE username=? AND tanggal<? UNION SELECT tanggal FROM kunjungan WHERE username=? AND tanggal<? ORDER BY tanggal DESC LIMIT 6`).bind(a.username, tgl, a.username, tgl),
    c.db.prepare('SELECT COALESCE(SUM(xp),0) AS n FROM xp_log WHERE username=? AND tanggal=?').bind(a.username, tgl),
    c.db.prepare('SELECT kode, waktu FROM lencana WHERE username=? ORDER BY waktu').bind(a.username),
    c.db.prepare('SELECT xp FROM kotak WHERE username=? AND tanggal=?').bind(a.username, tgl),
    c.db.prepare('SELECT closing, kunjungan FROM target WHERE username=? AND bulan=?').bind(a.username, bulan),
    c.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(status='closing'),0) AS closing FROM kunjungan WHERE username=? AND tanggal>=?`).bind(a.username, bulan + '-01'),
    c.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(status='closing'),0) AS closing FROM kunjungan WHERE username=?`).bind(a.username),
    c.db.prepare(`SELECT COALESCE(SUM(((waktu/60000)+420)%1440 <= ?),0) AS n FROM absen WHERE username=? AND jenis='masuk'`).bind(EARLY_BIRD, a.username),
    c.db.prepare(`SELECT id, judul, isi, oleh, waktu FROM pengumuman p WHERE dihapus=0 AND waktu>? AND NOT EXISTS (SELECT 1 FROM baca b WHERE b.username=? AND b.pengumuman_id=p.id) ORDER BY waktu DESC LIMIT 3`).bind(now - 14 * 864e5, a.username),
  ]);
  const hariIni = susunHari(tgl, absenHariIni.results, kunjHariIni.results);
  hariIni.klaim = klaimHariIni.results.map(r => r.misi);

  let riwayat = [];
  const daftarTgl = tglRiwayat.results.map(r => r.tanggal);
  if (daftarTgl.length) {
    const tanda = daftarTgl.map(() => '?').join(',');
    const [ab, kj] = await c.db.batch([
      c.db.prepare(`SELECT * FROM absen WHERE username=? AND tanggal IN (${tanda})`).bind(a.username, ...daftarTgl),
      c.db.prepare(`SELECT * FROM kunjungan WHERE username=? AND tanggal IN (${tanda}) ORDER BY waktu`).bind(a.username, ...daftarTgl),
    ]);
    riwayat = daftarTgl.map(t => susunHari(t, ab.results.filter(r => r.tanggal === t), kj.results.filter(r => r.tanggal === t)));
  }
  const streak = hitungStreak(tglMasuk.results.map(r => r.tanggal), tgl);
  const masuk = hariIni.masuk;
  const t = target.results[0];
  return {
    akun, hariIni, riwayat, streak,
    xpHariIni: angka(xpHari.results[0].n),
    lencana: lencana.results,
    statLencana: { masuk: tglMasuk.results.length, early: angka(statEarly.results[0].n), kunjungan: angka(statKunj.results[0].n), closing: angka(statKunj.results[0].closing), streak },
    kotak: { boleh: !!masuk && menitWIB(masuk.t) <= SHIFT_MULAI, xp: kotak.results[0] ? kotak.results[0].xp : null },
    target: t ? { bulan, closing: t.closing, kunjungan: t.kunjungan, capaianClosing: angka(capaian.results[0].closing), capaianKunjungan: angka(capaian.results[0].n) } : null,
    program: await programUntukSales(c, tgl, a.username),
    pengumuman: umum.results,
  };
}

function susunHari(tanggal, absenRows, kunjRows) {
  const ab = j => { const r = absenRows.find(x => x.jenis === j); return r ? bentukAbsen(r) : null; };
  return { tanggal, masuk: ab('masuk'), pulang: ab('pulang'), visits: kunjRows.map(bentukKunjungan) };
}
const bentukAbsen = r => ({ t: r.waktu, lat: r.lat, lng: r.lng, acc: r.acc, foto: r.foto || null, xp: r.xp });
const bentukKunjungan = r => ({ id: r.id, t: r.waktu, nama: r.nama, hp: r.hp, alamat: r.alamat, status: r.status, paket: r.paket, catatan: r.catatan, lat: r.lat, lng: r.lng, acc: r.acc, foto: r.foto || null, xp: r.xp });

// Streak = hari kerja berturut-turut dengan absen masuk. Hari Minggu dilewati.
function hitungStreak(tanggalMasuk, hariIni) {
  const ada = new Set(tanggalMasuk);
  let t = ada.has(hariIni) ? hariIni : mundur(hariIni, 1), n = 0;
  for (let i = 0; i < 400; i++) {
    if (ada.has(t)) n++;
    else if (hariDalamMinggu(t) !== 0) break;
    t = mundur(t, 1);
  }
  return n;
}

/* ================= PROGRAM / EVENT ================= */
async function programAktif(c, tgl) {
  return semua(c.db.prepare('SELECT * FROM program WHERE dihapus=0 AND diakhiri IS NULL AND mulai<=? AND selesai>=? ORDER BY selesai').bind(tgl, tgl));
}
// kategori aksi: absen | kunjungan | closing | misi
function hitungBonus(programs, kategori, xpDasar) {
  const out = [];
  for (const p of programs) {
    if (p.jenis !== 'bonus') continue;
    const cocok = p.kategori === 'semua' || p.kategori === kategori || (p.kategori === 'kunjungan' && kategori === 'closing');
    if (!cocok) continue;
    const b = Math.round(xpDasar * (Number(p.kali) - 1));
    if (b > 0) out.push({ ket: `${p.nama} ×${Number(p.kali)}`, xp: b });
  }
  return out;
}
async function progresTantangan(c, p, username) {
  const syaratClosing = p.kategori === 'closing' ? `AND k.status='closing'` : '';
  const [tot, saya] = await c.db.batch([
    c.db.prepare(`SELECT COUNT(*) AS n FROM kunjungan k JOIN akun a ON a.username=k.username WHERE a.peran='sales' AND k.tanggal BETWEEN ? AND ? ${syaratClosing}`).bind(p.mulai, p.selesai),
    c.db.prepare(`SELECT COUNT(*) AS n FROM kunjungan k WHERE k.username=? AND k.tanggal BETWEEN ? AND ? ${syaratClosing}`).bind(username || '', p.mulai, p.selesai),
  ]);
  return { progres: angka(tot.results[0].n), kontribusi: angka(saya.results[0].n) };
}
const bentukProgram = p => ({ id: p.id, nama: p.nama, jenis: p.jenis, kategori: p.kategori, kali: p.kali == null ? null : Number(p.kali), target: p.target, hadiah: p.hadiah, mulai: p.mulai, selesai: p.selesai, tuntas: p.tuntas || null, diakhiri: p.diakhiri || null });
async function programUntukSales(c, tgl, username) {
  const list = await programAktif(c, tgl);
  const out = [];
  for (const p of list) {
    const b = bentukProgram(p);
    if (p.jenis === 'tantangan') Object.assign(b, await progresTantangan(c, p, username));
    out.push(b);
  }
  return out;
}
async function cekTantangan(c, programs) {
  const selesai = [];
  for (const p of programs) {
    if (p.jenis !== 'tantangan' || p.tuntas) continue;
    const { progres } = await progresTantangan(c, p);
    if (progres < p.target) continue;
    const r = await c.db.prepare('UPDATE program SET tuntas=? WHERE id=? AND tuntas IS NULL').bind(Date.now(), p.id).run();
    if (!r || !r.meta || !r.meta.changes) continue;
    const syaratClosing = p.kategori === 'closing' ? `AND k.status='closing'` : '';
    const penyumbang = await semua(c.db.prepare(`SELECT DISTINCT k.username FROM kunjungan k JOIN akun a ON a.username=k.username WHERE a.peran='sales' AND a.aktif=1 AND k.tanggal BETWEEN ? AND ? ${syaratClosing}`).bind(p.mulai, p.selesai));
    const stmts = penyumbang.flatMap(u => stmtXP(c, u.username, p.hadiah, 'program', `Tantangan ${p.nama} tercapai`));
    if (stmts.length) await c.db.batch(stmts);
    selesai.push({ nama: p.nama, hadiah: p.hadiah, penyumbang: penyumbang.map(u => u.username) });
    try {
      await tg(c.env, 'sendMessage', { chat_id: wajibChat(c.env), text: `🏆 TANTANGAN TIM TERCAPAI!\n${p.nama}: ${progres}/${p.target} ${p.kategori}\n🎁 +${p.hadiah} XP buat ${penyumbang.length} sales yang ikut nyumbang. Mantap, tim!` });
    } catch (e) {}
  }
  return selesai;
}

/* ================= LENCANA ================= */
async function cekLencana(c, username) {
  const tgl = tanggalWIB(Date.now());
  const [punya, ab, kj, closingHariIni, klaimHariIni, kotakMax, tukar, tglMasuk] = await c.db.batch([
    c.db.prepare('SELECT kode FROM lencana WHERE username=?').bind(username),
    c.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(((waktu/60000)+420)%1440 <= ?),0) AS early FROM absen WHERE username=? AND jenis='masuk'`).bind(EARLY_BIRD, username),
    c.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(status='closing'),0) AS closing FROM kunjungan WHERE username=?`).bind(username),
    c.db.prepare(`SELECT COUNT(*) AS n FROM kunjungan WHERE username=? AND tanggal=? AND status='closing'`).bind(username, tgl),
    c.db.prepare('SELECT COUNT(*) AS n FROM klaim WHERE username=? AND tanggal=?').bind(username, tgl),
    c.db.prepare('SELECT COALESCE(MAX(xp),0) AS m FROM kotak WHERE username=?').bind(username),
    c.db.prepare('SELECT COUNT(*) AS n FROM penukaran WHERE username=?').bind(username),
    c.db.prepare(`SELECT tanggal FROM absen WHERE username=? AND jenis='masuk' ORDER BY tanggal DESC LIMIT 120`).bind(username),
  ]);
  const sudah = new Set(punya.results.map(r => r.kode));
  const masuk = angka(ab.results[0].n), early = angka(ab.results[0].early);
  const kunj = angka(kj.results[0].n), closing = angka(kj.results[0].closing);
  const streak = hitungStreak(tglMasuk.results.map(r => r.tanggal), tgl);
  const syarat = {
    langkah1: masuk >= 1, ketuk1: kunj >= 1, closing1: closing >= 1, earlybird: early >= 5,
    streak7: streak >= 7, streak30: streak >= 30, hattrick: angka(closingHariIni.results[0].n) >= 3,
    sempurna: angka(klaimHariIni.results[0].n) >= 4, kunjungan50: kunj >= 50, kunjungan200: kunj >= 200,
    closing10: closing >= 10, closing50: closing >= 50, hoki: angka(kotakMax.results[0].m) >= 100, kolektor: angka(tukar.results[0].n) >= 1,
  };
  const baru = Object.keys(LENCANA).filter(k => !sudah.has(k) && syarat[k]);
  if (!baru.length) return [];
  const now = Date.now();
  await c.db.batch(baru.flatMap(k => [
    c.db.prepare('INSERT OR IGNORE INTO lencana (username,kode,waktu) VALUES (?,?,?)').bind(username, k, now),
    ...stmtXP(c, username, LENCANA[k].xp, 'lencana', `Lencana ${LENCANA[k].nama}`, now),
  ]));
  return baru.map(k => ({ kode: k, nama: LENCANA[k].nama, xp: LENCANA[k].xp }));
}

/* ================= AKSI SALES ================= */
async function absen(c) {
  const a = c.akun, d = c.body, jenis = d.jenis;
  if (jenis !== 'masuk' && jenis !== 'pulang') throw new Gagal('Jenis absen nggak dikenal');
  const now = Date.now(), tgl = tanggalWIB(now), m = menitWIB(now);
  const sudah = new Set((await semua(c.db.prepare('SELECT jenis FROM absen WHERE username=? AND tanggal=?').bind(a.username, tgl))).map(r => r.jenis));
  if (sudah.has(jenis)) throw new Gagal(jenis === 'masuk' ? 'Kamu udah absen masuk hari ini' : 'Kamu udah absen pulang hari ini', 409);
  if (jenis === 'pulang' && !sudah.has('masuk')) throw new Gagal('Absen masuk dulu ya', 409);
  const foto = cekFoto(d.foto, true);
  const lok = cekLokasi(d);
  const dasar = jenis === 'masuk' ? 50 + (m <= SHIFT_MULAI ? 20 : 0) : 30 + (m >= SHIFT_SELESAI ? 20 : 0);
  const bonus = hitungBonus(await programAktif(c, tgl), 'absen', dasar);
  const xp = dasar + bonus.reduce((s, b) => s + b.xp, 0);

  const status = jenis === 'masuk' ? (m <= SHIFT_MULAI ? ' · Tepat waktu' : ` · Telat ${durasi(m - SHIFT_MULAI)}`) : '';
  const caption = [
    jenis === 'masuk' ? '🟢 ABSEN MASUK' : '🏠 ABSEN PULANG',
    `👤 ${labelSales(a)}`,
    `🕗 ${jamWIB(now)} WIB${status}`,
    barisLokasi(lok),
  ].join('\n');
  const msg = await kirimFoto(c.env, foto, caption);
  if (lok.lat != null) {
    const pin = { chat_id: c.env.CHAT_ID, latitude: lok.lat, longitude: lok.lng, reply_parameters: { message_id: msg.result.message_id, allow_sending_without_reply: true } };
    if (lok.acc) pin.horizontal_accuracy = Math.min(1500, lok.acc);
    try { await tg(c.env, 'sendLocation', pin); } catch (e) {}
  }
  await c.db.batch([
    c.db.prepare('INSERT INTO absen (username,tanggal,jenis,waktu,lat,lng,acc,foto,xp) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(a.username, tgl, jenis, now, lok.lat, lok.lng, lok.acc, fotoId(msg), xp),
    ...stmtXP(c, a.username, dasar, 'absen', `Absen ${jenis}`, now),
    ...bonus.flatMap(b => stmtXP(c, a.username, b.xp, 'program', b.ket, now)),
  ]);
  const lencanaBaru = await cekLencana(c, a.username);
  return Object.assign({ xp, bonus, lencanaBaru }, await dataAkun(c));
}

async function kunjungan(c) {
  const a = c.akun, d = c.body;
  const nama = String(d.nama || '').trim().slice(0, 80);
  if (!nama) throw new Gagal('Nama calon pelanggan wajib diisi');
  if (!STATUS[d.status]) throw new Gagal('Pilih hasil kunjungannya');
  const hp = String(d.hp || '').trim().slice(0, 30), alamat = String(d.alamat || '').trim().slice(0, 160);
  const paket = String(d.paket || '').trim().slice(0, 30), catatan = String(d.catatan || '').trim().slice(0, 500);
  const foto = cekFoto(d.foto, false);
  const lok = cekLokasi(d);
  const now = Date.now(), tgl = tanggalWIB(now);
  const dasar = 15 + STATUS[d.status].xp + (foto ? 5 : 0);
  const programs = await programAktif(c, tgl);
  const bonus = hitungBonus(programs, d.status === 'closing' ? 'closing' : 'kunjungan', dasar);
  const xp = dasar + bonus.reduce((s, b) => s + b.xp, 0);

  const caption = [
    `🚪 KUNJUNGAN · ${d.status === 'closing' ? 'CLOSING 🎉' : STATUS[d.status].label}`,
    `👤 Sales: ${labelSales(a)}`,
    `🏡 ${nama}`,
    hp && `📞 ${hp}`,
    alamat && `📌 ${alamat}`,
    paket && `📦 Paket ${paket}`,
    catatan && `📝 ${catatan}`,
    `🕗 ${jamWIB(now)} WIB`,
    lok.lat != null ? `🗺️ https://maps.google.com/?q=${lok.lat},${lok.lng}` : '📍 Lokasi nggak kebaca',
  ].filter(Boolean).join('\n');
  const msg = await kirimFoto(c.env, foto, caption);
  await c.db.batch([
    c.db.prepare('INSERT INTO kunjungan (username,tanggal,waktu,nama,hp,alamat,status,paket,catatan,lat,lng,acc,foto,xp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(a.username, tgl, now, nama, hp, alamat, d.status, paket, catatan, lok.lat, lok.lng, lok.acc, fotoId(msg), xp),
    ...stmtXP(c, a.username, dasar, 'kunjungan', `Kunjungan ${nama}`, now),
    ...bonus.flatMap(b => stmtXP(c, a.username, b.xp, 'program', b.ket, now)),
  ]);
  const tantanganSelesai = await cekTantangan(c, programs);
  const lencanaBaru = await cekLencana(c, a.username);
  return Object.assign({ xp, bonus, lencanaBaru, tantanganSelesai }, await dataAkun(c));
}

async function klaim(c) {
  const a = c.akun, misi = String(c.body.misi || '');
  if (!MISI[misi]) throw new Gagal('Misi nggak dikenal');
  const tgl = tanggalWIB(Date.now());
  const [ab, kj] = await c.db.batch([
    c.db.prepare('SELECT jenis, waktu FROM absen WHERE username=? AND tanggal=?').bind(a.username, tgl),
    c.db.prepare('SELECT status FROM kunjungan WHERE username=? AND tanggal=?').bind(a.username, tgl),
  ]);
  const masuk = ab.results.find(r => r.jenis === 'masuk');
  const syarat = {
    tepat: !!masuk && menitWIB(masuk.waktu) <= SHIFT_MULAI,
    kunjungan: kj.results.length >= TARGET_KUNJUNGAN,
    closing: kj.results.some(r => r.status === 'closing'),
    pulang: ab.results.some(r => r.jenis === 'pulang'),
  };
  if (!syarat[misi]) throw new Gagal('Misi ini belum selesai');
  const dasar = MISI[misi];
  const bonus = hitungBonus(await programAktif(c, tgl), 'misi', dasar);
  const xp = dasar + bonus.reduce((s, b) => s + b.xp, 0);
  try {
    await c.db.batch([
      c.db.prepare('INSERT INTO klaim (username,tanggal,misi,xp) VALUES (?,?,?,?)').bind(a.username, tgl, misi, xp),
      ...stmtXP(c, a.username, dasar, 'misi', `Misi ${misi}`),
      ...bonus.flatMap(b => stmtXP(c, a.username, b.xp, 'program', b.ket)),
    ]);
  } catch (e) { throw new Gagal('Hadiah misi ini udah diambil', 409); }
  const lencanaBaru = await cekLencana(c, a.username);
  return Object.assign({ xp, bonus, lencanaBaru }, await dataAkun(c));
}

async function bukaKotak(c) {
  const a = c.akun, now = Date.now(), tgl = tanggalWIB(now);
  const masuk = await c.db.prepare(`SELECT waktu FROM absen WHERE username=? AND tanggal=? AND jenis='masuk'`).bind(a.username, tgl).first();
  if (!masuk) throw new Gagal('Absen masuk dulu ya');
  if (menitWIB(masuk.waktu) > SHIFT_MULAI) throw new Gagal('Kotak Hoki cuma kebuka kalau kamu absen sebelum 08.00', 403);
  const sudah = await c.db.prepare('SELECT xp FROM kotak WHERE username=? AND tanggal=?').bind(a.username, tgl).first();
  if (sudah) throw new Gagal('Kotak Hoki hari ini udah kamu buka', 409);
  const xp = undiKotak();
  try {
    await c.db.batch([
      c.db.prepare('INSERT INTO kotak (username,tanggal,waktu,xp) VALUES (?,?,?,?)').bind(a.username, tgl, now, xp),
      ...stmtXP(c, a.username, xp, 'kotak', 'Kotak Hoki', now),
    ]);
  } catch (e) { throw new Gagal('Kotak Hoki hari ini udah kamu buka', 409); }
  const lencanaBaru = await cekLencana(c, a.username);
  return Object.assign({ xp, isiKotak: xp, jackpot: xp >= 100, lencanaBaru }, await dataAkun(c));
}
function undiKotak() {
  const r = new Uint32Array(1); crypto.getRandomValues(r);
  let x = r[0] % 100;
  for (const [xp, peluang] of KOTAK_HOKI) { if (x < peluang) return xp; x -= peluang; }
  return KOTAK_HOKI[0][0];
}

async function rekap(c) {
  const a = c.akun, now = Date.now(), tgl = tanggalWIB(now);
  const [ab, kj, xpHari] = await c.db.batch([
    c.db.prepare('SELECT * FROM absen WHERE username=? AND tanggal=?').bind(a.username, tgl),
    c.db.prepare('SELECT * FROM kunjungan WHERE username=? AND tanggal=? ORDER BY waktu').bind(a.username, tgl),
    c.db.prepare('SELECT COALESCE(SUM(xp),0) AS n FROM xp_log WHERE username=? AND tanggal=?').bind(a.username, tgl),
  ]);
  const masuk = ab.results.find(r => r.jenis === 'masuk'), pulang = ab.results.find(r => r.jenis === 'pulang');
  const n = s => kj.results.filter(r => r.status === s).length;
  const mm = masuk && menitWIB(masuk.waktu);
  let t = `📋 REKAP HARIAN\n${tanggalPanjang(tgl)}\nSales: ${labelSales(a)}\n\n`;
  t += `🕗 Masuk: ${masuk ? `${jamWIB(masuk.waktu)} (${mm <= SHIFT_MULAI ? 'tepat waktu' : 'telat ' + durasi(mm - SHIFT_MULAI)})` : 'belum absen'}\n`;
  t += `🏠 Pulang: ${pulang ? jamWIB(pulang.waktu) : 'belum'}\n`;
  t += `🚪 Kunjungan: ${kj.results.length}\n    Closing ${n('closing')} · Tertarik ${n('tertarik')} · Pikir-pikir ${n('pikir')} · Nggak tertarik ${n('tidak')}\n`;
  if (kj.results.length) t += '\nDetail:\n' + kj.results.map((v, i) => `${i + 1}. ${jamWIB(v.waktu)} ${v.nama} · ${STATUS[v.status].label}${v.paket ? ` (${v.paket})` : ''}`).join('\n') + '\n';
  t += `\n⭐ XP hari ini: +${angka(xpHari.results[0].n)}`;
  await tg(c.env, 'sendMessage', { chat_id: wajibChat(c.env), text: t.slice(0, 4000) });
  return {};
}

/* ================= PERINGKAT ================= */
function rentangPeriode(periode) {
  const tgl = tanggalWIB(Date.now());
  if (periode === 'bulan') return { dari: tgl.slice(0, 8) + '01', sampai: tgl };
  return { dari: mundur(tgl, (hariDalamMinggu(tgl) + 6) % 7), sampai: tgl }; // mulai Senin
}
async function peringkat(c) {
  const periode = c.body.periode === 'bulan' ? 'bulan' : 'minggu';
  const metrik = ['xp', 'closing', 'kunjungan'].includes(c.body.metrik) ? c.body.metrik : 'xp';
  const { dari, sampai } = rentangPeriode(periode);
  const q = metrik === 'xp'
    ? `SELECT a.username, a.nama, a.xp AS total, COALESCE(SUM(l.xp),0) AS nilai FROM akun a LEFT JOIN xp_log l ON l.username=a.username AND l.tanggal BETWEEN ? AND ? WHERE a.peran='sales' AND a.aktif=1 GROUP BY a.username ORDER BY nilai DESC, a.nama COLLATE NOCASE`
    : `SELECT a.username, a.nama, a.xp AS total, COUNT(k.id) AS nilai FROM akun a LEFT JOIN kunjungan k ON k.username=a.username AND k.tanggal BETWEEN ? AND ? ${metrik === 'closing' ? `AND k.status='closing'` : ''} WHERE a.peran='sales' AND a.aktif=1 GROUP BY a.username ORDER BY nilai DESC, a.nama COLLATE NOCASE`;
  const rows = await semua(c.db.prepare(q).bind(dari, sampai));
  let rank = 0, sebelum = null;
  const daftar = rows.map((r, i) => { if (r.nilai !== sebelum) { rank = i + 1; sebelum = r.nilai; } return { username: r.username, nama: r.nama, nilai: angka(r.nilai), total: angka(r.total), rank }; });
  return { periode, metrik, dari, sampai, daftar, saya: c.akun.username };
}

/* ================= HADIAH & KOIN ================= */
const bentukHadiah = h => ({ id: h.id, nama: h.nama, deskripsi: h.deskripsi || '', harga: h.harga, stok: h.stok == null ? null : h.stok, aktif: !!h.aktif });
async function daftarHadiah(c) {
  const [katalog, milik, akun] = await c.db.batch([
    c.db.prepare('SELECT * FROM hadiah WHERE dihapus=0 AND aktif=1 ORDER BY harga'),
    c.db.prepare('SELECT * FROM penukaran WHERE username=? ORDER BY waktu DESC LIMIT 20').bind(c.akun.username),
    c.db.prepare('SELECT koin FROM akun WHERE username=?').bind(c.akun.username),
  ]);
  return {
    koin: angka(akun.results[0].koin),
    katalog: katalog.results.map(bentukHadiah),
    penukaran: milik.results.map(p => ({ id: p.id, nama: p.nama_hadiah, harga: p.harga, status: p.status, waktu: p.waktu, diproses: p.diproses })),
  };
}
async function tukarHadiah(c) {
  const a = c.akun, id = Number(c.body.id);
  const h = await c.db.prepare('SELECT * FROM hadiah WHERE id=? AND dihapus=0 AND aktif=1').bind(id).first();
  if (!h) throw new Gagal('Hadiah ini udah nggak tersedia', 404);
  if (h.stok != null && h.stok <= 0) throw new Gagal('Stok hadiah ini lagi habis', 409);
  const koin = angka((await c.db.prepare('SELECT koin FROM akun WHERE username=?').bind(a.username).first()).koin);
  if (koin < h.harga) throw new Gagal(`Koin kamu kurang ${h.harga - koin} lagi`, 409);
  const now = Date.now();
  await c.db.batch([
    c.db.prepare('UPDATE akun SET koin = koin - ? WHERE username=?').bind(h.harga, a.username),
    c.db.prepare('UPDATE hadiah SET stok = CASE WHEN stok IS NULL THEN NULL ELSE stok - 1 END WHERE id=?').bind(id),
    c.db.prepare(`INSERT INTO penukaran (username,hadiah_id,nama_hadiah,harga,status,waktu) VALUES (?,?,?,?,'menunggu',?)`).bind(a.username, id, h.nama, h.harga, now),
  ]);
  try { await tg(c.env, 'sendMessage', { chat_id: wajibChat(c.env), text: `🎁 PENUKARAN HADIAH\n👤 ${labelSales(a)}\n🎁 ${h.nama} (${h.harga} koin)\n\nProses di app: Kelola → Hadiah` }); } catch (e) {}
  const lencanaBaru = await cekLencana(c, a.username);
  return Object.assign({ lencanaBaru, hadiah: h.nama }, await daftarHadiah(c), await dataAkun(c));
}

/* ================= PENGUMUMAN ================= */
async function bacaPengumuman(c) {
  await c.db.prepare('INSERT OR IGNORE INTO baca (username,pengumuman_id) VALUES (?,?)').bind(c.akun.username, Number(c.body.id) || 0).run();
  return {};
}

/* ================= ADMIN: PANTAU, KUNJUNGAN, TIM ================= */
async function adminPantau(c) {
  const tgl = tanggalWIB(Date.now());
  const [akun, ab, kj] = await c.db.batch([
    c.db.prepare(`SELECT username, nama, tg_id FROM akun WHERE peran='sales' AND aktif=1 ORDER BY nama COLLATE NOCASE`),
    c.db.prepare('SELECT * FROM absen WHERE tanggal=?').bind(tgl),
    c.db.prepare(`SELECT username, COUNT(*) AS n, SUM(status='closing') AS closing FROM kunjungan WHERE tanggal=? GROUP BY username`).bind(tgl),
  ]);
  const sales = akun.results.map(s => {
    const cari = j => { const r = ab.results.find(x => x.username === s.username && x.jenis === j); return r ? bentukAbsen(r) : null; };
    const k = kj.results.find(x => x.username === s.username) || {};
    return { username: s.username, nama: s.nama, terhubung: !!s.tg_id, masuk: cari('masuk'), pulang: cari('pulang'), kunjungan: angka(k.n), closing: angka(k.closing) };
  });
  return { tanggal: tgl, sales };
}

async function adminKunjungan(c) {
  const hariIni = tanggalWIB(Date.now());
  const rentang = c.body.rentang;
  const dari = rentang === 'kemarin' ? mundur(hariIni, 1) : rentang === '7hari' ? mundur(hariIni, 6) : hariIni;
  const sampai = rentang === 'kemarin' ? mundur(hariIni, 1) : hariIni;
  const username = String(c.body.username || '');
  const q = username
    ? c.db.prepare('SELECT k.*, a.nama AS sales FROM kunjungan k LEFT JOIN akun a ON a.username=k.username WHERE k.tanggal BETWEEN ? AND ? AND k.username=? ORDER BY k.waktu DESC LIMIT 300').bind(dari, sampai, username)
    : c.db.prepare('SELECT k.*, a.nama AS sales FROM kunjungan k LEFT JOIN akun a ON a.username=k.username WHERE k.tanggal BETWEEN ? AND ? ORDER BY k.waktu DESC LIMIT 300').bind(dari, sampai);
  const rows = await semua(q);
  const daftarSales = await semua(c.db.prepare(`SELECT username, nama FROM akun WHERE peran='sales' ORDER BY nama COLLATE NOCASE`));
  return {
    dari, sampai, daftarSales,
    kunjungan: rows.map(r => Object.assign(bentukKunjungan(r), { username: r.username, sales: r.sales || r.username, tanggal: r.tanggal })),
  };
}

async function adminTim(c) {
  const bulan = tanggalWIB(Date.now()).slice(0, 7);
  const [rows, tgt, cap] = await c.db.batch([
    c.db.prepare('SELECT username, nama, peran, aktif, tg_id, tg_nama, xp, koin FROM akun ORDER BY peran, nama COLLATE NOCASE'),
    c.db.prepare('SELECT * FROM target WHERE bulan=?').bind(bulan),
    c.db.prepare(`SELECT username, COUNT(*) AS n, COALESCE(SUM(status='closing'),0) AS closing FROM kunjungan WHERE tanggal>=? GROUP BY username`).bind(bulan + '-01'),
  ]);
  return {
    bulan,
    tim: rows.results.map(r => {
      const t = tgt.results.find(x => x.username === r.username), k = cap.results.find(x => x.username === r.username) || {};
      return {
        username: r.username, nama: r.nama, peran: r.peran, aktif: !!r.aktif, terhubung: !!r.tg_id, tgNama: r.tg_nama || '', xp: r.xp, koin: angka(r.koin),
        saya: r.username === c.akun.username,
        target: t ? { closing: t.closing, kunjungan: t.kunjungan } : null,
        capaian: { closing: angka(k.closing), kunjungan: angka(k.n) },
      };
    }),
  };
}

async function adminTambah(c) {
  const { nama, username, password } = cekIsianAkun(c.body);
  const peran = c.body.peran === 'admin' ? 'admin' : 'sales';
  const ada = await c.db.prepare('SELECT 1 FROM akun WHERE username=?').bind(username).first();
  if (ada) throw new Gagal('Username itu udah dipakai, coba yang lain', 409);
  const salt = acak(16);
  await c.db.prepare('INSERT INTO akun (username,nama,peran,hash,salt,aktif,xp,koin,dibuat) VALUES (?,?,?,?,?,1,0,0,?)')
    .bind(username, nama, peran, await hashPassword(password, salt), salt, Date.now()).run();
  return { akun: { username, nama, peran } };
}

async function adminUbah(c) {
  const username = String(c.body.username || '').toLowerCase(), aksi = c.body.aksi;
  const target = await c.db.prepare('SELECT * FROM akun WHERE username=?').bind(username).first();
  if (!target) throw new Gagal('Akun nggak ketemu', 404);
  const diriSendiri = username === c.akun.username;
  if (diriSendiri && (aksi === 'nonaktif' || aksi === 'hapus' || aksi === 'lepas')) throw new Gagal('Kamu nggak bisa ngelakuin itu ke akun kamu sendiri', 409);
  if (aksi === 'reset') {
    const password = String(c.body.password || '');
    if (password.length < 6) throw new Gagal('Password minimal 6 karakter');
    const salt = acak(16);
    await c.db.prepare('UPDATE akun SET hash=?, salt=?, tg_id=CASE WHEN ? THEN tg_id ELSE NULL END WHERE username=?')
      .bind(await hashPassword(password, salt), salt, diriSendiri ? 1 : 0, username).run();
  } else if (aksi === 'lepas') {
    await c.db.prepare('UPDATE akun SET tg_id=NULL WHERE username=?').bind(username).run();
  } else if (aksi === 'nonaktif' || aksi === 'aktif') {
    await c.db.prepare('UPDATE akun SET aktif=? WHERE username=?').bind(aksi === 'aktif' ? 1 : 0, username).run();
  } else if (aksi === 'hapus') {
    await c.db.prepare('DELETE FROM akun WHERE username=?').bind(username).run();
  } else throw new Gagal('Aksi nggak dikenal');
  return {};
}

async function adminTarget(c) {
  const bulan = tanggalWIB(Date.now()).slice(0, 7);
  const bersih = v => (v === '' || v == null ? null : Math.max(0, Math.min(9999, Math.round(Number(v)))));
  const closing = bersih(c.body.closing), kunjungan = bersih(c.body.kunjungan);
  if ((closing != null && !isFinite(closing)) || (kunjungan != null && !isFinite(kunjungan))) throw new Gagal('Target harus berupa angka');
  const sasaran = c.body.semua
    ? (await semua(c.db.prepare(`SELECT username FROM akun WHERE peran='sales' AND aktif=1`))).map(r => r.username)
    : [String(c.body.username || '')];
  const stmts = sasaran.filter(Boolean).map(u => (closing == null && kunjungan == null)
    ? c.db.prepare('DELETE FROM target WHERE username=? AND bulan=?').bind(u, bulan)
    : c.db.prepare('INSERT OR REPLACE INTO target (username,bulan,closing,kunjungan) VALUES (?,?,?,?)').bind(u, bulan, closing, kunjungan));
  if (stmts.length) await c.db.batch(stmts);
  return { jumlah: stmts.length };
}

/* ================= ADMIN: PROGRAM ================= */
async function adminProgram(c) {
  const tgl = tanggalWIB(Date.now());
  const rows = await semua(c.db.prepare('SELECT * FROM program WHERE dihapus=0 ORDER BY selesai DESC LIMIT 40'));
  const out = [];
  for (const p of rows) {
    const b = bentukProgram(p);
    b.status = p.diakhiri || p.selesai < tgl ? 'lewat' : p.mulai > tgl ? 'nanti' : 'aktif';
    if (p.jenis === 'tantangan') Object.assign(b, await progresTantangan(c, p));
    out.push(b);
  }
  return { program: out, hariIni: tgl };
}
async function adminProgramSimpan(c) {
  const b = c.body;
  const nama = String(b.nama || '').trim().slice(0, 50);
  if (!nama) throw new Gagal('Kasih nama programnya dulu');
  const jenis = b.jenis === 'tantangan' ? 'tantangan' : 'bonus';
  const tglOk = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  if (!tglOk(b.mulai) || !tglOk(b.selesai)) throw new Gagal('Tanggal mulai dan selesai wajib diisi');
  if (b.selesai < b.mulai) throw new Gagal('Tanggal selesai nggak boleh sebelum tanggal mulai');
  let kategori, kali = null, target = null, hadiah = null;
  if (jenis === 'bonus') {
    kategori = ['closing', 'kunjungan', 'absen', 'semua'].includes(b.kategori) ? b.kategori : 'closing';
    kali = Number(b.kali);
    if (![1.5, 2, 3].includes(kali)) throw new Gagal('Pilih kelipatan XP-nya');
  } else {
    kategori = b.kategori === 'closing' ? 'closing' : 'kunjungan';
    target = Math.round(Number(b.target)); hadiah = Math.round(Number(b.hadiah));
    if (!(target >= 1 && target <= 100000)) throw new Gagal('Target tantangan minimal 1');
    if (!(hadiah >= 1 && hadiah <= 10000)) throw new Gagal('Hadiah XP minimal 1');
  }
  await c.db.prepare('INSERT INTO program (nama,jenis,kategori,kali,target,hadiah,mulai,selesai,dibuat) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(nama, jenis, kategori, kali, target, hadiah, b.mulai, b.selesai, Date.now()).run();
  let umum = null;
  if (b.umumkan) {
    const label = { closing: 'closing', kunjungan: 'kunjungan', absen: 'absen', semua: 'semua aktivitas' }[kategori];
    const isi = jenis === 'bonus'
      ? `XP ${label} ×${kali} mulai ${tanggalPanjang(b.mulai)} sampai ${tanggalPanjang(b.selesai)}. Gas kejar XP-nya!`
      : `Tantangan tim: ${target} ${kategori} bareng-bareng, ${tanggalPanjang(b.mulai)} sampai ${tanggalPanjang(b.selesai)}. Kalau tercapai, semua sales yang ikut nyumbang dapat +${hadiah} XP!`;
    umum = await kirimPengumuman(c, `🎯 Program baru: ${nama}`, isi, true);
  }
  return Object.assign({ pengumuman: umum }, await adminProgram(c));
}
async function adminProgramAkhiri(c) {
  const id = Number(c.body.id);
  const p = await c.db.prepare('SELECT * FROM program WHERE id=? AND dihapus=0').bind(id).first();
  if (!p) throw new Gagal('Program nggak ketemu', 404);
  if (c.body.hapus) await c.db.prepare('UPDATE program SET dihapus=1 WHERE id=?').bind(id).run();
  else await c.db.prepare('UPDATE program SET diakhiri=? WHERE id=? AND diakhiri IS NULL').bind(Date.now(), id).run();
  return adminProgram(c);
}

/* ================= ADMIN: HADIAH ================= */
async function adminHadiah(c) {
  const [katalog, antre] = await c.db.batch([
    c.db.prepare('SELECT * FROM hadiah WHERE dihapus=0 ORDER BY aktif DESC, harga'),
    c.db.prepare(`SELECT p.*, a.nama AS sales FROM penukaran p LEFT JOIN akun a ON a.username=p.username ORDER BY CASE p.status WHEN 'menunggu' THEN 0 ELSE 1 END, p.waktu DESC LIMIT 60`),
  ]);
  return {
    katalog: katalog.results.map(bentukHadiah),
    penukaran: antre.results.map(p => ({ id: p.id, username: p.username, sales: p.sales || p.username, nama: p.nama_hadiah, harga: p.harga, status: p.status, waktu: p.waktu, diproses: p.diproses })),
  };
}
async function adminHadiahSimpan(c) {
  const b = c.body;
  const nama = String(b.nama || '').trim().slice(0, 60), deskripsi = String(b.deskripsi || '').trim().slice(0, 200);
  const harga = Math.round(Number(b.harga));
  const stok = b.stok === '' || b.stok == null ? null : Math.round(Number(b.stok));
  if (!nama) throw new Gagal('Nama hadiah wajib diisi');
  if (!(harga >= 1 && harga <= 1000000)) throw new Gagal('Harga koin minimal 1');
  if (stok != null && !(stok >= 0 && stok <= 100000)) throw new Gagal('Stok harus angka 0 atau lebih (kosongin kalau nggak terbatas)');
  const aktif = b.aktif === false ? 0 : 1;
  if (b.id) await c.db.prepare('UPDATE hadiah SET nama=?, deskripsi=?, harga=?, stok=?, aktif=? WHERE id=? AND dihapus=0').bind(nama, deskripsi, harga, stok, aktif, Number(b.id)).run();
  else await c.db.prepare('INSERT INTO hadiah (nama,deskripsi,harga,stok,aktif,dibuat) VALUES (?,?,?,?,?,?)').bind(nama, deskripsi, harga, stok, aktif, Date.now()).run();
  return adminHadiah(c);
}
async function adminHadiahHapus(c) {
  await c.db.prepare('UPDATE hadiah SET dihapus=1, aktif=0 WHERE id=?').bind(Number(c.body.id)).run();
  return adminHadiah(c);
}
async function adminPenukaran(c) {
  const id = Number(c.body.id), aksi = c.body.aksi;
  const p = await c.db.prepare(`SELECT p.*, a.tg_id FROM penukaran p LEFT JOIN akun a ON a.username=p.username WHERE p.id=?`).bind(id).first();
  if (!p) throw new Gagal('Penukaran nggak ketemu', 404);
  if (p.status !== 'menunggu') throw new Gagal('Penukaran ini udah diproses', 409);
  const now = Date.now();
  if (aksi === 'selesai') {
    await c.db.prepare(`UPDATE penukaran SET status='selesai', diproses=? WHERE id=?`).bind(now, id).run();
    if (p.tg_id) try { await tg(c.env, 'sendMessage', { chat_id: p.tg_id, text: `🎁 Hadiah kamu udah diproses!\n${p.nama_hadiah} (${p.harga} koin). Selamat ya, terus semangat!` }); } catch (e) {}
  } else if (aksi === 'tolak') {
    await c.db.batch([
      c.db.prepare(`UPDATE penukaran SET status='ditolak', diproses=? WHERE id=?`).bind(now, id),
      c.db.prepare('UPDATE akun SET koin = koin + ? WHERE username=?').bind(p.harga, p.username),
      c.db.prepare('UPDATE hadiah SET stok = stok + 1 WHERE id=? AND stok IS NOT NULL').bind(p.hadiah_id),
    ]);
    if (p.tg_id) try { await tg(c.env, 'sendMessage', { chat_id: p.tg_id, text: `Penukaran ${p.nama_hadiah} belum bisa diproses admin. ${p.harga} koin udah dikembalikan ke akun kamu.` }); } catch (e) {}
  } else throw new Gagal('Aksi nggak dikenal');
  return adminHadiah(c);
}

/* ================= ADMIN: PENGUMUMAN ================= */
async function kirimPengumuman(c, judul, isi, keGrup) {
  const now = Date.now();
  const r = await c.db.prepare('INSERT INTO pengumuman (judul,isi,oleh,waktu) VALUES (?,?,?,?)').bind(judul, isi, c.akun.nama, now).run();
  const penerima = await semua(c.db.prepare(`SELECT tg_id FROM akun WHERE peran='sales' AND aktif=1 AND tg_id IS NOT NULL LIMIT ?`).bind(MAKS_KIRIM_DM));
  const totalSales = angka((await c.db.prepare(`SELECT COUNT(*) AS n FROM akun WHERE peran='sales' AND aktif=1`).first()).n);
  const teksPesan = `📢 ${judul}\n\n${isi}\n\n— ${c.akun.nama}`;
  const hasil = await Promise.allSettled(penerima.map(p => tg(c.env, 'sendMessage', { chat_id: p.tg_id, text: teksPesan.slice(0, 4000) })));
  const terkirim = hasil.filter(h => h.status === 'fulfilled').length;
  let grup = false;
  if (keGrup && c.env.CHAT_ID) { try { await tg(c.env, 'sendMessage', { chat_id: c.env.CHAT_ID, text: teksPesan.slice(0, 4000) }); grup = true; } catch (e) {} }
  const id = r && r.meta && r.meta.last_row_id;
  if (id) await c.db.prepare('UPDATE pengumuman SET terkirim=? WHERE id=?').bind(terkirim, id).run();
  return { terkirim, totalSales, grup };
}
async function adminPengumuman(c) {
  const rows = await semua(c.db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM baca b WHERE b.pengumuman_id=p.id) AS dibaca FROM pengumuman p WHERE dihapus=0 ORDER BY waktu DESC LIMIT 30`));
  return { pengumuman: rows.map(p => ({ id: p.id, judul: p.judul, isi: p.isi, oleh: p.oleh, waktu: p.waktu, terkirim: p.terkirim, dibaca: angka(p.dibaca) })) };
}
async function adminPengumumanKirim(c) {
  const judul = String(c.body.judul || '').trim().slice(0, 80), isi = String(c.body.isi || '').trim().slice(0, 1500);
  if (!judul) throw new Gagal('Judul pengumuman wajib diisi');
  if (!isi) throw new Gagal('Isi pengumuman wajib diisi');
  const hasil = await kirimPengumuman(c, judul, isi, !!c.body.keGrup);
  return Object.assign({ hasil }, await adminPengumuman(c));
}
async function adminPengumumanHapus(c) {
  await c.db.prepare('UPDATE pengumuman SET dihapus=1 WHERE id=?').bind(Number(c.body.id)).run();
  return adminPengumuman(c);
}

/* ================= ADMIN: LAPORAN EXCEL ================= */
async function adminExcel(c) {
  const hariIni = tanggalWIB(Date.now()), periode = c.body.periode;
  let dari = hariIni, sampai = hariIni, label = 'Hari ini';
  if (periode === '7hari') { dari = mundur(hariIni, 6); label = '7 hari terakhir'; }
  else if (periode === 'bulan') { dari = hariIni.slice(0, 8) + '01'; label = 'Bulan ini'; }
  else if (periode === 'bulanlalu') { sampai = mundur(hariIni.slice(0, 8) + '01', 1); dari = sampai.slice(0, 8) + '01'; label = 'Bulan lalu'; }
  const bulanTarget = sampai.slice(0, 7);
  const [sales, ab, kj, xp, tgt] = await c.db.batch([
    c.db.prepare(`SELECT username, nama FROM akun WHERE peran='sales' ORDER BY nama COLLATE NOCASE`),
    c.db.prepare('SELECT a.*, k.nama AS sales FROM absen a LEFT JOIN akun k ON k.username=a.username WHERE a.tanggal BETWEEN ? AND ? ORDER BY a.tanggal, sales').bind(dari, sampai),
    c.db.prepare('SELECT v.*, k.nama AS sales FROM kunjungan v LEFT JOIN akun k ON k.username=v.username WHERE v.tanggal BETWEEN ? AND ? ORDER BY v.waktu').bind(dari, sampai),
    c.db.prepare('SELECT username, SUM(xp) AS n FROM xp_log WHERE tanggal BETWEEN ? AND ? GROUP BY username').bind(dari, sampai),
    c.db.prepare('SELECT * FROM target WHERE bulan=?').bind(bulanTarget),
  ]);
  const ringkas = sales.results.map(s => {
    const masuk = ab.results.filter(r => r.username === s.username && r.jenis === 'masuk');
    const tepat = masuk.filter(r => menitWIB(r.waktu) <= SHIFT_MULAI).length;
    const rata = masuk.length ? Math.round(masuk.reduce((t, r) => t + menitWIB(r.waktu), 0) / masuk.length) : null;
    const v = kj.results.filter(r => r.username === s.username);
    const closing = v.filter(r => r.status === 'closing').length;
    const t = tgt.results.find(x => x.username === s.username);
    const x = xp.results.find(r => r.username === s.username);
    return [s.nama, s.username, masuk.length, tepat, masuk.length - tepat, rata == null ? '' : `${pad(Math.floor(rata / 60))}.${pad(rata % 60)}`,
      v.length, v.filter(r => r.status === 'tertarik').length, closing, v.length ? Math.round(closing / v.length * 1000) / 10 : 0,
      x ? angka(x.n) : 0, t && t.closing != null ? t.closing : '', t && t.closing ? Math.round(closing / t.closing * 1000) / 10 : ''];
  });
  const absensi = [];
  const kunciHari = new Set(ab.results.map(r => r.tanggal + '|' + r.username));
  for (const k of kunciHari) {
    const [tgl, u] = k.split('|');
    const m = ab.results.find(r => r.tanggal === tgl && r.username === u && r.jenis === 'masuk');
    const p = ab.results.find(r => r.tanggal === tgl && r.username === u && r.jenis === 'pulang');
    const nama = (m || p).sales || u;
    const mm = m ? menitWIB(m.waktu) : null;
    absensi.push([tgl, nama, m ? jamWIB(m.waktu) : '', m ? (mm <= SHIFT_MULAI ? 'Tepat waktu' : `Telat ${durasi(mm - SHIFT_MULAI)}`) : 'Tidak absen masuk',
      p ? jamWIB(p.waktu) : '', m && p ? durasi(Math.round((p.waktu - m.waktu) / 60000)) : '',
      m && m.lat != null ? `https://maps.google.com/?q=${m.lat},${m.lng}` : '']);
  }
  absensi.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  const kunjungan = kj.results.map(r => [r.tanggal, jamWIB(r.waktu), r.sales || r.username, r.nama, r.hp || '', r.alamat || '', STATUS[r.status] ? STATUS[r.status].label : r.status, r.paket || '', r.catatan || '', r.lat != null ? `https://maps.google.com/?q=${r.lat},${r.lng}` : '']);
  const file = buatXlsx([
    { nama: 'Ringkasan', kolom: [['Nama sales', 22], ['Username', 14], ['Hari hadir', 11], ['Tepat waktu', 12], ['Telat', 8], ['Rata-rata jam masuk', 18], ['Kunjungan', 11], ['Tertarik', 10], ['Closing', 9], ['Konversi (%)', 12], ['XP periode', 11], ['Target closing', 14], ['Capaian target (%)', 18]], baris: ringkas },
    { nama: 'Absensi', kolom: [['Tanggal', 12], ['Nama sales', 22], ['Jam masuk', 11], ['Status', 18], ['Jam pulang', 11], ['Durasi kerja', 13], ['Lokasi masuk', 40]], baris: absensi },
    { nama: 'Kunjungan', kolom: [['Tanggal', 12], ['Jam', 8], ['Nama sales', 22], ['Calon pelanggan', 24], ['No. HP', 15], ['Alamat', 30], ['Hasil', 14], ['Paket', 11], ['Catatan', 40], ['Peta', 40]], baris: kunjungan },
  ]);
  const namaFile = `Laporan Sales Quest ${dari === sampai ? dari : dari + ' sd ' + sampai}.xlsx`;
  const fd = new FormData();
  fd.append('chat_id', String(c.tg.id));
  fd.append('caption', `📊 Laporan Sales Quest\n${label}: ${tanggalPanjang(dari)}${dari === sampai ? '' : ' – ' + tanggalPanjang(sampai)}\n${sales.results.length} sales · ${absensi.length} hari absen · ${kunjungan.length} kunjungan`);
  fd.append('document', file, namaFile);
  try { await tg(c.env, 'sendDocument', fd); }
  catch (e) {
    if (/initiate|blocked|chat not found|403/i.test(e.message)) {
      let bot = 'bot ini';
      try { const me = await tg(c.env, 'getMe', {}); bot = '@' + me.result.username; } catch (err) {}
      throw new Gagal(`Bot belum bisa kirim file ke kamu. Buka chat ${bot}, ketuk Start, lalu coba lagi.`, 409, 'TULIS');
    }
    throw e;
  }
  return { namaFile, baris: { absensi: absensi.length, kunjungan: kunjungan.length } };
}

/* ---------- Penulis file Excel (.xlsx) kecil tanpa library ---------- */
function xmlEsc(s) {
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
function hurufKolom(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
function sheetXml(sh) {
  const sel = (v, ref, gaya) => {
    const s = gaya ? ` s="${gaya}"` : '';
    if (v == null || v === '') return `<c r="${ref}"${s}/>`;
    if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  };
  const baris = [`<row r="1">${sh.kolom.map((k, i) => sel(k[0], hurufKolom(i) + 1, 1)).join('')}</row>`];
  sh.baris.forEach((b, ri) => { const r = ri + 2; baris.push(`<row r="${r}">${b.map((v, i) => sel(v, hurufKolom(i) + r, 0)).join('')}</row>`); });
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + `<cols>${sh.kolom.map((k, i) => `<col min="${i + 1}" max="${i + 1}" width="${k[1]}" customWidth="1"/>`).join('')}</cols>`
    + `<sheetData>${baris.join('')}</sheetData></worksheet>`;
}
function buatXlsx(sheets) {
  const NS = 'http://schemas.openxmlformats.org';
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="${NS}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.nama)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS}/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${NS}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${NS}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="${NS}/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF15353B"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
  return zipSimpan(files.map(([nama, isi]) => ({ nama, data: enc.encode(isi) })), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}
const CRC_TABEL = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABEL[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zipSimpan(files, mime) {
  const bagian = [], pusat = [];
  let offset = 0;
  const d = new Date(Date.now() + WIB);
  const waktuDos = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const tanggalDos = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  for (const f of files) {
    const nama = enc.encode(f.nama), crc = crc32(f.data), ukuran = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, waktuDos, true); lh.setUint16(12, tanggalDos, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, ukuran, true); lh.setUint32(22, ukuran, true); lh.setUint16(26, nama.length, true); lh.setUint16(28, 0, true);
    bagian.push(new Uint8Array(lh.buffer), nama, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, waktuDos, true); ch.setUint16(14, tanggalDos, true); ch.setUint32(16, crc, true); ch.setUint32(20, ukuran, true); ch.setUint32(24, ukuran, true);
    ch.setUint16(28, nama.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
    ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
    pusat.push(new Uint8Array(ch.buffer), nama);
    offset += 30 + nama.length + ukuran;
  }
  const ukuranPusat = pusat.reduce((s, p) => s + p.length, 0);
  const akhir = new DataView(new ArrayBuffer(22));
  akhir.setUint32(0, 0x06054b50, true); akhir.setUint16(8, files.length, true); akhir.setUint16(10, files.length, true);
  akhir.setUint32(12, ukuranPusat, true); akhir.setUint32(16, offset, true);
  return new Blob([...bagian, ...pusat, new Uint8Array(akhir.buffer)], { type: mime });
}

async function foto(c, cors) {
  const akun = await akunAktif(c);
  const id = String(c.body.id || '');
  if (!id) throw new Gagal('Foto nggak ada');
  if (akun.peran !== 'admin') {
    const milik = await c.db.prepare('SELECT 1 FROM absen WHERE foto=? AND username=? UNION SELECT 1 FROM kunjungan WHERE foto=? AND username=?').bind(id, akun.username, id, akun.username).first();
    if (!milik) throw new Gagal('Foto ini bukan punya kamu', 403);
  }
  const info = await tg(c.env, 'getFile', { file_id: id });
  const res = await fetch(`https://api.telegram.org/file/bot${c.env.BOT_TOKEN}/${info.result.file_path}`);
  if (!res.ok) throw new Gagal('Foto gagal diambil dari Telegram', 502);
  return new Response(res.body, { headers: Object.assign({}, cors, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }) });
}

/* ================= TELEGRAM ================= */
async function tg(env, method, payload) {
  const form = payload instanceof FormData;
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: form ? {} : { 'Content-Type': 'application/json' },
    body: form ? payload : JSON.stringify(payload),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Gagal('Bot gagal kirim: ' + (j.description || `Telegram ${res.status}`), 502);
  return j;
}
function wajibChat(env) { if (!env.CHAT_ID) throw new Gagal('ID grup laporan (CHAT_ID) belum diisi', 500); return env.CHAT_ID; }
async function kirimFoto(env, foto, caption) {
  const chat = wajibChat(env);
  if (foto) {
    const fd = new FormData();
    fd.append('chat_id', chat);
    fd.append('caption', caption.slice(0, 1024));
    fd.append('photo', dataUrlKeBlob(foto), 'foto.jpg');
    return tg(env, 'sendPhoto', fd);
  }
  return tg(env, 'sendMessage', { chat_id: chat, text: caption });
}
const fotoId = msg => { const p = msg && msg.result && msg.result.photo; return p && p.length ? p[p.length - 1].file_id : null; };
function dataUrlKeBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(',');
  const mime = (meta.match(/data:(.*?);/) || [])[1] || 'image/jpeg';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
function cekFoto(f, wajib) {
  if (!f) { if (wajib) throw new Gagal('Selfie wajib diisi'); return null; }
  if (typeof f !== 'string' || !f.startsWith('data:image/') || f.length > 2000000) throw new Gagal('Format foto nggak didukung');
  return f;
}
function cekLokasi(d) {
  const lat = Number(d.lat), lng = Number(d.lng);
  if (d.lat == null || !isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { lat: null, lng: null, acc: null };
  return { lat, lng, acc: isFinite(Number(d.acc)) ? Math.round(Number(d.acc)) : null };
}
function barisLokasi(l) {
  if (l.lat == null) return '📍 Lokasi nggak kebaca';
  return `📍 ${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}${l.acc ? ` (±${l.acc} m)` : ''}`;
}
const namaTg = u => [u.first_name, u.last_name].filter(Boolean).join(' ') + (u.username ? ` (@${u.username})` : '');
const labelSales = a => a.tg_nama && /@/.test(a.tg_nama) ? `${a.nama} (${a.tg_nama.match(/@[^)]+/)[0]})` : a.nama;

async function cariGrup(env) {
  if (!env.BOT_TOKEN) return teks('Isi BOT_TOKEN dulu di Settings → Variables and Secrets.');
  let j;
  try { j = await tg(env, 'getUpdates', {}); } catch (e) { return teks('Gagal tanya ke Telegram: ' + e.message); }
  const grup = new Map();
  for (const u of j.result || []) {
    const ch = (u.my_chat_member || u.message || u.channel_post || {}).chat;
    if (ch && ch.type !== 'private') grup.set(ch.id, ch.title || '(tanpa nama)');
  }
  if (!grup.size) return teks('Belum ada grup.\n\nMasukkan bot ke grup, kirim /start@username_bot_kamu di grup itu, lalu refresh halaman ini.');
  return teks('Grup yang ketemu:\n\n' + [...grup].map(([id, t]) => `${t}\nCHAT_ID: ${id}`).join('\n\n'));
}

// Cek tanda tangan initData sesuai aturan resmi Telegram (HMAC-SHA256)
async function cekInitData(initData, token) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const k1 = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const rahasia = await crypto.subtle.sign('HMAC', k1, enc.encode(token));
  const k2 = await crypto.subtle.importKey('raw', rahasia, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  if (hex(await crypto.subtle.sign('HMAC', k2, enc.encode(dataCheck))) !== hash) return null;
  if (Date.now() / 1000 - Number(params.get('auth_date') || 0) > 86400) return null; // sesi > 24 jam: buka ulang app
  try { return JSON.parse(params.get('user')); } catch (e) { return null; }
}

/* ================= KECIL-KECIL ================= */
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
function acak(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return hex(b); }
async function hashPassword(password, salt) {
  const kunci = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 10000 }, kunci, 256));
}
const WIB = 7 * 3600 * 1000;
const pad = n => String(n).padStart(2, '0');
function tanggalWIB(t) { const d = new Date(t + WIB); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function jamWIB(t) { const d = new Date(t + WIB); return `${pad(d.getUTCHours())}.${pad(d.getUTCMinutes())}`; }
function menitWIB(t) { const d = new Date(t + WIB); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
function mundur(tgl, n) { const d = new Date(tgl + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }
function hariDalamMinggu(tgl) { return new Date(tgl + 'T00:00:00Z').getUTCDay(); }
const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
function tanggalPanjang(tgl) { const d = new Date(tgl + 'T00:00:00Z'); return `${HARI[d.getUTCDay()]}, ${d.getUTCDate()} ${BULAN[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }
function durasi(m) { const h = Math.floor(m / 60), s = m % 60; return h ? `${h} j ${s} mnt` : `${s} mnt`; }
function teks(s) { return new Response(s, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }
function json(o, status, headers) { return new Response(JSON.stringify(o), { status, headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }) }); }

/* =====================================================================
 * KUIS META ADS — seleksi SF digital
 * Peserta masuk pakai kode akses (tanpa Telegram). Admin = akun admin Sales Quest (lewat Telegram).
 * Soal + kunci jawaban disimpan di database, nggak pernah dikirim ke peserta.
 * ===================================================================== */
const KUIS_URL = 'https://dhevvlibra.github.io/salesaccess/kuis.html';
const KUIS_HURUF = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const KUIS_TENGGANG = 90 * 1000; // toleransi sinyal setelah waktu habis
const KUIS_ATUR_AWAL = { judul: 'Ujian Meta Ads', subjudul: 'Seleksi SF Digital', durasi: 30, kkm: 75, jumlahSoal: 0, buka: true, tampilNilai: true, kabariAdmin: true, linkMiniApp: false, daftarBot: true, topupAktif: true, nominalTopup: 0, modelAi: 'openrouter/free', petunjuk: '' };
const KUIS_JENIS = { pilihan: 'Studi kasus', banyak: 'Pilih beberapa', data: 'Baca data', esai: 'Esai singkat' };
const KUIS_CARA = { kirim: 'Dikirim peserta', waktu: 'Waktu habis', admin: 'Diakhiri admin' };

function tabelKuis(db) {
  return [
    db.prepare(`CREATE TABLE IF NOT EXISTS kuis_soal (
      id TEXT PRIMARY KEY, urut INTEGER NOT NULL DEFAULT 0, jenis TEXT NOT NULL, topik TEXT, poin REAL NOT NULL,
      konteks TEXT, teks TEXT NOT NULL, tabel TEXT, opsi TEXT, penjelasan TEXT, rubrik TEXT,
      aktif INTEGER NOT NULL DEFAULT 1, diubah INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kuis_kode (
      kode TEXT PRIMARY KEY, nama TEXT NOT NULL, ket TEXT, dibuat INTEGER NOT NULL, oleh TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kuis_ujian (
      kode TEXT PRIMARY KEY, token TEXT NOT NULL, mulai INTEGER NOT NULL, batas INTEGER NOT NULL,
      selesai INTEGER, alasan TEXT, urutan TEXT NOT NULL, jawaban TEXT NOT NULL DEFAULT '{}',
      ragu TEXT NOT NULL DEFAULT '[]', esai TEXT NOT NULL DEFAULT '{}', disimpan INTEGER,
      skor_auto REAL, maks_auto REAL, skor_esai REAL, maks_esai REAL, esai_belum INTEGER, nilai REAL,
      sesi INTEGER NOT NULL DEFAULT 1, perangkat TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kuis_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kode TEXT NOT NULL, eid TEXT, waktu INTEGER NOT NULL,
      jenis TEXT NOT NULL, detik INTEGER, ket TEXT)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS kuis_log_kode ON kuis_log(kode, waktu)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS kuis_log_eid ON kuis_log(kode, eid)`),
  ];
}

/* ---------- Rute ---------- */
async function jalankanKuis(rute, c) {
  switch (rute) {
    case 'kuis/masuk': return kuisMasuk(c);
    case 'kuis/mulai': return kuisMulai(c);
    case 'kuis/simpan': return kuisSimpan(c, false);
    case 'kuis/kirim': return kuisSimpan(c, true);
  }
  throw new Gagal('Perintah tidak dikenal', 404);
}
async function jalankanKuisAdmin(rute, c) {
  switch (rute) {
    case 'kuis/admin/ringkas': return kuisAdminRingkas(c);
    case 'kuis/admin/detail': return kuisAdminDetail(c);
    case 'kuis/admin/nilai-esai': return kuisAdminNilaiEsai(c);
    case 'kuis/admin/akhiri': return kuisAdminAkhiri(c);
    case 'kuis/admin/kode-buat': return kuisAdminKodeBuat(c);
    case 'kuis/admin/kode-ubah': return kuisAdminKodeUbah(c);
    case 'kuis/admin/kode-ulang': return kuisAdminKodeUlang(c);
    case 'kuis/admin/kode-hapus': return kuisAdminKodeHapus(c);
    case 'kuis/admin/soal': return kuisAdminSoal(c);
    case 'kuis/admin/soal-simpan': return kuisAdminSoalSimpan(c);
    case 'kuis/admin/soal-hapus': return kuisAdminSoalHapus(c);
    case 'kuis/admin/soal-bawaan': return kuisAdminSoalBawaan(c);
    case 'kuis/admin/soal-ai': return kuisAdminSoalAi(c);
    case 'kuis/admin/analisis': return kuisAdminAnalisis(c);
    case 'kuis/admin/atur': return kuisAdminAtur(c);
    case 'kuis/admin/excel': return kuisAdminExcel(c);
    case 'kuis/admin/daftar-setuju': return kuisAdminDaftarSetuju(c);
    case 'kuis/admin/daftar-tolak': return kuisAdminDaftarTolak(c);
    case 'kuis/admin/topup-proses': return kuisAdminTopupProses(c);
    case 'kuis/admin/topup-minta': return kuisAdminTopupMinta(c);
  }
  throw new Gagal('Perintah tidak dikenal', 404);
}

/* ---------- Bantuan ---------- */
const kuisNormalKode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const tampilKode = k => (k && k.length === 6 ? k.slice(0, 3) + '-' + k.slice(3) : k);
const bulat1 = n => Math.round(Number(n || 0) * 10) / 10;
const bulat2 = n => Math.round(Number(n || 0) * 100) / 100;
const fmtPoin = n => String(bulat1(n)).replace('.', ',');
const waktuWIB = t => (t ? `${tanggalWIB(t)} ${jamWIB(t)}` : '');
const jsonAman = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };
function kodeAcak() {
  const b = new Uint8Array(6); crypto.getRandomValues(b);
  return [...b].map(x => KUIS_HURUF[x % KUIS_HURUF.length]).join('');
}
function kocok(arr) {
  const a = arr.slice(), r = new Uint32Array(Math.max(1, a.length)); crypto.getRandomValues(r);
  for (let i = a.length - 1; i > 0; i--) { const j = r[i] % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

async function kuisAtur(c) {
  const r = await c.db.prepare(`SELECT v FROM meta WHERE k='kuis_atur'`).first();
  return Object.assign({}, KUIS_ATUR_AWAL, jsonAman(r && r.v, {}));
}
function bentukSoal(r) {
  return {
    id: r.id, urut: r.urut, jenis: r.jenis, topik: r.topik || '', poin: Number(r.poin), konteks: r.konteks || '', teks: r.teks,
    tabel: jsonAman(r.tabel, null), opsi: jsonAman(r.opsi, []) || [], penjelasan: r.penjelasan || '', rubrik: jsonAman(r.rubrik, []) || [],
    aktif: !!r.aktif, diubah: r.diubah, sumber: r.sumber || null,
  };
}
async function bankSoal(c) { return (await semua(c.db.prepare('SELECT * FROM kuis_soal ORDER BY urut, id'))).map(bentukSoal); }
const petaBank = bank => new Map(bank.map(s => [s.id, s]));

function infoUjian(atur, bank) {
  const aktif = bank.filter(s => s.aktif);
  const perJenis = {};
  for (const s of aktif) perJenis[s.jenis] = (perJenis[s.jenis] || 0) + 1;
  const n = Number(atur.jumlahSoal) || 0, acak = n > 0 && n < aktif.length;
  return {
    judul: atur.judul, subjudul: atur.subjudul, durasi: atur.durasi, kkm: atur.kkm, petunjuk: atur.petunjuk || '',
    jumlah: acak ? n : aktif.length, bank: aktif.length, acak, perJenis, poin: acak ? null : bulat1(aktif.reduce((t, s) => t + s.poin, 0)), tampilNilai: !!atur.tampilNilai,
  };
}

// Urutan soal tiap peserta: pilihan ganda diacak, esai di akhir (ikut diacak). Pilihan jawaban juga diacak.
function susunUrutan(bank, n) {
  let pilih = bank.filter(s => s.aktif);
  n = Number(n) || 0;
  if (n > 0 && n < pilih.length) {
    // Ambil acak tapi merata per topik: giliran dari tiap topik sampai jumlahnya pas
    const grup = new Map();
    for (const s of kocok(pilih)) { const t = s.topik || '-'; if (!grup.has(t)) grup.set(t, []); grup.get(t).push(s); }
    const antre = kocok([...grup.values()]), ambil = [];
    while (ambil.length < n) for (const g of antre) { if (ambil.length >= n) break; if (g.length) ambil.push(g.shift()); }
    pilih = ambil;
  }
  const biasa = kocok(pilih.filter(s => s.jenis !== 'esai')), esai = kocok(pilih.filter(s => s.jenis === 'esai'));
  return [...biasa, ...esai].map(s => (s.jenis === 'esai' ? { id: s.id } : { id: s.id, opsi: kocok(s.opsi.map(o => o.id)) }));
}
// Urutan pilihan yang dilihat peserta (tetap aman kalau admin ngedit pilihan di tengah ujian)
function opsiUrut(it, s) {
  const ada = new Set(s.opsi.map(o => o.id));
  const urut = (it.opsi || []).filter(id => ada.has(id));
  for (const o of s.opsi) if (!urut.includes(o.id)) urut.push(o.id);
  return urut;
}

function skorSoal(s, j) {
  if (s.jenis === 'esai' || j == null) return 0;
  if (s.jenis === 'banyak') {
    if (!Array.isArray(j) || !j.length) return 0;
    const benar = new Set(s.opsi.filter(o => o.benar).map(o => o.id));
    if (!benar.size) return 0;
    const tepat = j.filter(id => benar.has(id)).length, keliru = j.filter(id => !benar.has(id)).length;
    return bulat2(s.poin * Math.max(0, (tepat - keliru) / benar.size)); // salah pilih ngurangin, minimal 0
  }
  const kunci = s.opsi.find(o => o.benar);
  return kunci && j === kunci.id ? s.poin : 0;
}

function nilaiUjian(u, bank) {
  const urutan = jsonAman(u.urutan, []), jaw = jsonAman(u.jawaban, {}), esai = jsonAman(u.esai, {});
  let auto = 0, autoMaks = 0, es = 0, esMaks = 0, esBelum = 0;
  for (const it of urutan) {
    const s = bank.get(it.id); if (!s) continue;
    const j = jaw[s.id];
    if (s.jenis === 'esai') {
      esMaks += s.poin;
      const g = esai[s.id];
      if (g && g.skor != null) es += Math.min(s.poin, Number(g.skor));
      else if (j && String(j).trim()) esBelum++; // kosong = 0, nggak perlu dinilai
      continue;
    }
    autoMaks += s.poin; auto += skorSoal(s, j);
  }
  const maks = autoMaks + esMaks;
  return { auto: bulat2(auto), autoMaks: bulat2(autoMaks), esai: bulat2(es), esaiMaks: bulat2(esMaks), esaiBelum: esBelum, nilai: maks ? bulat1((auto + es) / maks * 100) : 0 };
}
const barisNilai = (kode, n) => ({ k: kode, a: n.auto, am: n.autoMaks, e: n.esai, em: n.esaiMaks, b: n.esaiBelum, v: n.nilai });
// Simpan nilai banyak peserta sekaligus dalam 1 perintah (hemat kuota query akun gratis)
function stmtNilai(c, daftar, setLain = '', whereLain = '') {
  const ambil = f => `(SELECT ${f} FROM hn WHERE hn.k = kuis_ujian.kode)`;
  return c.db.prepare(`WITH hn AS (SELECT json_extract(value,'$.k') AS k, json_extract(value,'$.a') AS a, json_extract(value,'$.am') AS am,
      json_extract(value,'$.e') AS e, json_extract(value,'$.em') AS em, json_extract(value,'$.b') AS b, json_extract(value,'$.v') AS v FROM json_each(?))
    UPDATE kuis_ujian SET skor_auto=${ambil('a')}, maks_auto=${ambil('am')}, skor_esai=${ambil('e')}, maks_esai=${ambil('em')},
      esai_belum=${ambil('b')}, nilai=${ambil('v')}${setLain}
    WHERE kode IN (SELECT k FROM hn)${whereLain}`).bind(JSON.stringify(daftar));
}
async function hitungUlangSemua(c, bank) {
  const peta = petaBank(bank || await bankSoal(c));
  const rows = await semua(c.db.prepare('SELECT kode, urutan, jawaban, esai FROM kuis_ujian WHERE selesai IS NOT NULL'));
  if (rows.length) await stmtNilai(c, rows.map(u => barisNilai(u.kode, nilaiUjian(u, peta)))).run();
}

async function ambilKode(c, mentah) {
  const kode = kuisNormalKode(mentah);
  if (kode.length !== 6) throw new Gagal('Kode akses harus 6 karakter');
  const k = await c.db.prepare('SELECT * FROM kuis_kode WHERE kode=?').bind(kode).first();
  if (!k) throw new Gagal('Kode akses nggak ditemukan. Cek lagi hurufnya ya.', 404);
  return k;
}
const ambilUjian = (c, kode) => c.db.prepare('SELECT * FROM kuis_ujian WHERE kode=?').bind(kode).first();
async function rapikanUjian(c, u, k) {
  if (u && !u.selesai && Date.now() > u.batas + KUIS_TENGGANG) return selesaikanUjian(c, u, 'waktu', k);
  return u;
}
async function selesaikanUjian(c, u, alasan, k) {
  const bank = petaBank(await bankSoal(c));
  const now = Date.now();
  const waktu = alasan === 'waktu' ? u.batas : Math.min(now, u.batas);
  const n = nilaiUjian(u, bank);
  const r = await c.db.prepare(`UPDATE kuis_ujian SET selesai=?, alasan=?, skor_auto=?, maks_auto=?, skor_esai=?, maks_esai=?, esai_belum=?, nilai=? WHERE kode=? AND selesai IS NULL`)
    .bind(waktu, alasan, n.auto, n.autoMaks, n.esai, n.esaiMaks, n.esaiBelum, n.nilai, u.kode).run();
  if (r.meta && r.meta.changes) {
    await c.db.prepare('INSERT INTO kuis_log (kode,waktu,jenis,ket) VALUES (?,?,?,?)').bind(u.kode, waktu, alasan, c.akun ? c.akun.nama : null).run();
  }
  const baru = await ambilUjian(c, u.kode);
  if (r.meta && r.meta.changes && alasan !== 'admin') kabariSelesai(c, k, baru);
  if (r.meta && r.meta.changes) await mintaTopup(c, u.kode).catch(() => {});
  return baru;
}
// Tutup semua ujian yang waktunya udah lewat (dipanggil dari halaman admin)
async function tutupKedaluwarsa(c) {
  const ambang = Date.now() - KUIS_TENGGANG;
  const rows = await semua(c.db.prepare('SELECT * FROM kuis_ujian WHERE selesai IS NULL AND batas < ?').bind(ambang));
  if (!rows.length) return 0;
  const peta = petaBank(await bankSoal(c));
  const daftar = rows.map(u => barisNilai(u.kode, nilaiUjian(u, peta)));
  await c.db.batch([
    c.db.prepare(`INSERT INTO kuis_log (kode,waktu,jenis) SELECT kode, batas, 'waktu' FROM kuis_ujian WHERE selesai IS NULL AND batas < ? AND kode IN (SELECT json_extract(value,'$.k') FROM json_each(?))`).bind(ambang, JSON.stringify(daftar)),
    stmtNilai(c, daftar, `, selesai=batas, alasan='waktu'`, ' AND selesai IS NULL'),
  ]);
  for (const x of daftar.filter(x => !x.b).slice(0, 10)) await mintaTopup(c, x.k).catch(() => {});
  return rows.length;
}

function kabariSelesai(c, k, u) {
  const kerja = (async () => {
    try {
      if (!c.env.BOT_TOKEN || !u) return;
      const atur = await kuisAtur(c);
      if (!atur.kabariAdmin) return;
      k = k || await c.db.prepare('SELECT * FROM kuis_kode WHERE kode=?').bind(u.kode).first();
      const admin = await semua(c.db.prepare(`SELECT tg_id FROM akun WHERE peran='admin' AND aktif=1 AND tg_id IS NOT NULL LIMIT 5`));
      if (!k || !admin.length) return;
      const lulus = u.nilai >= atur.kkm;
      const teksPesan = [
        `📝 ${k.nama} selesai ${atur.judul}`,
        `Kode ${tampilKode(k.kode)} · ${u.alasan === 'waktu' ? 'waktu habis' : 'dikirim sendiri'}`,
        `Pilihan ganda: ${fmtPoin(u.skor_auto)} dari ${fmtPoin(u.maks_auto)} poin`,
        u.esai_belum ? `✍️ ${u.esai_belum} jawaban esai nunggu kamu nilai` : `Nilai akhir: ${fmtPoin(u.nilai)} ${lulus ? '✅ LULUS' : '❌ belum lulus'} (KKM ${atur.kkm})`,
      ].join('\n');
      const tombol = { inline_keyboard: [[{ text: u.esai_belum ? '✍️ Nilai esai' : '🔎 Lihat jawaban', web_app: { url: `${KUIS_URL}?peserta=${k.kode}` } }]] };
      for (const a of admin) {
        try { await tg(c.env, 'sendMessage', { chat_id: a.tg_id, text: teksPesan, reply_markup: tombol }); }
        catch (e) { try { await tg(c.env, 'sendMessage', { chat_id: a.tg_id, text: teksPesan }); } catch (err) {} }
      }
    } catch (e) {}
  })();
  if (c.ctx && c.ctx.waitUntil) c.ctx.waitUntil(kerja);
}

/* ---------- Peserta ---------- */
function hasilPeserta(u, atur) {
  const urutan = jsonAman(u.urutan, []), jaw = jsonAman(u.jawaban, {});
  const h = {
    selesai: u.selesai, alasan: u.alasan, jumlah: urutan.length, terjawab: urutan.filter(it => jaw[it.id] != null).length,
    lama: Math.max(0, Math.round((u.selesai - u.mulai) / 1000)), tampil: !!atur.tampilNilai,
  };
  if (!atur.tampilNilai) return h;
  return Object.assign(h, {
    kkm: atur.kkm, pg: { skor: u.skor_auto, maks: u.maks_auto }, esai: { skor: u.skor_esai, maks: u.maks_esai, belum: u.esai_belum },
    dinilai: !u.esai_belum, nilai: u.esai_belum ? null : u.nilai, lulus: u.esai_belum ? null : u.nilai >= atur.kkm,
  });
}
const pesertaDari = k => ({ nama: k.nama, kode: k.kode });

async function kuisMasuk(c) {
  const k = await ambilKode(c, c.body.kode);
  const atur = await kuisAtur(c);
  const u = await rapikanUjian(c, await ambilUjian(c, k.kode), k);
  if (u && u.selesai) return { status: 'selesai', peserta: pesertaDari(k), hasil: hasilPeserta(u, atur), sekarang: Date.now() };
  const ujian = infoUjian(atur, await bankSoal(c));
  if (u) return { status: 'jalan', peserta: pesertaDari(k), ujian, sisa: Math.max(0, u.batas - Date.now()), sekarang: Date.now() };
  if (!ujian.jumlah) throw new Gagal('Soal ujiannya belum disiapin admin. Coba lagi nanti ya.', 409);
  return { status: 'baru', peserta: pesertaDari(k), ujian, buka: !!atur.buka, sekarang: Date.now() };
}

async function kuisMulai(c) {
  if (c.initData) { // dibuka dari Telegram: kalau itu akun admin, tolak
    for (const t of c.tokenTg || []) {
      const u = await cekInitData(c.initData, t);
      if (!u) continue;
      if (await c.db.prepare(`SELECT 1 FROM akun WHERE tg_id=? AND peran='admin' AND aktif=1`).bind(String(u.id)).first()) throw new Gagal('Akun admin nggak bisa ikut ujian 😎', 403);
      break;
    }
  }
  const k = await ambilKode(c, c.body.kode);
  const atur = await kuisAtur(c);
  let u = await rapikanUjian(c, await ambilUjian(c, k.kode), k);
  if (u && u.selesai) return { status: 'selesai', peserta: pesertaDari(k), hasil: hasilPeserta(u, atur), sekarang: Date.now() };
  const bank = await bankSoal(c);
  const perangkat = String(c.body.perangkat || '').slice(0, 160);
  const token = acak(16), now = Date.now();
  let baru = false;
  if (!u) {
    if (!atur.buka) throw new Gagal('Ujian lagi ditutup admin. Tunggu info selanjutnya ya.', 403);
    const urutan = susunUrutan(bank, atur.jumlahSoal);
    if (!urutan.length) throw new Gagal('Soal ujiannya belum disiapin admin. Coba lagi nanti ya.', 409);
    const r = await c.db.prepare(`INSERT OR IGNORE INTO kuis_ujian (kode,token,mulai,batas,urutan,perangkat) VALUES (?,?,?,?,?,?)`)
      .bind(k.kode, token, now, now + atur.durasi * 60000, JSON.stringify(urutan), perangkat).run();
    baru = !!r.meta.changes;
    if (baru) await c.db.prepare(`INSERT INTO kuis_log (kode,waktu,jenis,ket) VALUES (?,?,'mulai',?)`).bind(k.kode, now, perangkat || null).run();
    u = await ambilUjian(c, k.kode);
  }
  if (!baru) { // lanjut (app ketutup / pindah HP): sesi lama otomatis nggak berlaku
    await c.db.batch([
      c.db.prepare('UPDATE kuis_ujian SET token=?, sesi=sesi+1, perangkat=? WHERE kode=? AND selesai IS NULL').bind(token, perangkat, k.kode),
      c.db.prepare(`INSERT INTO kuis_log (kode,waktu,jenis,ket) VALUES (?,?,?,?)`).bind(k.kode, now, u.perangkat && perangkat && u.perangkat !== perangkat ? 'pindah' : 'lanjut', perangkat || null),
    ]);
    u = await ambilUjian(c, k.kode);
  }
  return Object.assign({ status: 'jalan', token: u.token, peserta: pesertaDari(k), ujian: infoUjian(atur, bank), sekarang: Date.now() }, paketPeserta(u, petaBank(bank)));
}

// Soal versi peserta: TANPA kunci, penjelasan, atau rubrik. Pilihan dikirim sebagai nomor urut.
function paketPeserta(u, bank) {
  const urutan = jsonAman(u.urutan, []), jaw = jsonAman(u.jawaban, {});
  const soal = [], jawaban = {};
  for (const it of urutan) {
    const s = bank.get(it.id); if (!s) continue;
    const item = { id: s.id, no: soal.length + 1, jenis: s.jenis, topik: s.topik, poin: s.poin, konteks: s.konteks, teks: s.teks, tabel: s.tabel || null };
    const j = jaw[s.id];
    if (s.jenis === 'esai') { if (j) jawaban[s.id] = j; }
    else {
      const urut = opsiUrut(it, s), peta = new Map(s.opsi.map(o => [o.id, o]));
      item.opsi = urut.map((id, i) => ({ id: i, teks: peta.get(id).teks }));
      if (s.jenis === 'banyak') { if (Array.isArray(j)) jawaban[s.id] = j.map(id => urut.indexOf(id)).filter(i => i >= 0); }
      else if (j != null && urut.includes(j)) jawaban[s.id] = urut.indexOf(j);
    }
    soal.push(item);
  }
  const ragu = jsonAman(u.ragu, []).filter(id => soal.some(s => s.id === id));
  return { soal, jawaban, ragu, mulai: u.mulai, batas: u.batas, disimpan: u.disimpan || null, sisa: Math.max(0, u.batas - Date.now()), durasi: Math.round((u.batas - u.mulai) / 60000) };
}
function normalJawaban(s, it, v) {
  if (v == null || v === '') return null;
  if (s.jenis === 'esai') { const t = String(v).slice(0, 5000); return t.trim() ? t : null; }
  const urut = opsiUrut(it, s);
  if (s.jenis === 'banyak') {
    if (!Array.isArray(v)) return null;
    const ids = [...new Set(v.map(Number))].filter(i => Number.isInteger(i) && i >= 0 && i < urut.length).map(i => urut[i]);
    return ids.length ? ids : null;
  }
  const i = Number(v);
  return Number.isInteger(i) && i >= 0 && i < urut.length ? urut[i] : null;
}
function stmtPeristiwa(c, kode, daftar, now) {
  const out = [];
  for (const e of (Array.isArray(daftar) ? daftar : []).slice(0, 60)) {
    if (!e || !['keluar', 'kembali', 'tempel'].includes(e.jenis)) continue;
    const t = Number(e.t), waktu = isFinite(t) && Math.abs(t - now) < 6 * 3600e3 ? Math.round(t) : now;
    const detik = e.jenis === 'kembali' ? Math.max(0, Math.min(10800, Math.round(Number(e.detik) || 0))) : null;
    const eid = e.eid ? String(e.eid).slice(0, 24) : null;
    out.push(c.db.prepare('INSERT OR IGNORE INTO kuis_log (kode,eid,waktu,jenis,detik) VALUES (?,?,?,?,?)').bind(kode, eid, waktu, e.jenis, detik));
  }
  return out;
}

async function kuisSimpan(c, kirim) {
  const k = await ambilKode(c, c.body.kode);
  let u = await ambilUjian(c, k.kode);
  if (!u) throw new Gagal('Ujian kamu belum dimulai', 409);
  const atur = await kuisAtur(c);
  if (u.selesai) return { status: 'selesai', peserta: pesertaDari(k), hasil: hasilPeserta(u, atur), sekarang: Date.now() };
  if (String(c.body.token || '') !== u.token) throw new Gagal('Ujian ini lagi dibuka di HP/tab lain. Masukin kode kamu lagi kalau mau lanjut di sini.', 409, 'SESI');
  const now = Date.now(), telat = now > u.batas + KUIS_TENGGANG;
  if (!telat) {
    const bank = petaBank(await bankSoal(c));
    const urutan = jsonAman(u.urutan, []), jaw = jsonAman(u.jawaban, {});
    const masuk = c.body.jawaban && typeof c.body.jawaban === 'object' && !Array.isArray(c.body.jawaban) ? c.body.jawaban : {};
    for (const it of urutan) {
      if (!Object.prototype.hasOwnProperty.call(masuk, it.id)) continue;
      const s = bank.get(it.id); if (!s) continue;
      const v = normalJawaban(s, it, masuk[it.id]);
      if (v == null) delete jaw[it.id]; else jaw[it.id] = v;
    }
    const ragu = Array.isArray(c.body.ragu) ? JSON.stringify([...new Set(c.body.ragu.map(String))].filter(id => urutan.some(it => it.id === id))) : u.ragu;
    await c.db.batch([
      c.db.prepare('UPDATE kuis_ujian SET jawaban=?, ragu=?, disimpan=? WHERE kode=? AND token=? AND selesai IS NULL').bind(JSON.stringify(jaw), ragu, now, k.kode, u.token),
      ...stmtPeristiwa(c, k.kode, c.body.log, now),
    ]);
    u = await ambilUjian(c, k.kode);
  }
  if (kirim || telat) {
    if (!u.selesai) u = await selesaikanUjian(c, u, telat ? 'waktu' : 'kirim', k);
    return { status: 'selesai', peserta: pesertaDari(k), hasil: hasilPeserta(u, atur), sekarang: Date.now() };
  }
  return { status: 'jalan', sisa: Math.max(0, u.batas - now), disimpan: now, sekarang: Date.now() };
}

/* ---------- Admin: peserta ---------- */
async function statLog(c, kode) {
  const q = `SELECT kode, SUM(jenis='keluar') AS keluar, COALESCE(SUM(CASE WHEN jenis='kembali' THEN detik END),0) AS detik,
    SUM(jenis='tempel') AS tempel, SUM(jenis='pindah') AS pindah FROM kuis_log ${kode ? 'WHERE kode=?' : ''} GROUP BY kode`;
  const rows = await semua(kode ? c.db.prepare(q).bind(kode) : c.db.prepare(q));
  return new Map(rows.map(r => [r.kode, { keluar: angka(r.keluar), detik: angka(r.detik), tempel: angka(r.tempel), pindah: angka(r.pindah) }]));
}
function barisPeserta(k, u, e, atur, t) {
  e = e || { keluar: 0, detik: 0, tempel: 0, pindah: 0 };
  const b = { kode: k.kode, nama: k.nama, ket: k.ket || '', ks: k.kode_sales || '', fb: k.fb || '', bot: !!k.tg_id, dibuat: k.dibuat,
    topup: t ? { status: t.status, va: t.va, nominal: t.nominal, alasan: t.alasan, dikirim: t.dikirim, diproses: t.diproses, oleh: t.oleh } : null, keluar: e.keluar, keluarDetik: e.detik, tempel: e.tempel, pindah: e.pindah };
  if (!u) return Object.assign(b, { status: 'belum' });
  const urutan = jsonAman(u.urutan, []), jaw = jsonAman(u.jawaban, {});
  Object.assign(b, { mulai: u.mulai, batas: u.batas, selesai: u.selesai || null, alasan: u.alasan || null, sesi: u.sesi, disimpan: u.disimpan || null,
    jumlah: urutan.length, terjawab: urutan.filter(it => jaw[it.id] != null).length });
  if (!u.selesai) return Object.assign(b, { status: 'jalan' });
  Object.assign(b, { pg: u.skor_auto, pgMaks: u.maks_auto, esai: u.skor_esai, esaiMaks: u.maks_esai, esaiBelum: u.esai_belum, nilai: u.nilai });
  b.status = u.esai_belum ? 'nilai' : u.nilai >= atur.kkm ? 'lulus' : 'gagal';
  return b;
}
async function kuisAdminRingkas(c) {
  await tutupKedaluwarsa(c);
  const [atur, bank, kode, ujian, ev, tp] = await Promise.all([
    kuisAtur(c), bankSoal(c),
    semua(c.db.prepare('SELECT * FROM kuis_kode ORDER BY dibuat DESC, nama COLLATE NOCASE')),
    semua(c.db.prepare('SELECT * FROM kuis_ujian')), statLog(c), semua(c.db.prepare('SELECT * FROM kuis_topup')),
  ]);
  const petaU = new Map(ujian.map(u => [u.kode, u])), petaT = new Map(tp.map(t => [t.kode, t]));
  const peserta = kode.map(k => barisPeserta(k, petaU.get(k.kode), ev.get(k.kode), atur, petaT.get(k.kode)));
  const topup = peserta.filter(p => p.topup && p.topup.status === 'kirim').sort((a, b) => a.topup.dikirim - b.topup.dikirim)
    .map(p => ({ kode: p.kode, nama: p.nama, ks: p.ks, fb: p.fb, nilai: p.nilai, va: p.topup.va, nominal: p.topup.nominal, waktu: p.topup.dikirim }));
  const dinilai = peserta.filter(p => p.status === 'lulus' || p.status === 'gagal');
  const nilai = dinilai.map(p => Number(p.nilai));
  const statistik = {
    total: peserta.length, belum: peserta.filter(p => p.status === 'belum').length, jalan: peserta.filter(p => p.status === 'jalan').length,
    perluNilai: peserta.filter(p => p.status === 'nilai').length, lulus: peserta.filter(p => p.status === 'lulus').length, gagal: peserta.filter(p => p.status === 'gagal').length,
    rata: nilai.length ? bulat1(nilai.reduce((a, b) => a + b, 0) / nilai.length) : null, tertinggi: nilai.length ? Math.max(...nilai) : null,
  };
  const daftar = (await semua(c.db.prepare(`SELECT d.*, (SELECT x.nama FROM kuis_daftar x WHERE x.kode_sales = d.kode_sales AND x.tg_id <> d.tg_id
      AND x.langkah IN ('tunggu','setuju') LIMIT 1) AS ganda FROM kuis_daftar d WHERE d.langkah = 'tunggu' ORDER BY d.dikirim`)))
    .map(d => ({ tg: d.tg_id, nama: d.nama, ks: d.kode_sales, fb: d.fb, user: d.tg_user, tgNama: d.tg_nama, waktu: d.dikirim, ganda: d.ganda || null }));
  return { atur, ujian: infoUjian(atur, bank), peserta, statistik, daftar, topup, sekarang: Date.now(), admin: c.akun.nama, bot: await namaBot(c), ai: !!c.env.OPENROUTER_API_KEY };
}

async function kuisAdminDetail(c) {
  const k = await ambilKode(c, c.body.kode);
  const atur = await kuisAtur(c);
  const u = await rapikanUjian(c, await ambilUjian(c, k.kode), k);
  const e = (await statLog(c, k.kode)).get(k.kode);
  const peserta = barisPeserta(k, u, e, atur, await c.db.prepare('SELECT * FROM kuis_topup WHERE kode=?').bind(k.kode).first());
  if (!u) return { peserta, soal: [], log: [], kkm: atur.kkm, sekarang: Date.now() };
  const bank = petaBank(await bankSoal(c));
  const urutan = jsonAman(u.urutan, []), jaw = jsonAman(u.jawaban, {}), esai = jsonAman(u.esai, {}), ragu = jsonAman(u.ragu, []);
  const soal = [];
  for (const it of urutan) {
    const s = bank.get(it.id); if (!s) continue;
    const j = jaw[s.id];
    const item = { id: s.id, no: soal.length + 1, jenis: s.jenis, topik: s.topik, poin: s.poin, konteks: s.konteks, teks: s.teks, tabel: s.tabel, penjelasan: s.penjelasan, ragu: ragu.includes(s.id) };
    if (s.jenis === 'esai') {
      const g = esai[s.id] || null;
      Object.assign(item, { jawaban: j || '', rubrik: s.rubrik, nilai: g, skor: g ? g.skor : j ? null : 0, hasil: !j ? 'kosong' : g ? 'dinilai' : 'menunggu' });
    } else {
      const urut = opsiUrut(it, s), peta = new Map(s.opsi.map(o => [o.id, o]));
      const dipilih = new Set(Array.isArray(j) ? j : j != null ? [j] : []);
      item.opsi = urut.map((id, i) => ({ huruf: 'ABCDEFGH'[i], teks: peta.get(id).teks, benar: !!peta.get(id).benar, dipilih: dipilih.has(id) }));
      item.skor = skorSoal(s, j);
      item.hasil = j == null ? 'kosong' : item.skor >= s.poin ? 'benar' : item.skor > 0 ? 'sebagian' : 'salah';
    }
    soal.push(item);
  }
  const log = await semua(c.db.prepare('SELECT waktu, jenis, detik, ket FROM kuis_log WHERE kode=? ORDER BY waktu, id LIMIT 400').bind(k.kode));
  return { peserta, soal, log, kkm: atur.kkm, sekarang: Date.now() };
}

async function kuisAdminNilaiEsai(c) {
  const k = await ambilKode(c, c.body.kode);
  const u = await ambilUjian(c, k.kode);
  if (!u || !u.selesai) throw new Gagal('Peserta ini belum selesai ujian', 409);
  const bank = petaBank(await bankSoal(c));
  const s = bank.get(String(c.body.id || ''));
  if (!s || s.jenis !== 'esai' || !jsonAman(u.urutan, []).some(it => it.id === s.id)) throw new Gagal('Soal esai nggak ditemukan', 404);
  const esai = jsonAman(u.esai, {});
  if (c.body.skor == null || c.body.skor === '') delete esai[s.id];
  else {
    const skor = Number(c.body.skor);
    if (!isFinite(skor) || skor < 0 || skor > s.poin) throw new Gagal(`Nilai harus antara 0 dan ${fmtPoin(s.poin)}`);
    esai[s.id] = { skor: Math.round(skor * 2) / 2, catatan: String(c.body.catatan || '').trim().slice(0, 500), oleh: c.akun.nama, waktu: Date.now() };
  }
  const n = nilaiUjian(Object.assign({}, u, { esai: JSON.stringify(esai) }), bank);
  await c.db.prepare('UPDATE kuis_ujian SET esai=?, skor_auto=?, maks_auto=?, skor_esai=?, maks_esai=?, esai_belum=?, nilai=? WHERE kode=?')
    .bind(JSON.stringify(esai), n.auto, n.autoMaks, n.esai, n.esaiMaks, n.esaiBelum, n.nilai, k.kode).run();
  if (!n.esaiBelum) await mintaTopup(c, k.kode).catch(() => {});
  return kuisAdminDetail(c);
}

async function kuisAdminAkhiri(c) {
  const k = await ambilKode(c, c.body.kode);
  const u = await ambilUjian(c, k.kode);
  if (!u) throw new Gagal('Peserta ini belum mulai ujian', 409);
  if (!u.selesai) await selesaikanUjian(c, u, 'admin', k);
  return kuisAdminDetail(c);
}

async function kuisAdminKodeBuat(c) {
  const nama = String(c.body.nama || '').split(/\r?\n/).map(s => s.trim().replace(/\s+/g, ' ').slice(0, 60)).filter(Boolean);
  if (!nama.length) throw new Gagal('Tulis minimal 1 nama peserta');
  if (nama.length > 100) throw new Gagal('Maksimal 100 nama sekali tambah');
  const ket = String(c.body.ket || '').trim().slice(0, 60) || null;
  const ada = new Set((await semua(c.db.prepare('SELECT kode FROM kuis_kode'))).map(r => r.kode));
  const daftar = nama.map(n => { let kode; do kode = kodeAcak(); while (ada.has(kode)); ada.add(kode); return { k: kode, n }; });
  await c.db.prepare(`INSERT OR IGNORE INTO kuis_kode (kode,nama,ket,dibuat,oleh)
    SELECT json_extract(value,'$.k'), json_extract(value,'$.n'), ?, ? + key, ? FROM json_each(?)`)
    .bind(ket, Date.now(), c.akun.nama, JSON.stringify(daftar)).run();
  return { dibuat: daftar.map(d => ({ kode: d.k, nama: d.n, ket })) };
}
async function kuisAdminKodeUbah(c) {
  const k = await ambilKode(c, c.body.kode);
  const nama = String(c.body.nama || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!nama) throw new Gagal('Nama wajib diisi');
  await c.db.prepare('UPDATE kuis_kode SET nama=?, ket=? WHERE kode=?').bind(nama, String(c.body.ket || '').trim().slice(0, 60) || null, k.kode).run();
  return kuisAdminDetail(c);
}
async function kuisAdminKodeUlang(c) {
  const k = await ambilKode(c, c.body.kode);
  await c.db.batch([
    c.db.prepare('DELETE FROM kuis_ujian WHERE kode=?').bind(k.kode),
    c.db.prepare('DELETE FROM kuis_log WHERE kode=?').bind(k.kode),
  ]);
  return kuisAdminDetail(c);
}
async function kuisAdminKodeHapus(c) {
  const k = await ambilKode(c, c.body.kode);
  await c.db.batch([
    c.db.prepare('DELETE FROM kuis_ujian WHERE kode=?').bind(k.kode),
    c.db.prepare('DELETE FROM kuis_log WHERE kode=?').bind(k.kode),
    c.db.prepare('DELETE FROM kuis_kode WHERE kode=?').bind(k.kode),
    c.db.prepare('DELETE FROM kuis_daftar WHERE kode=?').bind(k.kode),
    c.db.prepare('DELETE FROM kuis_topup WHERE kode=?').bind(k.kode),
  ]);
  return { dihapus: k.kode };
}

/* ---------- Admin: bank soal ---------- */
async function kuisAdminSoal(c) {
  const bank = await bankSoal(c);
  const pakai = await c.db.prepare('SELECT COUNT(*) AS n FROM kuis_ujian').first();
  return { soal: bank, ujian: infoUjian(await kuisAtur(c), bank), dipakai: angka(pakai && pakai.n), ai: !!c.env.OPENROUTER_API_KEY };
}
function cekSoal(x) {
  x = x || {};
  const jenis = String(x.jenis || '');
  if (!KUIS_JENIS[jenis]) throw new Gagal('Jenis soal nggak dikenal');
  const teks = String(x.teks || '').trim();
  if (!teks) throw new Gagal('Pertanyaan wajib diisi');
  if (teks.length > 2000) throw new Gagal('Pertanyaan kepanjangan (maks 2.000 huruf)');
  const poin = Math.round(Number(x.poin) * 2) / 2;
  if (!(poin >= 0.5 && poin <= 50)) throw new Gagal('Poin harus antara 0,5 dan 50');
  const s = { jenis, teks, poin, konteks: String(x.konteks || '').trim().slice(0, 2000), topik: String(x.topik || '').trim().slice(0, 40), penjelasan: String(x.penjelasan || '').trim().slice(0, 1500), aktif: x.aktif !== false, tabel: null, opsi: null, rubrik: null };
  if (jenis !== 'esai' && x.tabel && Array.isArray(x.tabel.kolom)) {
    const kolom = x.tabel.kolom.map(v => String(v == null ? '' : v).trim().slice(0, 40)).slice(0, 8);
    const baris = (Array.isArray(x.tabel.baris) ? x.tabel.baris : []).slice(0, 15).map(b => kolom.map((_, i) => String(b && b[i] != null ? b[i] : '').trim().slice(0, 60))).filter(b => b.some(Boolean));
    if (kolom.some(Boolean) && baris.length) s.tabel = { kolom, baris };
  }
  if (jenis === 'data' && !s.tabel) throw new Gagal('Soal baca data perlu tabel (minimal judul kolom + 1 baris)');
  if (jenis === 'esai') {
    s.rubrik = (Array.isArray(x.rubrik) ? x.rubrik : []).map(v => String(v || '').trim().slice(0, 300)).filter(Boolean).slice(0, 10);
    return s;
  }
  const opsi = (Array.isArray(x.opsi) ? x.opsi : []).map(o => ({ id: String((o && o.id) || '').replace(/[^a-z0-9]/gi, '').slice(0, 8), teks: String((o && o.teks) || '').trim().slice(0, 600), benar: !!(o && o.benar) })).filter(o => o.teks);
  if (opsi.length < 2) throw new Gagal('Minimal 2 pilihan jawaban');
  if (opsi.length > 8) throw new Gagal('Maksimal 8 pilihan jawaban');
  const dipakai = new Set();
  for (const o of opsi) { if (!o.id || dipakai.has(o.id)) o.id = ''; else dipakai.add(o.id); }
  for (const o of opsi) if (!o.id) { o.id = 'abcdefghijklmnopqrstuvwxyz'.split('').find(h => !dipakai.has(h)) || acak(3); dipakai.add(o.id); }
  const nb = opsi.filter(o => o.benar).length;
  if (jenis !== 'banyak' && nb !== 1) throw new Gagal('Tandai tepat 1 jawaban yang benar');
  if (jenis === 'banyak' && nb < 1) throw new Gagal('Tandai minimal 1 jawaban yang benar');
  if (jenis === 'banyak' && nb === opsi.length) throw new Gagal('Jangan semua pilihan dibikin benar, nanti gampang ditebak');
  s.opsi = opsi;
  return s;
}
const nilaiKolomSoal = s => [s.jenis, s.topik || null, s.poin, s.konteks || null, s.teks, s.tabel ? JSON.stringify(s.tabel) : null, s.opsi ? JSON.stringify(s.opsi) : null, s.penjelasan || null, s.rubrik ? JSON.stringify(s.rubrik) : null, s.aktif ? 1 : 0];
async function kuisAdminSoalSimpan(c) {
  const x = c.body.soal || {};
  const s = cekSoal(x);
  const id = x.id ? String(x.id) : '';
  const now = Date.now();
  if (id) {
    const r = await c.db.prepare(`UPDATE kuis_soal SET jenis=?, topik=?, poin=?, konteks=?, teks=?, tabel=?, opsi=?, penjelasan=?, rubrik=?, aktif=?, diubah=?, sumber=CASE WHEN sumber='ai' THEN 'ai-cek' ELSE sumber END WHERE id=?`).bind(...nilaiKolomSoal(s), now, id).run();
    if (!r.meta.changes) throw new Gagal('Soal nggak ditemukan', 404);
  } else {
    await c.db.prepare(`INSERT INTO kuis_soal (id,urut,jenis,topik,poin,konteks,teks,tabel,opsi,penjelasan,rubrik,aktif,diubah)
      VALUES (?,(SELECT COALESCE(MAX(urut),0)+1 FROM kuis_soal WHERE urut < 1000),?,?,?,?,?,?,?,?,?,?,?)`).bind('s' + acak(4), ...nilaiKolomSoal(s), now).run();
  }
  const bank = await bankSoal(c);
  await hitungUlangSemua(c, bank);
  return kuisAdminSoal(c);
}
async function kuisAdminSoalHapus(c) {
  await c.db.prepare('DELETE FROM kuis_soal WHERE id=?').bind(String(c.body.id || '')).run();
  await hitungUlangSemua(c);
  return kuisAdminSoal(c);
}
async function bukaBawaan(kunci) {
  const bersih = String(kunci || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (bersih.length < 8) throw new Gagal('Kode buka soal bawaan belum diisi');
  const raw = Uint8Array.from(atob(KUIS_BAWAAN), ch => ch.charCodeAt(0));
  const bahan = await crypto.subtle.importKey('raw', enc.encode(bersih), 'PBKDF2', false, ['deriveKey']);
  const kunciAes = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: raw.slice(0, 16), iterations: 20000 }, bahan, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  try { return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(16, 28) }, kunciAes, raw.slice(28)))); }
  catch (e) { throw new Gagal('Kode buka salah. Cek lagi ya.', 403); }
}
async function kuisAdminSoalBawaan(c) {
  const ada = await c.db.prepare('SELECT COUNT(*) AS n FROM kuis_soal').first();
  if (angka(ada && ada.n) && !c.body.timpa) throw new Gagal('Bank soal udah ada isinya. Pilih "timpa" kalau mau diganti soal bawaan.', 409);
  const daftar = await bukaBawaan(c.body.kunci);
  const now = Date.now();
  await c.db.batch([
    // Soal lama yang belum pernah dikerjain dihapus. Yang udah pernah dikerjain disimpan sebagai nonaktif, biar nilai peserta lama nggak berubah.
    c.db.prepare(`DELETE FROM kuis_soal WHERE id NOT IN (SELECT json_extract(j.value,'$.id') FROM kuis_ujian u, json_each(u.urutan) j)`),
    c.db.prepare('UPDATE kuis_soal SET aktif=0, urut=urut+1000 WHERE urut < 1000'),
    c.db.prepare(`INSERT OR REPLACE INTO kuis_soal (id,urut,jenis,topik,poin,konteks,teks,tabel,opsi,penjelasan,rubrik,aktif,diubah,sumber)
      SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]'), json_extract(value,'$[2]'), json_extract(value,'$[3]'), json_extract(value,'$[4]'), json_extract(value,'$[5]'),
        json_extract(value,'$[6]'), json_extract(value,'$[7]'), json_extract(value,'$[8]'), json_extract(value,'$[9]'), json_extract(value,'$[10]'), 1, ?, 'bawaan' FROM json_each(?)`)
      .bind(now, JSON.stringify(daftar.map((x, i) => [String(x.id), i + 1, ...nilaiKolomSoal(cekSoal(x)).slice(0, 9)]))),
  ]);
  await hitungUlangSemua(c);
  return kuisAdminSoal(c);
}

/* ---------- Admin: analisis ---------- */
async function analisisSoal(c) {
  const bank = await bankSoal(c), peta = petaBank(bank);
  const rows = await semua(c.db.prepare('SELECT urutan, jawaban, esai FROM kuis_ujian WHERE selesai IS NOT NULL'));
  const per = new Map(bank.map(s => [s.id, { n: 0, dinilai: 0, skor: 0, penuh: 0, kosong: 0, pilih: {} }]));
  for (const u of rows) {
    const urutan = jsonAman(u.urutan, []), jaw = jsonAman(u.jawaban, {}), esai = jsonAman(u.esai, {});
    for (const it of urutan) {
      const s = peta.get(it.id), a = per.get(it.id); if (!s || !a) continue;
      a.n++;
      const j = jaw[s.id];
      if (s.jenis === 'esai') {
        const g = esai[s.id];
        if (!j) { a.kosong++; a.dinilai++; } else if (g) { a.dinilai++; a.skor += Number(g.skor); if (g.skor >= s.poin) a.penuh++; }
        continue;
      }
      a.dinilai++;
      if (j == null) { a.kosong++; continue; }
      const sk = skorSoal(s, j); a.skor += sk; if (sk >= s.poin) a.penuh++;
      for (const id of Array.isArray(j) ? j : [j]) a.pilih[id] = (a.pilih[id] || 0) + 1;
    }
  }
  const soal = bank.map(s => {
    const a = per.get(s.id);
    return {
      id: s.id, urut: s.urut, jenis: s.jenis, topik: s.topik || 'Lainnya', teks: s.teks, poin: s.poin, aktif: s.aktif,
      n: a.n, dinilai: a.dinilai, kosong: a.kosong, rata: a.dinilai ? bulat1(a.skor / (a.dinilai * s.poin) * 100) : null, benar: a.n ? bulat1(a.penuh / a.n * 100) : null,
      opsi: s.jenis === 'esai' ? null : s.opsi.map(o => ({ teks: o.teks, benar: !!o.benar, dipilih: a.pilih[o.id] || 0 })),
    };
  });
  const topik = new Map();
  for (const s of soal) {
    if (s.rata == null) continue;
    const t = topik.get(s.topik) || { topik: s.topik, skor: 0, bobot: 0, soal: 0 };
    t.skor += s.rata * s.poin; t.bobot += s.poin; t.soal++; topik.set(s.topik, t);
  }
  return { peserta: rows.length, soal, topik: [...topik.values()].map(t => ({ topik: t.topik, soal: t.soal, rata: bulat1(t.skor / t.bobot) })).sort((a, b) => a.rata - b.rata) };
}
async function kuisAdminAnalisis(c) { await tutupKedaluwarsa(c); return analisisSoal(c); }

/* ---------- Admin: pengaturan ---------- */
async function kuisAdminAtur(c) {
  const lama = await kuisAtur(c), x = c.body.atur;
  if (!x) return { atur: lama };
  const durasi = Math.round(Number(x.durasi)), kkm = Math.round(Number(x.kkm));
  if (!(durasi >= 5 && durasi <= 180)) throw new Gagal('Durasi 5–180 menit');
  if (!(kkm >= 0 && kkm <= 100)) throw new Gagal('KKM 0–100');
  const jumlahSoal = x.jumlahSoal == null || x.jumlahSoal === '' ? 0 : Math.round(Number(x.jumlahSoal));
  if (!(jumlahSoal >= 0 && jumlahSoal <= 200)) throw new Gagal('Soal per peserta 0–200 (0 = semua soal)');
  const nominalTopup = x.nominalTopup == null || x.nominalTopup === '' ? 0 : Math.round(Number(String(x.nominalTopup).replace(/[^\d]/g, '')));
  if (!(nominalTopup === 0 || (nominalTopup >= 10000 && nominalTopup <= 100000000))) throw new Gagal('Nominal top up minimal Rp10.000 (kosongin kalau nggak ditentuin)');
  const atur = {
    jumlahSoal, nominalTopup, topupAktif: x.topupAktif !== false,
    judul: String(x.judul || '').trim().slice(0, 60) || KUIS_ATUR_AWAL.judul, subjudul: String(x.subjudul || '').trim().slice(0, 80),
    durasi, kkm, buka: !!x.buka, tampilNilai: !!x.tampilNilai, kabariAdmin: !!x.kabariAdmin, linkMiniApp: !!x.linkMiniApp, daftarBot: !!x.daftarBot, modelAi: /^[\w.\-\/:]{3,100}$/.test(String(x.modelAi || '').trim()) ? String(x.modelAi).trim() : KUIS_ATUR_AWAL.modelAi, petunjuk: String(x.petunjuk || '').trim().slice(0, 800),
  };
  await c.db.prepare(`INSERT OR REPLACE INTO meta (k,v) VALUES ('kuis_atur', ?)`).bind(JSON.stringify(atur)).run();
  return { atur };
}

/* ---------- Admin: Excel ---------- */
function teksJawaban(s, j, urut) {
  if (j == null || j === '') return '(kosong)';
  if (s.jenis === 'esai') return String(j);
  const huruf = id => 'ABCDEFGH'[urut.indexOf(id)] || '?';
  const isi = id => { const o = s.opsi.find(x => x.id === id); return o ? `${huruf(id)}. ${o.teks}` : '(pilihan dihapus)'; };
  return (Array.isArray(j) ? j : [j]).map(isi).join('\n');
}
async function kuisAdminExcel(c) {
  await tutupKedaluwarsa(c);
  const [atur, bankList, kode, ujian, ev, analisis] = await Promise.all([
    kuisAtur(c), bankSoal(c), semua(c.db.prepare('SELECT * FROM kuis_kode ORDER BY nama COLLATE NOCASE')), semua(c.db.prepare('SELECT * FROM kuis_ujian')), statLog(c), analisisSoal(c),
  ]);
  const bank = petaBank(bankList), petaU = new Map(ujian.map(u => [u.kode, u]));
  const petaTopup = new Map((await semua(c.db.prepare('SELECT * FROM kuis_topup'))).map(t => [t.kode, t]));
  const LABEL = { belum: 'Belum mulai', jalan: 'Lagi mengerjakan', nilai: 'Esai belum dinilai', lulus: 'LULUS', gagal: 'Belum lulus' };
  const peserta = [], jawaban = [];
  for (const k of kode) {
    const u = petaU.get(k.kode), p = barisPeserta(k, u, ev.get(k.kode), atur, petaTopup.get(k.kode));
    peserta.push([p.nama, tampilKode(p.kode), p.ks, p.fb, p.ket, LABEL[p.status], waktuWIB(p.mulai), waktuWIB(p.selesai), p.mulai && p.selesai ? Math.round((p.selesai - p.mulai) / 6000) / 10 : '',
      p.alasan ? KUIS_CARA[p.alasan] || p.alasan : '', p.jumlah ? `${p.terjawab}/${p.jumlah}` : '', p.pg == null ? '' : bulat2(p.pg), p.pgMaks == null ? '' : bulat2(p.pgMaks),
      p.esai == null ? '' : bulat2(p.esai), p.esaiMaks == null ? '' : bulat2(p.esaiMaks), p.status === 'lulus' || p.status === 'gagal' ? bulat1(p.nilai) : '', atur.kkm,
      p.keluar, p.keluarDetik, p.tempel, p.sesi ? p.sesi - 1 : 0,
      p.topup ? LABEL_TOPUP[p.topup.status] || p.topup.status : '', p.topup && p.topup.va ? p.topup.va : '', p.topup && p.topup.nominal ? p.topup.nominal : '']);
    if (!u) continue;
    const urutan = jsonAman(u.urutan, []), jaw = jsonAman(u.jawaban, {}), esai = jsonAman(u.esai, {});
    urutan.forEach((it, i) => {
      const s = bank.get(it.id); if (!s) return;
      const urut = s.jenis === 'esai' ? [] : opsiUrut(it, s), j = jaw[s.id];
      const kunci = s.jenis === 'esai' ? (s.rubrik || []).join('\n') : s.opsi.filter(o => o.benar).map(o => `${'ABCDEFGH'[urut.indexOf(o.id)]}. ${o.teks}`).join('\n');
      const g = esai[s.id];
      const skor = s.jenis === 'esai' ? (g ? g.skor : j ? '' : 0) : skorSoal(s, j);
      const hasil = s.jenis === 'esai' ? (!j ? 'Kosong' : g ? 'Dinilai' : 'Belum dinilai') : j == null ? 'Kosong' : skor >= s.poin ? 'Benar' : skor > 0 ? 'Sebagian' : 'Salah';
      jawaban.push([k.nama, tampilKode(k.kode), i + 1, s.topik, KUIS_JENIS[s.jenis], s.teks, teksJawaban(s, j, urut), kunci, skor, s.poin, hasil, g ? g.catatan || '' : '']);
    });
  }
  const soal = analisis.soal.map((s, i) => [i + 1, s.topik, KUIS_JENIS[s.jenis], s.teks, s.poin, s.aktif ? 'Aktif' : 'Nonaktif', s.n, s.rata == null ? '' : s.rata, s.benar == null ? '' : s.benar, s.kosong]);
  const file = buatXlsx([
    { nama: 'Peserta', kolom: [['Nama', 24], ['Kode', 10], ['Kode sales', 13], ['Halaman Facebook', 24], ['Keterangan', 16], ['Status', 18], ['Mulai (WIB)', 17], ['Selesai (WIB)', 17], ['Lama (menit)', 12], ['Cara selesai', 16], ['Terjawab', 10], ['Skor pilihan ganda', 18], ['Maks PG', 9], ['Skor esai', 10], ['Maks esai', 10], ['Nilai akhir', 11], ['KKM', 6], ['Keluar app (×)', 14], ['Lama di luar (detik)', 19], ['Tempel diblokir (×)', 19], ['Dibuka ulang (×)', 16], ['Top up', 18], ['VA BCA', 20], ['Nominal top up', 15]], baris: peserta },
    { nama: 'Jawaban', kolom: [['Nama', 22], ['Kode', 10], ['No', 5], ['Topik', 18], ['Jenis', 14], ['Pertanyaan', 60], ['Jawaban peserta', 60], ['Kunci / rubrik', 60], ['Skor', 7], ['Maks', 7], ['Hasil', 13], ['Catatan penilai', 30]], baris: jawaban },
    { nama: 'Analisis soal', kolom: [['No', 5], ['Topik', 18], ['Jenis', 14], ['Pertanyaan', 70], ['Poin', 6], ['Status', 9], ['Peserta', 9], ['Rata-rata skor (%)', 18], ['Benar penuh (%)', 16], ['Kosong', 8]], baris: soal },
  ]);
  const st = { lulus: 0, gagal: 0, nilai: 0 };
  for (const k of kode) { const p = barisPeserta(k, petaU.get(k.kode), null, atur); if (st[p.status] != null) st[p.status]++; }
  const namaFile = `Hasil ${atur.judul} ${tanggalWIB(Date.now())}.xlsx`.replace(/[\\/:*?"<>|]/g, '-');
  const fd = new FormData();
  fd.append('chat_id', String(c.tg.id));
  fd.append('caption', `📊 Hasil ${atur.judul}\n${kode.length} peserta · ${st.lulus} lulus · ${st.gagal} belum lulus · ${st.nilai} esai belum dinilai\nKKM ${atur.kkm}`);
  fd.append('document', file, namaFile);
  try { await tg(c.env, 'sendDocument', fd); }
  catch (e) {
    if (/initiate|blocked|chat not found|403/i.test(e.message)) {
      let bot = 'bot ini';
      try { const me = await tg(c.env, 'getMe', {}); bot = '@' + me.result.username; } catch (err) {}
      throw new Gagal(`Bot belum bisa kirim file ke kamu. Buka chat ${bot}, ketuk Start, lalu coba lagi.`, 409, 'TULIS');
    }
    throw e;
  }
  return { namaFile, peserta: kode.length };
}

/* =====================================================================
 * BOT KUIS: pendaftaran lewat chat → disetujui admin → kode dikirim bot
 * ===================================================================== */
const LANGKAH_FORM = ['nama', 'kodesales', 'fb'];
const hb = s => String(s == null ? '' : s).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
async function rahasiaWebhook(token) { return hex(await crypto.subtle.digest('SHA-256', enc.encode('kuis-webhook:' + token))).slice(0, 48); }
const tglJamWIB = t => `${tanggalPanjang(tanggalWIB(t))}, ${jamWIB(t)} WIB`;
const NAMA_BOT = new Map();
async function namaBot(c) {
  const t = c.env.BOT_TOKEN;
  if (!NAMA_BOT.has(t)) { try { NAMA_BOT.set(t, (await tg(c.env, 'getMe', {})).result.username); } catch (e) { return null; } }
  return NAMA_BOT.get(t);
}

async function pasangBotKuis(env, asal) {
  const token = env.KUIS_BOT_TOKEN;
  if (!token) return teks('Isi KUIS_BOT_TOKEN dulu (tipe Secret) di Settings → Variables and Secrets, lalu buka halaman ini lagi.');
  const e = Object.assign({}, env, { BOT_TOKEN: token });
  try {
    const me = await tg(e, 'getMe', {});
    await tg(e, 'setWebhook', { url: `${asal}/bot-kuis`, secret_token: await rahasiaWebhook(token), allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
    await tg(e, 'setMyCommands', { commands: [
      { command: 'daftarkuis', description: 'Daftar ujian Meta Ads' },
      { command: 'status', description: 'Cek status pendaftaran & kode ujian' },
      { command: 'topup', description: 'Cara kirim VA BCA buat top up dana iklan' },
      { command: 'batal', description: 'Batalin pengisian form' },
      { command: 'start', description: 'Lihat perkenalan' },
    ] });
    const admin = await semua(env.DB.prepare(`SELECT tg_id FROM akun WHERE peran='admin' AND aktif=1 AND tg_id IS NOT NULL LIMIT 5`));
    for (const a of admin) await pasangPerintahAdmin(e, a.tg_id).catch(() => {});
    await tg(e, 'setMyDescription', { description: 'Bot seleksi SF Digital IndiHome.\n\nDaftar Ujian Meta Ads, tunggu persetujuan admin, terima kode, lalu ujian langsung dari Telegram.\n\nKetuk Mulai buat kenalan dulu 👋' });
    await tg(e, 'setMyShortDescription', { short_description: 'Daftar & ikut Ujian Meta Ads buat SF Digital IndiHome' });
    return teks(`Bot @${me.result.username} udah tersambung ✅\n\nBuka bot-nya di Telegram, lalu ketik /start buat nyoba.`);
  } catch (err) { return teks('Gagal nyambungin bot: ' + err.message); }
}

async function webhookKuis(request, env, ctx) {
  const token = env.KUIS_BOT_TOKEN;
  if (!token || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await rahasiaWebhook(token)) return new Response('forbidden', { status: 403 });
  let u = null;
  try { u = await request.json(); } catch (e) {}
  if (u && env.DB) {
    try { await siapkanDB(env); await prosesUpdateBot({ env: Object.assign({}, env, { BOT_TOKEN: token }), db: env.DB, ctx }, u); }
    catch (e) { console.log('bot kuis error', (e && e.message) || e); }
  }
  return new Response('ok'); // selalu 200 biar Telegram nggak ngulang kiriman
}
function kirimBot(c, chat, text, extra) {
  return tg(c.env, 'sendMessage', Object.assign({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }, extra || {}));
}
const ambilDaftar = (c, id) => c.db.prepare('SELECT * FROM kuis_daftar WHERE tg_id=?').bind(String(id)).first();
const tombolUjian = (kode, label = '📝 Mulai ujian') => ({ inline_keyboard: [[{ text: label, web_app: { url: `${KUIS_URL}?kode=${kode}` } }]] });
const teksKode = (atur, kode) => [
  '🎉 <b>Selamat, pendaftaran kamu disetujui!</b>', '',
  `Kode ujian kamu: <code>${tampilKode(kode)}</code>`, '',
  'Sebelum mulai:',
  `⏱ Waktunya ${atur.durasi} menit dan jalan terus begitu kamu mulai, walaupun app ditutup`,
  '📶 Pastiin sinyal kamu stabil',
  '🔒 Kode ini cuma buat kamu dan cuma bisa dipakai sekali', '',
  'Ketuk <b>Mulai ujian</b> kalau udah siap. Semangat! 💪',
].join('\n');
const teksTolak = alasan => `Maaf, pendaftaran ujian kamu belum bisa disetujui 🙏${alasan ? `\n\nAlasan: ${hb(alasan)}` : ''}\n\nKalau ada data yang salah, kamu bisa daftar ulang pakai /daftarkuis.`;
const teksRingkas = (d, judul = 'Cek lagi datanya ya:') => `${judul}\n\n👤 Nama: <b>${hb(d.nama)}</b>\n🪪 Kode sales: <b>${hb(d.kode_sales)}</b>\n📘 Halaman Facebook: <b>${hb(d.fb)}</b>`;
const teksAdminDaftar = d => `🆕 <b>Pendaftar ujian baru</b>\n\n👤 ${hb(d.nama)}\n🪪 Kode sales: <b>${hb(d.kode_sales)}</b>\n📘 Halaman FB: ${hb(d.fb)}\n💬 Telegram: ${d.tg_user ? '@' + hb(d.tg_user) : hb(d.tg_nama || d.tg_id)}`;

async function prosesUpdateBot(c, u) {
  if (u.callback_query) return tombolBot(c, u.callback_query);
  const m = u.message;
  if (!m || !m.from || m.from.is_bot || !m.chat || m.chat.type !== 'private') return;
  const id = String(m.from.id), t = typeof m.text === 'string' ? m.text.trim() : '';
  const cmdAwal = t.startsWith('/') ? t.slice(1).split(/[\s@]/)[0].toLowerCase() : '';
  const admin = await ambilAdmin(c, id);
  if (admin) return pesanAdmin(c, admin, id, cmdAwal);
  const d0 = await ambilDaftar(c, id);
  const d = d0 && d0.langkah !== 'batal' ? d0 : null;
  const cmd = t.startsWith('/') ? t.slice(1).split(/[\s@]/)[0].toLowerCase() : '';
  if (cmd === 'start') return (t.split(/\s+/)[1] === 'daftar' ? mulaiDaftar : sapaBot)(c, m.from, d);
  if (cmd === 'daftarkuis' || cmd === 'daftar') return mulaiDaftar(c, m.from, d);
  if (cmd === 'status' || cmd === 'kodeku') return statusBot(c, m.from, d);
  if (cmd === 'batal') return batalBot(c, id, d);
  if (cmd === 'bantuan' || cmd === 'help') return sapaBot(c, m.from, d);
  if (cmd === 'topup' || cmd === 'va') return topupBot(c, id);
  if (cmd) return kirimBot(c, id, 'Perintah itu belum ada 🤔\nCoba /daftarkuis buat daftar, atau /status buat cek pendaftaran.');
  const tp = await ambilTopupTg(c, id);
  if (tp && ['minta', 'tolak', 'cek'].includes(tp.status)) return terimaVa(c, tp, t);
  if (d && LANGKAH_FORM.includes(d.langkah)) return isiFormBot(c, d, t);
  if (d && d.langkah === 'cek') return kirimBot(c, id, 'Tinggal satu langkah lagi! Ketuk <b>Kirim pendaftaran</b> di pesan sebelumnya, atau <b>Isi ulang</b> kalau ada yang salah.');
  return kirimBot(c, id, 'Hai! 👋 Ketik /daftarkuis buat daftar ujian, atau /status buat cek pendaftaran kamu.');
}

async function sapaBot(c, from, d) {
  if (d && d.langkah === 'setuju') return statusBot(c, from, d);
  const atur = await kuisAtur(c);
  const n = await c.db.prepare('SELECT COUNT(*) AS n FROM kuis_soal WHERE aktif=1').first();
  const jumlah = Math.min(angka(n && n.n), Number(atur.jumlahSoal) || Infinity);
  const bawah = d && d.langkah === 'tunggu'
    ? '⏳ Pendaftaran kamu udah masuk dan lagi dicek admin. Kode ujian dikirim ke chat ini begitu disetujui.'
    : ['<b>Cara ikut:</b>', '1️⃣ Ketik /daftarkuis', '2️⃣ Isi nama lengkap, kode sales, dan nama halaman Facebook kamu', '3️⃣ Tunggu admin nyetujuin', '4️⃣ Kode ujian dikirim ke sini, tinggal ketuk <b>Mulai ujian</b>', '', 'Siap buktiin kamu jago ngiklan? Ketik /daftarkuis 🚀'].join('\n');
  return kirimBot(c, String(from.id), [
    `<b>Halo, ${hb(from.first_name || 'kamu')}! 👋</b>`, '',
    `Selamat datang di <b>${hb(atur.judul)}</b>, seleksi SF Digital IndiHome sebelum pencairan dana iklan.`, '',
    `Di sini dicek seberapa paham kamu nyiapin iklan Meta dari nol: milih tujuan kampanye, ngatur area dan anggaran, bikin materi iklan yang ngarah ke WhatsApp, sampai baca laporan dasarnya. Isinya ${jumlah ? `${jumlah} soal, ` : ''}${atur.durasi} menit, nilai lulus ${atur.kkm}.`, '',
    bawah,
  ].join('\n'));
}

const TANYA = {
  nama: ['Pertanyaan 1 dari 3', 'Nama lengkap kamu?', 'Tulis sesuai data di perusahaan.', 'Nama lengkap'],
  kodesales: ['Pertanyaan 2 dari 3', 'Kode sales kamu?', 'Contoh: SF12345', 'Kode sales'],
  fb: ['Pertanyaan 3 dari 3', 'Nama halaman Facebook yang kamu pakai buat ngiklan?', 'Tulis persis kayak yang muncul di Facebook.', 'Nama halaman Facebook'],
};
function tanyaBot(c, id, langkah, awalan = '') {
  const [no, tanya, ket, ph] = TANYA[langkah];
  return kirimBot(c, id, `${awalan}<i>${no}</i>\n<b>${tanya}</b>\n${ket}`, { reply_markup: { force_reply: true, input_field_placeholder: ph } });
}
async function mulaiDaftar(c, from, d) {
  const id = String(from.id);
  if (d && d.langkah === 'setuju') return statusBot(c, from, d);
  if (d && d.langkah === 'tunggu') return kirimBot(c, id, '⏳ Pendaftaran kamu udah masuk dan lagi dicek admin. Sabar ya, kode ujiannya dikirim ke sini begitu disetujui.\n\nKetik /status buat cek kapan aja.');
  const atur = await kuisAtur(c);
  if (atur.daftarBot === false) return kirimBot(c, id, '🔒 Pendaftaran ujian lagi ditutup admin. Pantau info selanjutnya ya.');
  await c.db.prepare(`INSERT INTO kuis_daftar (tg_id,tg_user,tg_nama,langkah,mulai) VALUES (?,?,?,'nama',?)
    ON CONFLICT(tg_id) DO UPDATE SET tg_user=excluded.tg_user, tg_nama=excluded.tg_nama, langkah='nama', nama=NULL, kode_sales=NULL, fb=NULL,
      mulai=excluded.mulai, dikirim=NULL, diproses=NULL, oleh=NULL, kode=NULL, alasan=NULL`)
    .bind(id, from.username || null, [from.first_name, from.last_name].filter(Boolean).join(' ') || null, Date.now()).run();
  await kirimBot(c, id, `📝 <b>Pendaftaran ${hb(atur.judul)}</b>\nCuma 3 pertanyaan singkat. Ketik /batal kalau mau berhenti.`);
  return tanyaBot(c, id, 'nama');
}
async function isiFormBot(c, d, t) {
  const id = d.tg_id;
  if (!t) return tanyaBot(c, id, d.langkah, 'Jawab pakai teks ya 🙂\n\n');
  if (d.langkah === 'nama') {
    const v = t.replace(/\s+/g, ' ');
    if (!/^\p{L}[\p{L} .'-]{2,59}$/u.test(v)) return tanyaBot(c, id, 'nama', '⚠️ Nama cuma boleh huruf, 3–60 karakter.\n\n');
    await c.db.prepare(`UPDATE kuis_daftar SET nama=?, langkah='kodesales' WHERE tg_id=?`).bind(v, id).run();
    return tanyaBot(c, id, 'kodesales', `Oke, <b>${hb(v.split(' ')[0])}</b> 👍\n\n`);
  }
  if (d.langkah === 'kodesales') {
    const v = t.toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9._\/-]{2,20}$/.test(v)) return tanyaBot(c, id, 'kodesales', '⚠️ Kode sales 2–20 karakter: huruf, angka, titik, strip, atau garis miring.\n\n');
    await c.db.prepare(`UPDATE kuis_daftar SET kode_sales=?, langkah='fb' WHERE tg_id=?`).bind(v, id).run();
    return tanyaBot(c, id, 'fb');
  }
  const v = t.replace(/\s+/g, ' ');
  if (v.length < 2 || v.length > 80) return tanyaBot(c, id, 'fb', '⚠️ Nama halaman 2–80 karakter.\n\n');
  await c.db.prepare(`UPDATE kuis_daftar SET fb=?, langkah='cek' WHERE tg_id=?`).bind(v, id).run();
  return kirimBot(c, id, teksRingkas(Object.assign({}, d, { fb: v })) + '\n\nUdah bener semua?', {
    reply_markup: { inline_keyboard: [[{ text: '✅ Kirim pendaftaran', callback_data: 'd:kirim' }], [{ text: '✏️ Isi ulang', callback_data: 'd:ulang' }]] },
  });
}
async function batalBot(c, id, d) {
  if (!d || ![...LANGKAH_FORM, 'cek'].includes(d.langkah)) return kirimBot(c, id, 'Nggak ada pengisian form yang lagi jalan.');
  await c.db.prepare(`UPDATE kuis_daftar SET langkah='batal' WHERE tg_id=?`).bind(id).run();
  return kirimBot(c, id, 'Oke, pendaftaran dibatalin. Ketik /daftarkuis kapan aja buat mulai lagi.', { reply_markup: { remove_keyboard: true } });
}
async function statusBot(c, from, d) {
  const id = String(from.id);
  if (!d) return kirimBot(c, id, 'Kamu belum daftar ujian. Ketik /daftarkuis buat mulai 🚀');
  if (LANGKAH_FORM.includes(d.langkah) || d.langkah === 'cek') return kirimBot(c, id, 'Pendaftaran kamu belum selesai diisi. Lanjutin jawab pertanyaannya, atau ketik /daftarkuis buat ulang dari awal.');
  if (d.langkah === 'tunggu') return kirimBot(c, id, `⏳ Pendaftaran kamu lagi dicek admin.\nDikirim ${tglJamWIB(d.dikirim)}.\n\nKode ujian dikirim ke sini begitu disetujui.`);
  if (d.langkah === 'tolak') return kirimBot(c, id, teksTolak(d.alasan));
  const u = await ambilUjian(c, d.kode);
  if (u && (u.selesai || Date.now() > u.batas + KUIS_TENGGANG)) {
    const tp = await c.db.prepare('SELECT * FROM kuis_topup WHERE kode=?').bind(d.kode).first();
    return kirimBot(c, id, `✅ Kamu udah selesai ujian. Kode kamu <code>${tampilKode(d.kode)}</code>.\nKetuk tombol di bawah buat lihat hasilnya.${tp ? `\n\n💳 Top up dana iklan: <b>${LABEL_TOPUP[tp.status]}</b>${tp.status === 'minta' || tp.status === 'tolak' ? '\nKetik /topup buat lihat caranya.' : ''}` : ''}`, { reply_markup: tombolUjian(d.kode, '📊 Lihat hasil') });
  }
  if (u) return kirimBot(c, id, `⏱ Ujian kamu masih jalan, sisa sekitar ${Math.max(0, Math.ceil((u.batas - Date.now()) / 60000))} menit.`, { reply_markup: tombolUjian(d.kode, '▶️ Lanjutkan ujian') });
  return kirimBot(c, id, teksKode(await kuisAtur(c), d.kode), { reply_markup: tombolUjian(d.kode) });
}

async function tombolBot(c, q) {
  const id = String(q.from.id), data = String(q.data || ''), msg = q.message;
  const jawab = (text, alert) => tg(c.env, 'answerCallbackQuery', { callback_query_id: q.id, text, show_alert: !!alert }).catch(() => {});
  const ubah = text => (msg ? tg(c.env, 'editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text, parse_mode: 'HTML' }).catch(() => {}) : null);
  const lepasTombol = () => (msg ? tg(c.env, 'editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {}) : null);
  if (data === 'd:kirim' || data === 'd:ulang') {
    const d = await ambilDaftar(c, id);
    if (!d || d.langkah !== 'cek') { await jawab('Form ini udah nggak aktif'); return lepasTombol(); }
    if (data === 'd:ulang') {
      await c.db.prepare(`UPDATE kuis_daftar SET langkah='nama', nama=NULL, kode_sales=NULL, fb=NULL WHERE tg_id=?`).bind(id).run();
      await jawab(); await lepasTombol();
      return tanyaBot(c, id, 'nama', 'Oke, kita isi ulang dari awal ya.\n\n');
    }
    const now = Date.now();
    const r = await c.db.prepare(`UPDATE kuis_daftar SET langkah='tunggu', dikirim=? WHERE tg_id=? AND langkah='cek'`).bind(now, id).run();
    await jawab('Terkirim!');
    await ubah(teksRingkas(d, 'Data pendaftaran kamu:') + '\n\n✅ <b>Terkirim</b>');
    if (!r.meta.changes) return;
    await kirimBot(c, id, '⏳ <b>Pendaftaran terkirim!</b>\nAdmin lagi ngecek data kamu. Begitu disetujui, kode ujian langsung dikirim ke chat ini, jadi jangan di-mute ya 😉\n\nKetik /status buat cek kapan aja.');
    return kabariDaftarBaru(c, Object.assign({}, d, { langkah: 'tunggu', dikirim: now }));
  }
  if (data.startsWith('a:')) {
    const admin = await ambilAdmin(c, id);
    if (!admin) return jawab('Cuma admin yang bisa pakai tombol ini', true);
    return tombolAdmin(c, admin, id, data.slice(2), { jawab, msg });
  }
  if (data === 'v:kirim' || data === 'v:ganti') return tombolVa(c, id, data, { jawab, ubah, lepasTombol });
  const tt = /^t:(ok|no):([A-Z0-9]{6})$/.exec(data);
  if (tt) {
    const admin = await ambilAdmin(c, id);
    if (!admin) return jawab('Cuma admin yang bisa nyetujuin', true);
    c.akun = admin;
    const tp = await c.db.prepare('SELECT * FROM kuis_topup WHERE kode=?').bind(tt[2]).first();
    if (!tp || tp.status !== 'kirim') { await jawab('Pengajuan ini udah diproses'); return lepasTombol(); }
    await prosesTopup(c, tp.kode, tt[1] === 'ok' ? 'ok' : 'tolak', '');
    await jawab(tt[1] === 'ok' ? 'Ditandai udah di-top up' : 'Pengajuan ditolak');
    const info = await infoTopup(c, tp.kode);
    return ubah(`${teksAdminTopup(info)}\n\n${tt[1] === 'ok' ? '✅ <b>Udah di-top up</b>' : '❌ <b>Ditolak</b>'} oleh ${hb(admin.nama)}`);
  }
  const mm = /^(ok|no):(\d+)$/.exec(data);
  if (mm) {
    const admin = await ambilAdmin(c, id);
    if (!admin) return jawab('Cuma admin yang bisa nyetujuin', true);
    c.akun = admin;
    const d = await ambilDaftar(c, mm[2]);
    if (!d || d.langkah !== 'tunggu') { await jawab('Pendaftaran ini udah diproses'); return lepasTombol(); }
    if (mm[1] === 'ok') {
      const x = (await setujuiDaftar(c, [d.tg_id]))[0];
      if (!x) { await jawab('Pendaftaran ini udah diproses'); return lepasTombol(); }
      await jawab(`Disetujui. Kode ${tampilKode(x.kode)}`);
      return ubah(`${teksAdminDaftar(d)}\n\n✅ <b>Disetujui</b> oleh ${hb(admin.nama)}. Kode: <code>${tampilKode(x.kode)}</code>${x.terkirim ? '' : '\n⚠️ Bot gagal ngirim kode ke dia. Kirim manual ya.'}`);
    }
    await tolakDaftar(c, [d.tg_id], '');
    await jawab('Ditolak');
    return ubah(`${teksAdminDaftar(d)}\n\n❌ <b>Ditolak</b> oleh ${hb(admin.nama)}`);
  }
  return jawab();
}

async function kabariDaftarBaru(c, d) {
  const atur = await kuisAtur(c);
  if (!atur.kabariAdmin) return;
  const admin = await semua(c.db.prepare(`SELECT tg_id FROM akun WHERE peran='admin' AND aktif=1 AND tg_id IS NOT NULL LIMIT 5`));
  const ganda = await c.db.prepare(`SELECT nama FROM kuis_daftar WHERE kode_sales=? AND tg_id<>? AND langkah IN ('tunggu','setuju') LIMIT 1`).bind(d.kode_sales, d.tg_id).first();
  const text = teksAdminDaftar(d) + (ganda ? `\n\n⚠️ Kode sales ini juga dipakai <b>${hb(ganda.nama)}</b>` : '');
  const tombol = [[{ text: '✅ Setujui', callback_data: `ok:${d.tg_id}` }, { text: '❌ Tolak', callback_data: `no:${d.tg_id}` }]];
  for (const a of admin) {
    try { await kirimBot(c, a.tg_id, text, { reply_markup: { inline_keyboard: [...tombol, [{ text: '📋 Buka daftar pendaftar', web_app: { url: `${KUIS_URL}?daftar=1` } }]] } }); }
    catch (e) { try { await kirimBot(c, a.tg_id, text, { reply_markup: { inline_keyboard: tombol } }); } catch (err) {} }
  }
}

// Setujui banyak sekaligus: hemat kuota query (semua insert/update dalam 1 perintah)
async function setujuiDaftar(c, ids) {
  const rows = (await semua(c.db.prepare(`SELECT * FROM kuis_daftar WHERE langkah='tunggu' AND tg_id IN (SELECT value FROM json_each(?)) ORDER BY dikirim`)
    .bind(JSON.stringify(ids.map(String))))).slice(0, 30);
  if (!rows.length) return [];
  const ada = new Set((await semua(c.db.prepare('SELECT kode FROM kuis_kode'))).map(r => r.kode));
  const list = rows.map((d, i) => { let k; do k = kodeAcak(); while (ada.has(k)); ada.add(k); return { t: d.tg_id, k, n: d.nama, s: d.kode_sales, f: d.fb, i }; });
  const now = Date.now(), json = JSON.stringify(list);
  await c.db.batch([
    c.db.prepare(`INSERT INTO kuis_kode (kode,nama,ket,dibuat,oleh,tg_id,kode_sales,fb)
      SELECT json_extract(value,'$.k'), json_extract(value,'$.n'), 'Daftar lewat bot', ?1 + json_extract(value,'$.i'), ?2,
        json_extract(value,'$.t'), json_extract(value,'$.s'), json_extract(value,'$.f') FROM json_each(?3)`).bind(now, c.akun.nama, json),
    c.db.prepare(`UPDATE kuis_daftar SET langkah='setuju', diproses=?1, oleh=?2,
      kode=(SELECT json_extract(value,'$.k') FROM json_each(?3) WHERE json_extract(value,'$.t') = kuis_daftar.tg_id)
      WHERE langkah='tunggu' AND tg_id IN (SELECT json_extract(value,'$.t') FROM json_each(?3))`).bind(now, c.akun.nama, json),
  ]);
  const atur = await kuisAtur(c);
  const hasil = [];
  for (const x of list) {
    let terkirim = true;
    try { await kirimBot(c, x.t, teksKode(atur, x.k), { reply_markup: tombolUjian(x.k) }); } catch (e) { terkirim = false; }
    hasil.push({ tg: x.t, nama: x.n, kode: x.k, terkirim });
  }
  return hasil;
}
async function tolakDaftar(c, ids, alasan) {
  alasan = String(alasan || '').trim().slice(0, 300);
  const json = JSON.stringify(ids.map(String));
  const rows = await semua(c.db.prepare(`SELECT tg_id FROM kuis_daftar WHERE langkah='tunggu' AND tg_id IN (SELECT value FROM json_each(?))`).bind(json));
  if (!rows.length) return 0;
  await c.db.prepare(`UPDATE kuis_daftar SET langkah='tolak', alasan=?, diproses=?, oleh=? WHERE langkah='tunggu' AND tg_id IN (SELECT value FROM json_each(?))`)
    .bind(alasan || null, Date.now(), c.akun.nama, json).run();
  for (const r of rows) { try { await kirimBot(c, r.tg_id, teksTolak(alasan)); } catch (e) {} }
  return rows.length;
}
const idList = b => (Array.isArray(b.tg) ? b.tg : [b.tg]).filter(Boolean).map(String).slice(0, 30);
async function kuisAdminDaftarSetuju(c) {
  const ids = idList(c.body);
  if (!ids.length) throw new Gagal('Pilih pendaftar dulu');
  const disetujui = await setujuiDaftar(c, ids);
  if (!disetujui.length) throw new Gagal('Pendaftaran ini udah diproses', 409);
  return Object.assign(await kuisAdminRingkas(c), { hasil: { disetujui } });
}
async function kuisAdminDaftarTolak(c) {
  const ids = idList(c.body);
  if (!ids.length) throw new Gagal('Pilih pendaftar dulu');
  await tolakDaftar(c, ids, c.body.alasan);
  return kuisAdminRingkas(c);
}
// Dipanggil mini app: admin → halaman admin; sales yang udah disetujui → kodenya langsung keisi
async function kuisSaya(c) {
  const id = String(c.tg.id);
  if (await c.db.prepare(`SELECT 1 FROM akun WHERE tg_id=? AND peran='admin' AND aktif=1`).bind(id).first()) return { admin: true };
  const d = await ambilDaftar(c, id);
  if (!d || d.langkah === 'batal') return { status: 'belum' };
  return { status: d.langkah, kode: d.langkah === 'setuju' ? d.kode : null };
}

/* ---------- Bot: mode admin ---------- */
const ambilAdmin = (c, id) => c.db.prepare(`SELECT * FROM akun WHERE tg_id=? AND peran='admin' AND aktif=1`).bind(String(id)).first();
const PERINTAH_ADMIN = [
  { command: 'start', description: 'Menu admin' },
  { command: 'pendaftar', description: 'Setujui atau tolak pendaftar baru' },
  { command: 'topup', description: 'Konfirmasi top up dana iklan' },
  { command: 'rekap', description: 'Rekap nilai & peringkat' },
  { command: 'excel', description: 'Kirim laporan Excel' },
];
const pasangPerintahAdmin = (env, chatId) => tg(env, 'setMyCommands', { commands: PERINTAH_ADMIN, scope: { type: 'chat', chat_id: Number(chatId) } });

async function pesanAdmin(c, admin, id, cmd) {
  c.akun = admin; c.tg = { id };
  if (cmd === 'pendaftar') return kirimPendaftar(c, id);
  if (cmd === 'topup') return kirimTopupAdmin(c, id);
  if (cmd === 'rekap') return kirimRekap(c, id);
  if (cmd === 'excel') return kirimExcelBot(c, id);
  if (['daftarkuis', 'daftar', 'status', 'kodeku', 'batal'].includes(cmd)) {
    await kirimBot(c, id, '😎 Kamu admin, jadi nggak bisa daftar atau ikut ujian. Ini menu kamu:');
    return kirimMenuAdmin(c, id);
  }
  if (cmd === 'start') { await pasangPerintahAdmin(c.env, id).catch(() => {}); return kirimMenuAdmin(c, id); }
  if (['bantuan', 'help', 'menu'].includes(cmd)) return kirimMenuAdmin(c, id);
  if (cmd) return kirimBot(c, id, 'Perintah itu belum ada. Ketik /start buat buka menu admin.');
  return kirimBot(c, id, 'Ketik /start buat buka menu admin 👑');
}

async function isiMenuAdmin(c) {
  const r = await kuisAdminRingkas(c), st = r.statistik, a = r.atur, nDaftar = r.daftar.length;
  const selesai = st.lulus + st.gagal + st.perluNilai;
  const tugas = [];
  const nTopup = r.topup.length;
  if (nDaftar) tugas.push(`🆕 <b>${nDaftar}</b> pendaftar nunggu persetujuan`);
  if (nTopup) tugas.push(`💳 <b>${nTopup}</b> pengajuan top up nunggu konfirmasi`);
  if (st.perluNilai) tugas.push(`✍️ <b>${st.perluNilai}</b> peserta nunggu esainya dinilai`);
  if (st.jalan) tugas.push(`⏱ <b>${st.jalan}</b> lagi ngerjain ujian`);
  const text = [
    `👑 <b>Halo, ${hb(c.akun.nama)}!</b> Kamu masuk sebagai admin <b>${hb(a.judul)}</b>.`, '',
    tugas.length ? tugas.join('\n') : 'Semua beres, nggak ada yang nunggu 👌',
    `👥 ${st.total} peserta, ${selesai} udah selesai${selesai ? `, ${st.lulus} lulus` : ''}${st.rata != null ? `\n📈 Rata-rata ${fmtPoin(st.rata)}, tertinggi ${fmtPoin(st.tertinggi)}` : ''}`,
    r.ujian.jumlah ? '' : '\n⚠️ Bank soal masih kosong. Pasang soal dulu di panel admin.', '',
    `Ujian: ${a.buka ? '🟢 dibuka' : '🔴 ditutup'}\nPendaftaran lewat bot: ${a.daftarBot !== false ? '🟢 dibuka' : '🔴 ditutup'}`, '',
    '<b>Perintah admin</b>',
    '/pendaftar – setujui atau tolak pendaftar',
    '/topup – konfirmasi top up dana iklan',
    '/rekap – nilai & peringkat peserta',
    '/excel – kirim laporan Excel',
    '/start – menu ini', '',
    '<i>Akun admin dikunci dari ujian, jadi aman dari salah klik.</i>',
  ].filter((x, i, arr) => !(x === '' && arr[i - 1] === '')).join('\n');
  const kb = [
    [{ text: '📋 Buka panel admin', web_app: { url: KUIS_URL } }],
    [{ text: `🆕 Pendaftar${nDaftar ? ` (${nDaftar})` : ''}`, callback_data: 'a:pendaftar' }, { text: `💳 Top up${nTopup ? ` (${nTopup})` : ''}`, callback_data: 'a:topup' }],
    [{ text: '📊 Rekap', callback_data: 'a:rekap' }, { text: '📄 Kirim Excel', callback_data: 'a:excel' }],
    [{ text: '🔄 Segarkan', callback_data: 'a:menu' }],
    [{ text: a.buka ? '🔒 Tutup ujian' : '🔓 Buka ujian', callback_data: 'a:ujian' }, { text: a.daftarBot !== false ? '🔒 Tutup pendaftaran' : '🔓 Buka pendaftaran', callback_data: 'a:daftar' }],
  ];
  return { text, reply_markup: { inline_keyboard: kb } };
}
async function kirimMenuAdmin(c, id) { const m = await isiMenuAdmin(c); return kirimBot(c, id, m.text, { reply_markup: m.reply_markup }); }

async function tombolAdmin(c, admin, id, aksi, { jawab, msg }) {
  c.akun = admin; c.tg = { id };
  const segarkanMenu = async () => {
    if (!msg) return kirimMenuAdmin(c, id);
    const m = await isiMenuAdmin(c);
    return tg(c.env, 'editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: m.text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: m.reply_markup }).catch(() => {});
  };
  if (aksi === 'menu') { await jawab('Data terbaru'); return segarkanMenu(); }
  if (aksi === 'ujian' || aksi === 'daftar') {
    const atur = await kuisAtur(c);
    if (aksi === 'ujian') atur.buka = !atur.buka; else atur.daftarBot = atur.daftarBot === false;
    await c.db.prepare(`INSERT OR REPLACE INTO meta (k,v) VALUES ('kuis_atur', ?)`).bind(JSON.stringify(atur)).run();
    await jawab(aksi === 'ujian' ? (atur.buka ? 'Ujian dibuka' : 'Ujian ditutup') : (atur.daftarBot ? 'Pendaftaran dibuka' : 'Pendaftaran ditutup'));
    return segarkanMenu();
  }
  if (aksi === 'pendaftar') { await jawab(); return kirimPendaftar(c, id); }
  if (aksi === 'topup') { await jawab(); return kirimTopupAdmin(c, id); }
  if (aksi === 'rekap') { await jawab(); return kirimRekap(c, id); }
  if (aksi === 'excel') { await jawab('Lagi nyiapin Excel…'); return kirimExcelBot(c, id); }
  if (aksi === 'semua') {
    const ids = (await semua(c.db.prepare(`SELECT tg_id FROM kuis_daftar WHERE langkah='tunggu' ORDER BY dikirim LIMIT 30`))).map(r => r.tg_id);
    if (!ids.length) return jawab('Nggak ada pendaftar yang nunggu');
    const hasil = await setujuiDaftar(c, ids);
    await jawab(`${hasil.length} pendaftar disetujui`);
    const gagal = hasil.filter(x => !x.terkirim);
    if (msg) await tg(c.env, 'editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    return kirimBot(c, id, `✅ <b>${hasil.length} pendaftar disetujui</b>, kode ujiannya udah dikirim bot.${gagal.length ? `\n\n⚠️ Gagal kekirim (kirim manual ya):\n${gagal.map(x => `${hb(x.nama)}: <code>${tampilKode(x.kode)}</code>`).join('\n')}` : ''}`);
  }
  return jawab();
}

async function kirimPendaftar(c, id) {
  const rows = await semua(c.db.prepare(`SELECT d.*, (SELECT x.nama FROM kuis_daftar x WHERE x.kode_sales = d.kode_sales AND x.tg_id <> d.tg_id
    AND x.langkah IN ('tunggu','setuju') LIMIT 1) AS ganda FROM kuis_daftar d WHERE d.langkah='tunggu' ORDER BY d.dikirim`));
  if (!rows.length) return kirimBot(c, id, 'Belum ada pendaftar baru 👌\nNanti aku kabarin begitu ada yang daftar.');
  for (const d of rows.slice(0, 10)) {
    await kirimBot(c, id, teksAdminDaftar(d).replace('🆕 <b>Pendaftar ujian baru</b>', `🆕 <b>Pendaftar</b> (daftar ${jamWIB(d.dikirim)} WIB, ${tanggalPanjang(tanggalWIB(d.dikirim))})`) + (d.ganda ? `\n\n⚠️ Kode sales ini juga dipakai <b>${hb(d.ganda)}</b>` : ''),
      { reply_markup: { inline_keyboard: [[{ text: '✅ Setujui', callback_data: `ok:${d.tg_id}` }, { text: '❌ Tolak', callback_data: `no:${d.tg_id}` }]] } });
  }
  const sisa = rows.length > 10 ? `\nMasih ada ${rows.length - 10} lagi, lihat semuanya di panel admin.` : '';
  if (rows.length > 1) return kirimBot(c, id, `Total <b>${rows.length}</b> pendaftar nunggu.${sisa}`, { reply_markup: { inline_keyboard: [[{ text: `✅ Setujui semua (${Math.min(rows.length, 30)})`, callback_data: 'a:semua' }], [{ text: '📋 Buka panel admin', web_app: { url: `${KUIS_URL}?daftar=1` } }]] } });
}

async function kirimRekap(c, id) {
  const r = await kuisAdminRingkas(c), st = r.statistik;
  const selesai = r.peserta.filter(p => p.status === 'lulus' || p.status === 'gagal').sort((x, y) => y.nilai - x.nilai);
  const nilai = r.peserta.filter(p => p.status === 'nilai');
  const medali = ['🥇', '🥈', '🥉'];
  const text = [
    `📊 <b>Rekap ${hb(r.atur.judul)}</b>`, '',
    `👥 ${st.total} peserta: ${st.belum} belum mulai, ${st.jalan} lagi ujian`,
    `✅ ${st.lulus} lulus, ❌ ${st.gagal} belum lulus, ✍️ ${st.perluNilai} esai nunggu dinilai`,
    st.rata != null ? `📈 Rata-rata ${fmtPoin(st.rata)}, tertinggi ${fmtPoin(st.tertinggi)}, nilai lulus ${r.atur.kkm}` : `Nilai lulus ${r.atur.kkm}`,
    selesai.length ? `\n🏆 <b>Peringkat</b>\n${selesai.slice(0, 10).map((p, i) => `${medali[i] || `${i + 1}.`} ${hb(p.nama)}  <b>${fmtPoin(p.nilai)}</b>${p.status === 'lulus' ? '' : ' ❌'}`).join('\n')}${selesai.length > 10 ? `\n…dan ${selesai.length - 10} lagi` : ''}` : '\nBelum ada yang dapet nilai akhir.',
    nilai.length ? `\n✍️ <b>Esai nunggu dinilai</b>\n${nilai.slice(0, 5).map(p => `• ${hb(p.nama)} (PG ${fmtPoin(p.pg)}/${fmtPoin(p.pgMaks)})`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
  const kb = nilai.slice(0, 3).map(p => [{ text: `✍️ Nilai esai ${p.nama.split(' ')[0]}`, web_app: { url: `${KUIS_URL}?peserta=${p.kode}` } }]);
  kb.push([{ text: '📄 Kirim Excel', callback_data: 'a:excel' }, { text: '📋 Panel admin', web_app: { url: KUIS_URL } }]);
  return kirimBot(c, id, text, { reply_markup: { inline_keyboard: kb } });
}

async function kirimExcelBot(c, id) {
  try { await kuisAdminExcel(c); }
  catch (e) { return kirimBot(c, id, `⚠️ Excel gagal dibuat: ${hb(e.message)}`).catch(() => {}); }
}

/* ---------- Admin: soal dibuatin AI (OpenRouter) ---------- */
const KUIS_AI_HARIAN = 30;
const POIN_JENIS = { pilihan: 6, banyak: 7, data: 7, esai: 8 };
function ambilJsonAi(teks) {
  const t = String(teks || '').replace(/```(?:json)?/gi, '').trim();
  const rapi = v => (Array.isArray(v) ? { soal: v } : v && Array.isArray(v.soal) ? v : v && v.jenis ? { soal: [v] } : null);
  try { return rapi(JSON.parse(t)); } catch (e) {}
  const kandidat = [[t.indexOf('['), t.lastIndexOf(']')], [t.indexOf('{'), t.lastIndexOf('}')]].filter(([a, b]) => a >= 0 && b > a).sort((x, y) => x[0] - y[0]);
  for (const [a, b] of kandidat) { try { const v = rapi(JSON.parse(t.slice(a, b + 1))); if (v) return v; } catch (e) {} }
  return null;
}
async function kuisAdminSoalAi(c) {
  const key = c.env.OPENROUTER_API_KEY;
  if (!key) throw new Gagal('API key OpenRouter belum dipasang. Isi OPENROUTER_API_KEY (tipe Secret) di Cloudflare dulu.', 409, 'AI_KEY');
  const atur = await kuisAtur(c);
  const hari = tanggalWIB(Date.now());
  const pakai = jsonAman(((await c.db.prepare(`SELECT v FROM meta WHERE k='kuis_ai'`).first()) || {}).v, {});
  const sudah = pakai.tgl === hari ? angka(pakai.n) : 0;
  if (sudah >= KUIS_AI_HARIAN) throw new Gagal(`Jatah ${KUIS_AI_HARIAN}× bikin soal pakai AI hari ini udah habis. Coba lagi besok ya.`, 429);
  const b = c.body || {};
  const jumlah = Math.max(1, Math.min(5, Math.round(Number(b.jumlah) || 3)));
  const jenis = KUIS_JENIS[b.jenis] ? b.jenis : 'campur';
  const tingkat = b.tingkat === 'menengah' ? 'menengah' : 'dasar';
  const topik = String(b.topik || '').trim().slice(0, 40);
  const catatan = String(b.catatan || '').trim().slice(0, 400);
  const bank = await bankSoal(c);
  const fokus = tingkat === 'dasar'
    ? 'cara setting iklan pertama kali dan pemahaman fitur Ads Manager: struktur kampanye, tujuan kampanye, set iklan, audiens dan lokasi, anggaran dan jadwal, penempatan, materi iklan, tombol ajakan, iklan yang mengarah ke WhatsApp, peninjauan dan kebijakan iklan, serta membaca laporan dasar (hasil, biaya per hasil, jangkauan, tayangan, frekuensi)'
    : 'pemahaman tingkat menengah: membaca data hasil iklan, memperbaiki iklan yang hasilnya kurang bagus, mengatur anggaran dengan bijak, dan memilih pengaturan yang tepat buat situasi tertentu';
  const sistem = [
    'Kamu pelatih Meta Ads untuk sales force (SF) digital IndiHome di Indonesia. SF beriklan di Facebook dan Instagram lewat Ads Manager, biasanya iklan yang mengarah ke chat WhatsApp, buat jualan paket internet IndiHome di area mereka.',
    'Tugasmu bikin soal ujian seleksi dalam Bahasa Indonesia yang santai tapi jelas (pakai kata "kamu").',
    `Fokus soal: ${fokus}.`,
    'Aturan:',
    '- Cuma tulis fakta yang kamu yakin masih berlaku. Kalau ragu soal angka atau nama fitur yang gampang berubah, jangan dipakai.',
    '- Pengecoh harus masuk akal, jangan konyol. Taruh jawaban benar di posisi yang beda-beda.',
    '- Jangan bikin soal yang mirip sama soal yang udah ada.',
    '- Balas HANYA dengan JSON valid tanpa teks lain, dengan format: {"soal":[ ... ]}',
    'Format tiap soal: {"jenis":"pilihan|banyak|data|esai","topik":"maks 3 kata","konteks":"cerita singkat (opsional)","teks":"pertanyaan","tabel":{"kolom":["..."],"baris":[["..."]]},"opsi":[{"teks":"...","benar":true}],"penjelasan":"kenapa jawabannya benar, 1-3 kalimat","rubrik":["hal yang dicari dari jawaban — x poin"]}',
    '- pilihan: tepat 4 opsi, tepat 1 yang benar. Tanpa tabel.',
    '- banyak: 5 atau 6 opsi, 2 sampai 4 yang benar. Tanpa tabel.',
    '- data: wajib ada tabel berisi angka contoh yang masuk akal (seperti laporan Ads Manager), tepat 4 opsi, tepat 1 yang benar, jawabannya harus bisa dihitung dari tabel.',
    '- esai: tanpa opsi dan tanpa tabel, rubrik 3 sampai 5 baris dengan total 8 poin.',
  ].join('\n');
  const ada = bank.slice(0, 40).map((s, i) => `${i + 1}. ${s.teks.replace(/\s+/g, ' ').slice(0, 140)}`).join('\n');
  const minta = [
    `Buat ${jumlah} soal.`,
    jenis === 'campur' ? 'Jenis soal: campur, utamakan "pilihan", boleh ada "banyak" dan "data".' : `Semua soal jenis "${jenis}".`,
    topik ? `Topik: ${topik}.` : 'Topik: bebas, pilih yang belum banyak dibahas soal yang udah ada.',
    catatan ? `Catatan dari admin: ${catatan}` : '',
    ada ? `\nSoal yang udah ada (jangan diulang):\n${ada}` : '',
  ].filter(Boolean).join('\n');
  await c.db.prepare(`INSERT OR REPLACE INTO meta (k,v) VALUES ('kuis_ai', ?)`).bind(JSON.stringify({ tgl: hari, n: sudah + 1 })).run();
  let res;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': KUIS_URL, 'X-Title': 'Ujian Meta Ads' },
      body: JSON.stringify({ model: atur.modelAi || KUIS_ATUR_AWAL.modelAi, temperature: 0.7, max_tokens: 6000, messages: [{ role: 'system', content: sistem }, { role: 'user', content: minta }] }),
    });
  } catch (e) { throw new Gagal('OpenRouter nggak bisa dihubungi. Coba lagi sebentar.', 502); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) {
    const st = (j.error && j.error.code) || res.status;
    if (st === 401) throw new Gagal('API key OpenRouter salah atau udah dihapus. Cek lagi OPENROUTER_API_KEY di Cloudflare.', 502);
    if (st === 402) throw new Gagal('Kredit OpenRouter kamu habis. Isi kredit, atau ganti ke model gratis di tab Atur.', 502);
    if (st === 429) throw new Gagal('Model AI-nya lagi sibuk atau jatah gratis harian OpenRouter habis. Coba lagi beberapa menit lagi.', 502);
    throw new Gagal('AI gagal nyusun soal: ' + String((j.error && j.error.message) || `OpenRouter ${res.status}`).slice(0, 160), 502);
  }
  const isi = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
  const data = ambilJsonAi(isi);
  const daftar = data && Array.isArray(data.soal) ? data.soal.slice(0, 5) : null;
  if (!daftar || !daftar.length) throw new Gagal('Jawaban AI formatnya rusak. Coba ketuk lagi, atau ganti model di tab Atur.', 502);
  const now = Date.now(), simpan = [];
  let ditolak = 0;
  for (const x of daftar) {
    try {
      const jn = KUIS_JENIS[x && x.jenis] ? x.jenis : null;
      if (!jn) throw new Error('jenis');
      const s = cekSoal(Object.assign({}, x, { jenis: jn, poin: POIN_JENIS[jn], aktif: false, tabel: jn === 'esai' ? null : x.tabel, opsi: (x.opsi || []).map(o => ({ teks: o && o.teks, benar: o && o.benar === true })) }));
      s.aktif = false;
      simpan.push(c.db.prepare(`INSERT INTO kuis_soal (id,urut,jenis,topik,poin,konteks,teks,tabel,opsi,penjelasan,rubrik,aktif,diubah,sumber)
        VALUES (?,(SELECT COALESCE(MAX(urut),0)+1 FROM kuis_soal WHERE urut < 1000),?,?,?,?,?,?,?,?,?,?,?,'ai')`).bind('a' + acak(4), ...nilaiKolomSoal(s), now));
    } catch (e) { ditolak++; }
  }
  if (!simpan.length) throw new Gagal('Semua soal dari AI formatnya nggak lengkap. Coba ketuk lagi, atau ganti model di tab Atur.', 502);
  await c.db.batch(simpan);
  return Object.assign(await kuisAdminSoal(c), { hasilAi: { dibuat: simpan.length, ditolak, model: j.model || atur.modelAi, sisa: KUIS_AI_HARIAN - sudah - 1 } });
}

/* =====================================================================
 * TOP UP DANA IKLAN: lulus → bot minta VA BCA → admin bayar & konfirmasi
 * ===================================================================== */
const LABEL_TOPUP = { minta: 'Nunggu VA dari sales', cek: 'Nunggu VA dari sales', kirim: 'VA dikirim, nunggu admin', selesai: 'Udah di-top up', tolak: 'Ditolak, nunggu VA baru' };
const rupiah = n => 'Rp' + Number(n || 0).toLocaleString('id-ID');
const fmtVa = v => String(v || '').replace(/(\d{4})(?=\d)/g, '$1 ');
const envBotKuis = c => Object.assign({}, c.env, { BOT_TOKEN: c.env.KUIS_BOT_TOKEN || c.env.BOT_TOKEN });
const ambilTopupTg = (c, id) => c.db.prepare('SELECT * FROM kuis_topup WHERE tg_id=? ORDER BY dibuat DESC LIMIT 1').bind(String(id)).first();
async function infoTopup(c, kode) {
  return c.db.prepare(`SELECT t.*, k.nama, k.kode_sales, k.fb, k.tg_id AS tg FROM kuis_topup t JOIN kuis_kode k ON k.kode = t.kode WHERE t.kode=?`).bind(kode).first();
}
function teksCaraVa(atur) {
  return [
    '<b>Cara dapetin nomor VA BCA:</b>',
    '1️⃣ Buka aplikasi <b>Meta Ads Manager</b> (Pengelola Iklan Meta), yang logonya panah putih di lingkaran biru.',
    '2️⃣ Ketuk ikon ⚙️ <b>Pengaturan</b> (<i>Settings</i>) di kiri atas.',
    '3️⃣ Pilih <b>Tagihan & pembayaran</b> (<i>Billing & payments</i>).',
    '4️⃣ Di bagian <b>Dana tersedia</b> (<i>Available funds</i>), ketuk <b>Tambahkan dana</b> (<i>Add funds</i>).',
    atur.nominalTopup
      ? `5️⃣ Ketuk <b>Lainnya</b> (<i>Other</i>), lalu isi jumlah <b>${rupiah(atur.nominalTopup)}</b>. Harus pas ya, jangan dilebihin atau dikurangin.`
      : '5️⃣ Ketuk <b>Lainnya</b> (<i>Other</i>), lalu isi jumlah sesuai arahan admin. Kalau belum tahu nominalnya, tanya admin dulu ya.',
    '6️⃣ Masih di halaman yang sama, di bagian <b>Tambahkan metode pembayaran</b> (<i>Add payment method</i>), pilih <b>Bank Transfer via BCA</b>.',
    '7️⃣ Ketuk <b>Berikutnya</b> (<i>Next</i>) sampai muncul nomor <b>Virtual Account (VA)</b>.',
    '8️⃣ Salin nomor VA-nya, lalu kirim ke chat ini.',
    '',
    '⚠️ Jangan bayar VA-nya sendiri. Biar admin yang bayar, kamu cukup kirim nomornya.',
  ].join('\n');
}
async function mintaTopup(c, kode, paksa) {
  const atur = await kuisAtur(c);
  if (!paksa && atur.topupAktif === false) return { gagal: 'Fitur top up lagi dimatiin di pengaturan' };
  const k = await c.db.prepare('SELECT k.*, u.nilai, u.esai_belum, u.selesai FROM kuis_kode k JOIN kuis_ujian u ON u.kode = k.kode WHERE k.kode=?').bind(kode).first();
  if (!k || !k.selesai || k.esai_belum || !(Number(k.nilai) >= atur.kkm)) return { gagal: 'Peserta ini belum lulus' };
  if (!k.tg_id) return { gagal: 'Peserta ini didaftarin manual, jadi bot nggak bisa ngechat dia. Minta VA-nya lewat chat biasa ya.' };
  const ada = await c.db.prepare('SELECT * FROM kuis_topup WHERE kode=?').bind(kode).first();
  if (ada && !paksa) return { gagal: 'Udah pernah diminta' };
  if (ada && ada.status === 'selesai') return { gagal: 'Dana iklan peserta ini udah di-top up' };
  if (ada && ada.status === 'kirim') return { gagal: 'VA dari peserta ini udah masuk, tinggal dikonfirmasi' };
  await c.db.prepare(`INSERT INTO kuis_topup (kode,tg_id,status,nominal,nilai,dibuat) VALUES (?,?,'minta',?,?,?)
    ON CONFLICT(kode) DO UPDATE SET status='minta', va=NULL, nominal=excluded.nominal, nilai=excluded.nilai`)
    .bind(kode, k.tg_id, atur.nominalTopup || null, k.nilai, Date.now()).run();
  const teks = [
    paksa && ada ? '💳 <b>Pengingat top up dana iklan</b>' : `🎉 <b>Selamat, kamu LULUS ${hb(atur.judul)}!</b>`,
    `Nilai kamu: <b>${fmtPoin(k.nilai)}</b>`, '',
    'Langkah berikutnya: kirim nomor <b>VA BCA</b> dari akun iklan kamu, biar dana iklannya bisa di-top up admin.', '',
    teksCaraVa(atur),
  ].join('\n');
  try { await kirimBot({ env: envBotKuis(c) }, k.tg_id, teks); return { ok: true }; }
  catch (e) { return { ok: true, gagalKirim: true }; }
}
async function topupBot(c, id) {
  const tp = await ambilTopupTg(c, id);
  if (!tp) return kirimBot(c, id, '💳 Top up dana iklan kebuka buat yang udah <b>lulus</b> ujian. Kalau kamu udah lulus, info caranya bakal dikirim otomatis ke sini.');
  const atur = await kuisAtur(c);
  if (tp.status === 'kirim') return kirimBot(c, id, `⏳ VA kamu <code>${fmtVa(tp.va)}</code> udah dikirim ke admin dan lagi diproses. Nanti dikabarin di sini kalau udah di-top up.`);
  if (tp.status === 'selesai') return kirimBot(c, id, `✅ Dana iklan kamu udah di-top up${tp.nominal ? ` sebesar <b>${rupiah(tp.nominal)}</b>` : ''}. Cek di Meta Ads Manager → Tagihan & pembayaran → Dana tersedia.`);
  return kirimBot(c, id, teksCaraVa(atur));
}
async function terimaVa(c, tp, t) {
  const id = tp.tg_id;
  const angkaVa = String(t || '').replace(/[\s.\-]/g, '');
  if (!/^\d+$/.test(angkaVa)) return kirimBot(c, id, 'Kirim <b>nomor VA</b>-nya aja ya, berupa angka. Lupa caranya? Ketik /topup');
  if (angkaVa.length < 10 || angkaVa.length > 20) return kirimBot(c, id, '⚠️ Nomor VA biasanya 10–20 digit angka. Cek lagi ya, lalu kirim ulang.');
  await c.db.prepare(`UPDATE kuis_topup SET status='cek', va=? WHERE kode=?`).bind(angkaVa, tp.kode).run();
  const atur = await kuisAtur(c);
  return kirimBot(c, id, `Cek lagi ya:\n\n🏦 VA BCA: <code>${fmtVa(angkaVa)}</code>${atur.nominalTopup ? `\n💰 Nominal: <b>${rupiah(atur.nominalTopup)}</b>` : ''}\n\nUdah bener?`, {
    reply_markup: { inline_keyboard: [[{ text: '✅ Kirim ke admin', callback_data: 'v:kirim' }], [{ text: '✏️ Ganti nomor', callback_data: 'v:ganti' }]] },
  });
}
async function tombolVa(c, id, data, { jawab, ubah, lepasTombol }) {
  const tp = await ambilTopupTg(c, id);
  if (!tp || tp.status !== 'cek') { await jawab('Pesan ini udah nggak aktif'); return lepasTombol(); }
  if (data === 'v:ganti') {
    await c.db.prepare(`UPDATE kuis_topup SET status='minta', va=NULL WHERE kode=?`).bind(tp.kode).run();
    await jawab(); await lepasTombol();
    return kirimBot(c, id, 'Oke, kirim lagi nomor VA yang bener ke sini ya.');
  }
  const atur = await kuisAtur(c);
  const r = await c.db.prepare(`UPDATE kuis_topup SET status='kirim', dikirim=?, nominal=COALESCE(?, nominal), alasan=NULL WHERE kode=? AND status='cek'`).bind(Date.now(), atur.nominalTopup || null, tp.kode).run();
  await jawab('Terkirim!');
  await ubah(`🏦 VA BCA: <code>${fmtVa(tp.va)}</code>\n\n✅ <b>Terkirim ke admin</b>`);
  if (!r.meta.changes) return;
  await kirimBot(c, id, '⏳ <b>Nomor VA kamu udah dikirim ke admin.</b>\nAdmin bakal bayar VA-nya, terus kamu dikabarin di sini begitu dana iklannya udah masuk.\n\nKetik /topup buat cek statusnya kapan aja.');
  return kabariTopup(c, await infoTopup(c, tp.kode));
}
const teksAdminTopup = t => [
  '💳 <b>Pengajuan top up</b>', '',
  `👤 Nama sales: <b>${hb(t.nama)}</b>`,
  `🪪 Kode sales: ${hb(t.kode_sales || '-')}`,
  `📘 Halaman FB: ${hb(t.fb || '-')}`,
  `📝 Nilai ujian: <b>${fmtPoin(t.nilai)}</b> (lulus)`,
  `💰 Nominal: ${t.nominal ? `<b>${rupiah(t.nominal)}</b>` : 'belum ditentuin'}`,
  `🏦 VA BCA: <code>${hb(t.va)}</code>`,
].join('\n');
const tombolAdminTopup = kode => ({ inline_keyboard: [[{ text: '✅ Udah di-top up', callback_data: `t:ok:${kode}` }, { text: '❌ Tolak', callback_data: `t:no:${kode}` }]] });
async function kabariTopup(c, t) {
  if (!t) return;
  const admin = await semua(c.db.prepare(`SELECT tg_id FROM akun WHERE peran='admin' AND aktif=1 AND tg_id IS NOT NULL LIMIT 5`));
  for (const a of admin) {
    const kb = tombolAdminTopup(t.kode);
    try { await kirimBot({ env: envBotKuis(c) }, a.tg_id, teksAdminTopup(t), { reply_markup: { inline_keyboard: [...kb.inline_keyboard, [{ text: '📋 Buka panel admin', web_app: { url: `${KUIS_URL}?peserta=${t.kode}` } }]] } }); }
    catch (e) { try { await kirimBot({ env: envBotKuis(c) }, a.tg_id, teksAdminTopup(t), { reply_markup: kb }); } catch (err) {} }
  }
}
async function prosesTopup(c, kode, aksi, alasan) {
  alasan = String(alasan || '').trim().slice(0, 300);
  const t = await infoTopup(c, kode);
  if (!t || t.status !== 'kirim') throw new Gagal('Pengajuan ini udah diproses atau belum ada VA-nya', 409);
  const status = aksi === 'ok' ? 'selesai' : 'tolak';
  await c.db.prepare(`UPDATE kuis_topup SET status=?, diproses=?, oleh=?, alasan=? WHERE kode=? AND status='kirim'`).bind(status, Date.now(), c.akun.nama, status === 'tolak' ? alasan || null : null, kode).run();
  const teks = status === 'selesai'
    ? `✅ <b>Dana iklan kamu udah di-top up!</b>${t.nominal ? `\nSebesar <b>${rupiah(t.nominal)}</b>.` : ''}\n\nCek di Meta Ads Manager → Tagihan & pembayaran → Dana tersedia. Biasanya saldonya muncul nggak lama setelah dibayar.\n\nSelamat ngiklan, semoga closing-nya lancar 🚀`
    : `❌ <b>Pengajuan top up kamu belum bisa diproses.</b>${alasan ? `\nAlasan: ${hb(alasan)}` : ''}\n\nBikin VA baru pakai cara yang sama (ketik /topup), lalu kirim lagi nomornya ke sini.`;
  try { await kirimBot({ env: envBotKuis(c) }, t.tg, teks); } catch (e) {}
}
async function kirimTopupAdmin(c, id) {
  const rows = await semua(c.db.prepare(`SELECT t.*, k.nama, k.kode_sales, k.fb FROM kuis_topup t JOIN kuis_kode k ON k.kode = t.kode WHERE t.status='kirim' ORDER BY t.dikirim LIMIT 10`));
  if (!rows.length) return kirimBot(c, id, 'Belum ada pengajuan top up yang nunggu 👌');
  for (const t of rows) await kirimBot(c, id, teksAdminTopup(t), { reply_markup: tombolAdminTopup(t.kode) });
}
async function kuisAdminTopupProses(c) {
  const k = await ambilKode(c, c.body.kode);
  await prosesTopup(c, k.kode, c.body.aksi === 'ok' ? 'ok' : 'tolak', c.body.alasan);
  return kuisAdminRingkas(c);
}
async function kuisAdminTopupMinta(c) {
  const k = await ambilKode(c, c.body.kode);
  const r = await mintaTopup(c, k.kode, true);
  if (r.gagal) throw new Gagal(r.gagal, 409);
  if (r.gagalKirim) throw new Gagal('Bot gagal ngirim pesan ke peserta ini, mungkin bot-nya diblokir. Minta VA-nya lewat chat biasa ya.', 502);
  return kuisAdminDetail(c);
}

// 15 soal bawaan, terenkripsi. Dibuka admin dari halaman kuis pakai "kode buka".
const KUIS_BAWAAN = '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';
