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
const KUIS_ATUR_AWAL = { judul: 'Ujian Meta Ads', subjudul: 'Seleksi SF Digital', durasi: 30, kkm: 75, buka: true, tampilNilai: true, kabariAdmin: true, linkMiniApp: false, daftarBot: true, modelAi: 'openrouter/free', petunjuk: '' };
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
  return {
    judul: atur.judul, subjudul: atur.subjudul, durasi: atur.durasi, kkm: atur.kkm, petunjuk: atur.petunjuk || '',
    jumlah: aktif.length, perJenis, poin: bulat1(aktif.reduce((t, s) => t + s.poin, 0)), tampilNilai: !!atur.tampilNilai,
  };
}

// Urutan soal tiap peserta: pilihan ganda diacak, esai di akhir (ikut diacak). Pilihan jawaban juga diacak.
function susunUrutan(bank) {
  const aktif = bank.filter(s => s.aktif);
  const biasa = kocok(aktif.filter(s => s.jenis !== 'esai')), esai = kocok(aktif.filter(s => s.jenis === 'esai'));
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
    const urutan = susunUrutan(bank);
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
function barisPeserta(k, u, e, atur) {
  e = e || { keluar: 0, detik: 0, tempel: 0, pindah: 0 };
  const b = { kode: k.kode, nama: k.nama, ket: k.ket || '', ks: k.kode_sales || '', fb: k.fb || '', bot: !!k.tg_id, dibuat: k.dibuat, keluar: e.keluar, keluarDetik: e.detik, tempel: e.tempel, pindah: e.pindah };
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
  const [atur, bank, kode, ujian, ev] = await Promise.all([
    kuisAtur(c), bankSoal(c),
    semua(c.db.prepare('SELECT * FROM kuis_kode ORDER BY dibuat DESC, nama COLLATE NOCASE')),
    semua(c.db.prepare('SELECT * FROM kuis_ujian')), statLog(c),
  ]);
  const petaU = new Map(ujian.map(u => [u.kode, u]));
  const peserta = kode.map(k => barisPeserta(k, petaU.get(k.kode), ev.get(k.kode), atur));
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
  return { atur, ujian: infoUjian(atur, bank), peserta, statistik, daftar, sekarang: Date.now(), admin: c.akun.nama, bot: await namaBot(c), ai: !!c.env.OPENROUTER_API_KEY };
}

async function kuisAdminDetail(c) {
  const k = await ambilKode(c, c.body.kode);
  const atur = await kuisAtur(c);
  const u = await rapikanUjian(c, await ambilUjian(c, k.kode), k);
  const e = (await statLog(c, k.kode)).get(k.kode);
  const peserta = barisPeserta(k, u, e, atur);
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
    ...daftar.map((x, i) => c.db.prepare('INSERT OR REPLACE INTO kuis_soal (id,urut,jenis,topik,poin,konteks,teks,tabel,opsi,penjelasan,rubrik,aktif,diubah) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(String(x.id), i + 1, ...nilaiKolomSoal(Object.assign(cekSoal(x), { aktif: true })), now)),
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
  const atur = {
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
  const LABEL = { belum: 'Belum mulai', jalan: 'Lagi mengerjakan', nilai: 'Esai belum dinilai', lulus: 'LULUS', gagal: 'Belum lulus' };
  const peserta = [], jawaban = [];
  for (const k of kode) {
    const u = petaU.get(k.kode), p = barisPeserta(k, u, ev.get(k.kode), atur);
    peserta.push([p.nama, tampilKode(p.kode), p.ks, p.fb, p.ket, LABEL[p.status], waktuWIB(p.mulai), waktuWIB(p.selesai), p.mulai && p.selesai ? Math.round((p.selesai - p.mulai) / 6000) / 10 : '',
      p.alasan ? KUIS_CARA[p.alasan] || p.alasan : '', p.jumlah ? `${p.terjawab}/${p.jumlah}` : '', p.pg == null ? '' : bulat2(p.pg), p.pgMaks == null ? '' : bulat2(p.pgMaks),
      p.esai == null ? '' : bulat2(p.esai), p.esaiMaks == null ? '' : bulat2(p.esaiMaks), p.status === 'lulus' || p.status === 'gagal' ? bulat1(p.nilai) : '', atur.kkm,
      p.keluar, p.keluarDetik, p.tempel, p.sesi ? p.sesi - 1 : 0]);
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
    { nama: 'Peserta', kolom: [['Nama', 24], ['Kode', 10], ['Kode sales', 13], ['Halaman Facebook', 24], ['Keterangan', 16], ['Status', 18], ['Mulai (WIB)', 17], ['Selesai (WIB)', 17], ['Lama (menit)', 12], ['Cara selesai', 16], ['Terjawab', 10], ['Skor pilihan ganda', 18], ['Maks PG', 9], ['Skor esai', 10], ['Maks esai', 10], ['Nilai akhir', 11], ['KKM', 6], ['Keluar app (×)', 14], ['Lama di luar (detik)', 19], ['Tempel diblokir (×)', 19], ['Dibuka ulang (×)', 16]], baris: peserta },
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
  if (cmd) return kirimBot(c, id, 'Perintah itu belum ada 🤔\nCoba /daftarkuis buat daftar, atau /status buat cek pendaftaran.');
  if (d && LANGKAH_FORM.includes(d.langkah)) return isiFormBot(c, d, t);
  if (d && d.langkah === 'cek') return kirimBot(c, id, 'Tinggal satu langkah lagi! Ketuk <b>Kirim pendaftaran</b> di pesan sebelumnya, atau <b>Isi ulang</b> kalau ada yang salah.');
  return kirimBot(c, id, 'Hai! 👋 Ketik /daftarkuis buat daftar ujian, atau /status buat cek pendaftaran kamu.');
}

async function sapaBot(c, from, d) {
  if (d && d.langkah === 'setuju') return statusBot(c, from, d);
  const atur = await kuisAtur(c);
  const n = await c.db.prepare('SELECT COUNT(*) AS n FROM kuis_soal WHERE aktif=1').first();
  const jumlah = angka(n && n.n);
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
  if (u && (u.selesai || Date.now() > u.batas + KUIS_TENGGANG)) return kirimBot(c, id, `✅ Kamu udah selesai ujian. Kode kamu <code>${tampilKode(d.kode)}</code>.\nKetuk tombol di bawah buat lihat hasilnya.`, { reply_markup: tombolUjian(d.kode, '📊 Lihat hasil') });
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
  { command: 'rekap', description: 'Rekap nilai & peringkat' },
  { command: 'excel', description: 'Kirim laporan Excel' },
];
const pasangPerintahAdmin = (env, chatId) => tg(env, 'setMyCommands', { commands: PERINTAH_ADMIN, scope: { type: 'chat', chat_id: Number(chatId) } });

async function pesanAdmin(c, admin, id, cmd) {
  c.akun = admin; c.tg = { id };
  if (cmd === 'pendaftar') return kirimPendaftar(c, id);
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
  if (nDaftar) tugas.push(`🆕 <b>${nDaftar}</b> pendaftar nunggu persetujuan`);
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
    '/rekap – nilai & peringkat peserta',
    '/excel – kirim laporan Excel',
    '/start – menu ini', '',
    '<i>Akun admin dikunci dari ujian, jadi aman dari salah klik.</i>',
  ].filter((x, i, arr) => !(x === '' && arr[i - 1] === '')).join('\n');
  const kb = [
    [{ text: '📋 Buka panel admin', web_app: { url: KUIS_URL } }],
    [{ text: `🆕 Pendaftar${nDaftar ? ` (${nDaftar})` : ''}`, callback_data: 'a:pendaftar' }, { text: '📊 Rekap', callback_data: 'a:rekap' }],
    [{ text: '📄 Kirim Excel', callback_data: 'a:excel' }, { text: '🔄 Segarkan', callback_data: 'a:menu' }],
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

// 15 soal bawaan, terenkripsi. Dibuka admin dari halaman kuis pakai "kode buka".
const KUIS_BAWAAN = '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';
