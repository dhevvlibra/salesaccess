/**
 * Server Sales Quest (Cloudflare Worker + database D1)
 *
 * Pengaturan ada di wrangler.jsonc (nama Worker, ID database, ID grup).
 * Token bot diisi di dashboard Cloudflare: Settings → Variables and Secrets → BOT_TOKEN (tipe Secret).
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
  async fetch(request, env) {
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
      ].join('\n'));
    }
    if (request.method !== 'POST' || !url.pathname.startsWith('/api/')) return json({ ok: false, error: 'Alamat tidak dikenal' }, 404, cors);

    try {
      if (!env.DB) throw new Gagal('Server belum tersambung ke database', 500);
      if (!env.BOT_TOKEN) throw new Gagal('Server belum diisi token bot', 500);
      await siapkanDB(env);
      const tgUser = await cekInitData(request.headers.get('X-Telegram-Init-Data') || '', env.BOT_TOKEN);
      if (!tgUser) throw new Gagal('Buka app-nya lewat Telegram dulu', 401);
      let body = {};
      try { body = await request.json(); } catch (e) {}
      const c = { env, db: env.DB, tg: tgUser, body: body || {} };
      const rute = url.pathname.slice(5);
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
