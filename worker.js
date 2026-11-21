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
  if (/^g:(paham|[1-6])$/.test(data)) return tombolTutorial(c, id, data.slice(2), msg, { jawab, lepasTombol });
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
    teksTanyaVa(atur),
  ].join('\n');
  try { await kirimBot({ env: envBotKuis(c) }, k.tg_id, teks, { reply_markup: TOMBOL_PAHAM }); return { ok: true }; }
  catch (e) { return { ok: true, gagalKirim: true }; }
}
async function topupBot(c, id) {
  const tp = await ambilTopupTg(c, id);
  if (!tp) return kirimBot(c, id, '💳 Top up dana iklan kebuka buat yang udah <b>lulus</b> ujian. Kalau kamu udah lulus, info caranya bakal dikirim otomatis ke sini.');
  const atur = await kuisAtur(c);
  if (tp.status === 'kirim') return kirimBot(c, id, `⏳ VA kamu <code>${fmtVa(tp.va)}</code> udah dikirim ke admin dan lagi diproses. Nanti dikabarin di sini kalau udah di-top up.`);
  if (tp.status === 'selesai') return kirimBot(c, id, `✅ Dana iklan kamu udah di-top up${tp.nominal ? ` sebesar <b>${rupiah(tp.nominal)}</b>` : ''}. Cek di Meta Ads Manager → Tagihan & pembayaran → Dana tersedia.`);
  return kirimBot(c, id, teksTanyaVa(atur), { reply_markup: TOMBOL_PAHAM });
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

/* ---------- Tutorial VA bergambar (satu pesan, geser pakai Sebelumnya/Selanjutnya) ---------- */
const FOTO_VA = n => KUIS_URL.replace(/[^/]*$/, '') + `va-${n}.jpg`; // file va-1.jpg … va-6.jpg di repo GitHub
const TOMBOL_PAHAM = { inline_keyboard: [[{ text: '✅ Udah paham', callback_data: 'g:paham' }, { text: '📖 Belum, kasih tutorial', callback_data: 'g:1' }]] };
function teksTanyaVa(atur) {
  return [
    'Langkah berikutnya: kirim nomor <b>VA BCA</b> dari akun iklan Meta kamu, biar dana iklannya bisa di-top up admin.',
    atur.nominalTopup ? `💰 Jumlah yang diisi waktu bikin VA: <b>${rupiah(atur.nominalTopup)}</b>` : '💰 Jumlahnya tanya admin dulu ya sebelum bikin VA.',
    '⚠️ Jangan bayar VA-nya sendiri. Biar admin yang bayar, kamu cukup kirim nomornya.', '',
    '<b>Udah tahu cara dapetin nomor VA BCA di Meta Ads Manager?</b>',
  ].join('\n');
}
function langkahVa(n, atur) {
  const t = {
    1: 'Buka aplikasi <b>Meta Ads Manager</b> (Pengelola Iklan Meta), yang logonya panah putih di lingkaran biru. Belum punya? Download dulu di Play Store atau App Store.',
    2: 'Ketuk ikon ⚙️ <b>Pengaturan</b> (<i>Settings</i>) di kiri atas.',
    3: 'Ketuk <b>Tagihan & pembayaran</b> (<i>Billing & payments</i>) di akun iklan kamu.',
    4: 'Di bagian <b>Dana tersedia</b> (<i>Available funds</i>), ketuk <b>Tambahkan dana</b> (<i>Add funds</i>).',
    5: atur.nominalTopup
      ? `Ketuk <b>Lainnya</b> (<i>Other</i>), lalu isi jumlah <b>${rupiah(atur.nominalTopup)}</b>. Harus pas ya, jangan dilebihin atau dikurangin.`
      : 'Ketuk <b>Lainnya</b> (<i>Other</i>), lalu isi jumlah sesuai arahan admin. Belum tahu nominalnya? Tanya admin dulu ya.',
    6: 'Scroll ke bawah ke <b>Tambahkan metode pembayaran</b> (<i>Add payment method</i>), pilih <b>Bank Transfer via BCA</b>, lalu ketuk <b>Berikutnya</b> (<i>Next</i>).\n\nNanti muncul nomor <b>Virtual Account (VA)</b>. Salin nomornya, terus kirim ke chat ini 👇\n\n⚠️ Jangan bayar VA-nya sendiri, biar admin yang bayar.',
  }[n];
  const nav = [];
  if (n > 1) nav.push({ text: '⬅️ Sebelumnya', callback_data: `g:${n - 1}` });
  if (n < 6) nav.push({ text: 'Selanjutnya ➡️', callback_data: `g:${n + 1}` });
  const kb = [nav];
  if (n === 6) kb.push([{ text: '✅ Udah dapet nomor VA-nya', callback_data: 'g:paham' }]);
  return { caption: `<b>Langkah ${n} dari 6</b>\n${t}`, reply_markup: { inline_keyboard: kb } };
}
async function fotoTersimpan(c) { return jsonAman(((await c.db.prepare(`SELECT v FROM meta WHERE k='va_foto'`).first()) || {}).v, {}); }
async function simpanFoto(c, url, hasil) {
  const p = hasil && hasil.result && hasil.result.photo;
  if (!p || !p.length) return;
  const peta = await fotoTersimpan(c);
  if (peta[url] === p[p.length - 1].file_id) return;
  peta[url] = p[p.length - 1].file_id;
  await c.db.prepare(`INSERT OR REPLACE INTO meta (k,v) VALUES ('va_foto', ?)`).bind(JSON.stringify(peta)).run();
}
async function tombolTutorial(c, id, langkah, msg, { jawab, lepasTombol }) {
  const tp = await ambilTopupTg(c, id);
  if (!tp || !['minta', 'tolak', 'cek'].includes(tp.status)) { await jawab(tp ? 'Top up kamu udah diproses' : 'Fitur ini buat yang udah lulus'); return lepasTombol(); }
  const atur = await kuisAtur(c);
  if (langkah === 'paham') {
    await jawab(); await lepasTombol();
    return kirimBot(c, id, `Sip! 👍 Kirim <b>nomor VA BCA</b>-nya ke sini ya.${atur.nominalTopup ? `\nPastiin waktu bikin VA, jumlahnya <b>${rupiah(atur.nominalTopup)}</b>.` : ''}\n\nLupa caranya? Ketik /topup`);
  }
  const n = Number(langkah), url = FOTO_VA(n), isi = langkahVa(n, atur), peta = await fotoTersimpan(c);
  const foto = peta[url] || url;
  await jawab();
  // Lagi di pesan tutorial → ganti gambarnya di pesan yang sama
  if (msg && msg.photo) {
    try {
      const r = await tg(c.env, 'editMessageMedia', { chat_id: msg.chat.id, message_id: msg.message_id, media: { type: 'photo', media: foto, caption: isi.caption, parse_mode: 'HTML' }, reply_markup: isi.reply_markup });
      return simpanFoto(c, url, r);
    } catch (e) { /* pesan lama nggak bisa diedit: kirim baru */ }
  } else await lepasTombol();
  for (const f of foto === url ? [url] : [foto, url]) {
    try {
      const r = await tg(c.env, 'sendPhoto', { chat_id: id, photo: f, caption: isi.caption, parse_mode: 'HTML', reply_markup: isi.reply_markup });
      return simpanFoto(c, url, r);
    } catch (e) { /* coba berikutnya */ }
  }
  {
    // Gambar belum ke-upload atau gagal dibuka Telegram: kirim versi teks
    return kirimBot(c, id, teksCaraVa(atur));
  }
}

// 15 soal bawaan, terenkripsi. Dibuka admin dari halaman kuis pakai "kode buka".
const KUIS_BAWAAN = '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';
