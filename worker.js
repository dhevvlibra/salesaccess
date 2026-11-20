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
      return teks([
        'Server Sales Quest aktif ✅',
        `Database: ${env.DB ? 'tersambung' : 'BELUM tersambung'}`,
        `Token bot: ${env.BOT_TOKEN ? 'sudah diisi' : 'BELUM diisi'}`,
        `Grup laporan: ${env.CHAT_ID ? 'sudah diisi' : 'BELUM diisi'}`,
        'Kuis Meta Ads: siap',
      ].join('\n'));
    }
    if (request.method !== 'POST' || !url.pathname.startsWith('/api/')) return json({ ok: false, error: 'Alamat tidak dikenal' }, 404, cors);

    try {
      if (!env.DB) throw new Gagal('Server belum tersambung ke database', 500);
      await siapkanDB(env);
      let body = {};
      try { body = await request.json(); } catch (e) {}
      const rute = url.pathname.slice(5);
      // Peserta kuis cukup pakai kode akses: bisa dari browser biasa, nggak wajib Telegram
      if (rute.startsWith('kuis/') && !rute.startsWith('kuis/admin/')) {
        const hasil = await jalankanKuis(rute, { env, db: env.DB, body: body || {}, ctx });
        return json(Object.assign({ ok: true }, hasil), 200, cors);
      }
      if (!env.BOT_TOKEN) throw new Gagal('Server belum diisi token bot', 500);
      const tgUser = await cekInitData(request.headers.get('X-Telegram-Init-Data') || '', env.BOT_TOKEN);
      if (!tgUser) throw new Gagal('Buka app-nya lewat Telegram dulu', 401);
      const c = { env, db: env.DB, tg: tgUser, body: body || {}, ctx };
      if (rute === 'foto') return await foto(c, cors);
      if (rute.startsWith('kuis/admin/')) {
        c.akun = await akunAktif(c);
        if (c.akun.peran !== 'admin') throw new Gagal('Menu ini khusus admin', 403);
        return json(Object.assign({ ok: true }, await jalankanKuisAdmin(rute, c)), 200, cors);
      }
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
const KUIS_ATUR_AWAL = { judul: 'Ujian Meta Ads', subjudul: 'Seleksi SF Digital', durasi: 30, kkm: 75, buka: true, tampilNilai: true, kabariAdmin: true, linkMiniApp: false, petunjuk: '' };
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
  const b = { kode: k.kode, nama: k.nama, ket: k.ket || '', dibuat: k.dibuat, keluar: e.keluar, keluarDetik: e.detik, tempel: e.tempel, pindah: e.pindah };
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
  return { atur, ujian: infoUjian(atur, bank), peserta, statistik, sekarang: Date.now(), admin: c.akun.nama };
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
    durasi, kkm, buka: !!x.buka, tampilNilai: !!x.tampilNilai, kabariAdmin: !!x.kabariAdmin, linkMiniApp: !!x.linkMiniApp, petunjuk: String(x.petunjuk || '').trim().slice(0, 800),
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
    peserta.push([p.nama, tampilKode(p.kode), p.ket, LABEL[p.status], waktuWIB(p.mulai), waktuWIB(p.selesai), p.mulai && p.selesai ? Math.round((p.selesai - p.mulai) / 6000) / 10 : '',
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
    { nama: 'Peserta', kolom: [['Nama', 24], ['Kode', 10], ['Keterangan', 16], ['Status', 18], ['Mulai (WIB)', 17], ['Selesai (WIB)', 17], ['Lama (menit)', 12], ['Cara selesai', 16], ['Terjawab', 10], ['Skor pilihan ganda', 18], ['Maks PG', 9], ['Skor esai', 10], ['Maks esai', 10], ['Nilai akhir', 11], ['KKM', 6], ['Keluar app (×)', 14], ['Lama di luar (detik)', 19], ['Tempel diblokir (×)', 19], ['Dibuka ulang (×)', 16]], baris: peserta },
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

// 15 soal bawaan, terenkripsi. Dibuka admin dari halaman kuis pakai "kode buka".
const KUIS_BAWAAN = '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';
