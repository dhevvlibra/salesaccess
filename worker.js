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
        const hasil = await jalankanKuis(rute, { env: envKuis(), db: env.DB, body: body || {}, ctx });
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
const KUIS_ATUR_AWAL = { judul: 'Ujian Meta Ads', subjudul: 'Seleksi SF Digital', durasi: 30, kkm: 75, buka: true, tampilNilai: true, kabariAdmin: true, linkMiniApp: false, daftarBot: true, petunjuk: '' };
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
    aktif: !!r.aktif, diubah: r.diubah,
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
  return { atur, ujian: infoUjian(atur, bank), peserta, statistik, daftar, sekarang: Date.now(), admin: c.akun.nama, bot: await namaBot(c) };
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
  return { soal: bank, ujian: infoUjian(await kuisAtur(c), bank), dipakai: angka(pakai && pakai.n) };
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
    const r = await c.db.prepare('UPDATE kuis_soal SET jenis=?, topik=?, poin=?, konteks=?, teks=?, tabel=?, opsi=?, penjelasan=?, rubrik=?, aktif=?, diubah=? WHERE id=?').bind(...nilaiKolomSoal(s), now, id).run();
    if (!r.meta.changes) throw new Gagal('Soal nggak ditemukan', 404);
  } else {
    await c.db.prepare(`INSERT INTO kuis_soal (id,urut,jenis,topik,poin,konteks,teks,tabel,opsi,penjelasan,rubrik,aktif,diubah)
      VALUES (?,(SELECT COALESCE(MAX(urut),0)+1 FROM kuis_soal),?,?,?,?,?,?,?,?,?,?,?)`).bind('s' + acak(4), ...nilaiKolomSoal(s), now).run();
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
    c.db.prepare('DELETE FROM kuis_soal'),
    ...daftar.map((x, i) => c.db.prepare('INSERT INTO kuis_soal (id,urut,jenis,topik,poin,konteks,teks,tabel,opsi,penjelasan,rubrik,aktif,diubah) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(String(x.id), i + 1, ...nilaiKolomSoal(cekSoal(x)), now)),
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
    durasi, kkm, buka: !!x.buka, tampilNilai: !!x.tampilNilai, kabariAdmin: !!x.kabariAdmin, linkMiniApp: !!x.linkMiniApp, daftarBot: !!x.daftarBot, petunjuk: String(x.petunjuk || '').trim().slice(0, 800),
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
    `Di sini skill Meta Ads kamu dites beneran: nyusun kampanye yang pas buat dapet chat WhatsApp, baca angka hasil iklan, sampai ngatur budget biar tiap closing tetap untung. Isinya ${jumlah ? `${jumlah} soal, ` : ''}${atur.durasi} menit, nilai lulus ${atur.kkm}.`, '',
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
  const mm = /^(ok|no):(\d+)$/.exec(data);
  if (mm) {
    const admin = await c.db.prepare(`SELECT * FROM akun WHERE tg_id=? AND peran='admin' AND aktif=1`).bind(id).first();
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

// 15 soal bawaan, terenkripsi. Dibuka admin dari halaman kuis pakai "kode buka".
const KUIS_BAWAAN = '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';
