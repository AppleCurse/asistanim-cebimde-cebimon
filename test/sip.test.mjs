import test from 'node:test';
import assert from 'node:assert/strict';
import { netstringKodla, NetstringAyristirici, pcmToWav, hesaplaRMS } from '../beyin/kopru/sip.mjs';

test('SIP: netstring kodlama ve ayristirma', () => {
  const veri = { command: 'dial', params: '00905550000000' };
  const kodlu = netstringKodla(veri);
  assert.equal(kodlu, `${Buffer.byteLength(JSON.stringify(veri))}:${JSON.stringify(veri)},`);

  const mesajlar = [];
  const ayristirici = new NetstringAyristirici((m) => mesajlar.push(m));

  // Parçalı besleme testi
  const yarim1 = kodlu.slice(0, 10);
  const yarim2 = kodlu.slice(10);
  ayristirici.besle(Buffer.from(yarim1));
  assert.equal(mesajlar.length, 0);
  ayristirici.besle(Buffer.from(yarim2));
  assert.equal(mesajlar.length, 1);
  assert.deepEqual(mesajlar[0], veri);

  // Satır bazlı düz JSON testi
  ayristirici.besle(Buffer.from('{"event":true,"type":"CALL_ESTABLISHED"}\n'));
  assert.equal(mesajlar.length, 2);
  assert.equal(mesajlar[1].type, 'CALL_ESTABLISHED');
});

test('SIP: pcmToWav standart 44 byte RIFF header üretir', () => {
  const pcm = Buffer.alloc(320); // 20ms ses
  const wav = pcmToWav(pcm, 8000, 1);
  assert.equal(wav.length, 44 + 320);
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 8000); // sample rate
  assert.equal(wav.readUInt16LE(22), 1);    // channels
  assert.equal(wav.readUInt16LE(34), 16);   // bits per sample
});

test('SIP: hesaplaRMS sessizlik ve sinyal enerjisini doğru ölçer', () => {
  const sessiz = Buffer.alloc(320);
  assert.equal(hesaplaRMS(sessiz), 0);

  const sinyal = Buffer.alloc(320);
  for (let i = 0; i < 320; i += 2) {
    sinyal.writeInt16LE(1000, i);
  }
  const rms = Math.round(hesaplaRMS(sinyal));
  assert.equal(rms, 1000);
});

// ─── Ses gidiş hattı: arama kapısı + besleyici kendi kendine iyileştirme ───

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SipKoprusu } from '../beyin/kopru/sip.mjs';

const sessizLog = { bilgi() {}, uyari() {}, hata() {} };

function sahteKopru({ tmp, ...ek }) {
  return new SipKoprusu({
    llm: {},
    gorevler: {},
    ayar: {},
    log: sessizLog,
    port: 59999, // kimse dinlemiyor — bağlantı reddedilir
    fifoDizini: tmp,
    sesKapisiYolu: path.join(tmp, 'ses-kanali-ok'),
    ...ek,
  });
}

test('SIP: arama kapısı — ses testi yeşil değilken arama ÇALDIRILMAZ', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sip-kapi-'));
  const kopru = sahteKopru({ tmp });
  await assert.rejects(
    () => kopru.ara({ numara: '05550000000' }),
    (e) => /ses testi yeşil/.test(e.message),
    'kapı kapalıyken arama başlamamalı',
  );
  // İşaret (ses-testi.sh yeşil sonucu) varsa kapı açılır — engel artık kapı hatası değildir
  fs.writeFileSync(kopru.sesKapisiYolu, '');
  await assert.rejects(
    () => kopru.ara({ numara: '05550000000' }),
    (e) => !/ses testi/.test(e.message),
    'kapı açıkken hata başka bir kaynaktan gelmeli (ctrl_tcp bağlantısı)',
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('SIP: besleyici yazma hatasını yutmaz; sayar, loglar ve fd\'yi yeniden açar', { skip: process.platform === 'win32' ? 'mkfifo Windows üzerinde bulunmaz' : false }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sip-besleyici-'));
  execFileSync('mkfifo', [path.join(tmp, 'mic.raw'), path.join(tmp, 'spk.raw')]);

  const kayitlar = [];
  const log = {
    bilgi: (...a) => kayitlar.push(['bilgi', a.join(' ')]),
    uyari: (...a) => kayitlar.push(['uyari', a.join(' ')]),
    hata: (...a) => kayitlar.push(['hata', a.join(' ')]),
  };
  const kopru = new SipKoprusu({
    llm: {}, gorevler: {}, ayar: {}, log,
    fifoDizini: tmp,
    sesKapisiYolu: path.join(tmp, 'ses-kanali-ok'),
    yazmaHatasiKurtarmaMs: 50, // testte 5 sn yerine 50 ms
  });

  // Geçersiz fd taklidi: besleyici EBADF görecek — eskiden bunu sessizce yutuyordu
  kopru.inFifoFd = 9999;
  kopru._sesBesleyiciBaslat();
  await new Promise((r) => setTimeout(r, 400));
  clearInterval(kopru.besleyiciZamanlayici);

  assert.ok(kopru.besleyiciHataSayaci >= 1, `yazma hatası SAYILMALI (sayı: ${kopru.besleyiciHataSayaci})`);
  assert.ok(kopru.besleyiciBasariliSayac >= 10, `fd yeniden açılınca paketler akmalı (${kopru.besleyiciBasariliSayac})`);
  assert.ok(
    kayitlar.some(([s, m]) => s === 'uyari' && /mic\.raw/.test(m) && /yazma hatası|yeniden açıldı/.test(m)),
    'yazma hatası loglanmalı: ' + JSON.stringify(kayitlar.slice(-5)),
  );
  assert.ok(
    kayitlar.some(([, m]) => /yeniden açıldı/.test(m)),
    'kendi kendine iyileştirme loglanmalı',
  );

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('SIP: arama kapısı reddi HTTP uyumlu 423 kodu taşır', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sip-kod-'));
  const kopru = sahteKopru({ tmp });
  await assert.rejects(
    () => kopru.ara({ numara: '05550000000' }),
    (e) => e.kod === 423,
    'kapı reddi kod: 423 olmalı',
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('SIP: eşzamanlı arama engeli (çift çaldırma koruması)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sip-kilit-'));
  const kopru = sahteKopru({ tmp });
  fs.writeFileSync(kopru.sesKapisiYolu, '');
  kopru._aramaKilit = true; // çağrı sürüyor taklidi
  await assert.rejects(
    () => kopru.ara({ numara: '05550000000' }),
    (e) => e.kod === 409 && /zaten/i.test(e.message),
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('SIP: NetstringAyristirici ayrıştırılamayan akışta sonsuz büyümez', () => {
  const ayristirici = new NetstringAyristirici(() => {});
  for (let i = 0; i < 40; i++) ayristirici.besle(Buffer.alloc(8192, 0x78)); // 'x' dolu ≈320 KB
  assert.ok(ayristirici.tampon.length <= 256 * 1024, `tampon tavanı aşılıyor: ${ayristirici.tampon.length}`);
});

test('SIP: _spkFdYenidenAc spk.raw için taze fd açar ve _temizle fd/stream temizliğini eksiksiz yapar', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sip-spk-'));
  const spkYolu = path.join(tmp, 'spk.raw');
  fs.writeFileSync(spkYolu, Buffer.alloc(640));

  const kopru = sahteKopru({ tmp });
  const basarili = kopru._spkFdYenidenAc('test');
  assert.ok(basarili, 'spk.raw başarıyla açılmalı');
  assert.notEqual(kopru.outFifoFd, null, 'outFifoFd tanımlı olmalı');

  // Dinleyici akışı taklidi
  kopru.outFifoStream = fs.createReadStream(null, { fd: kopru.outFifoFd, autoClose: true });

  // Temizleme testi
  kopru._temizle();
  assert.equal(kopru.outFifoStream, null, 'outFifoStream null olmalı');
  assert.equal(kopru.outFifoFd, null, 'outFifoFd null olmalı (sonraki aramada EBADF olmamalı)');

  await new Promise((r) => setTimeout(r, 150));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('SIP: hedef numara tam SIP URI formatına dönüştürülür', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sip-uri-'));
  const kopru = sahteKopru({ tmp });
  kopru.sipServer = 'pbx.zadarma.com';
  const formatli = kopru.formatlaNumara('05373351866');
  assert.equal(formatli, '905373351866');

  const dialParam = formatli.includes('@')
    ? (formatli.startsWith('sip:') ? formatli : `sip:${formatli}`)
    : `sip:00${formatli}@${kopru.sipServer}`;
  assert.equal(dialParam, 'sip:00905373351866@pbx.zadarma.com');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('SIP: _acilisCaliniyor aktifken barge-in sesi kesmez', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sip-bargein-'));
  const kopru = sahteKopru({ tmp });
  kopru._acilisCaliniyor = true;
  kopru.calanSesPcm = Buffer.alloc(1000);
  kopru.sesCalmaDurduruldu = false;

  assert.equal(kopru._acilisCaliniyor, true);
  kopru._temizle();
  assert.equal(kopru._acilisCaliniyor, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

