import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

process.env.ASISTAN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'asistan-test-'));
process.env.BEDEN_MOD = 'mock';
process.env.KULLANICI_ADI = 'Test Kullanıcı';
process.env.ENABLE_9ROUTER = '0'; // Sahte 9router test sunucusu rastgele port kullanır.

const { sahte9RouterBaslat } = await import('./yardimci/sahte-9router.mjs');
const { bedenBaslat, cihazSec } = await import('../beden/server.mjs');
const { beyinBaslat } = await import('../beyin/index.mjs');
const { ayarYukle, tokenAl } = await import('../ortak/ayar.mjs');
const { jsonAyikla } = await import('../beyin/llm.mjs');

const sessizLog = { bilgi() {}, uyari() {}, hata() {} };
let sahte;
let beden;
let beyin;
let beyinUrl;
let token;
let cihaz;
let testAyar;

before(async () => {
  sahte = await sahte9RouterBaslat();
  delete process.env.ARAMA_LLM_BASE_URL;
  delete process.env.ARAMA_LLM_API_KEY;
  delete process.env.ARAMA_LLM_MODEL;
  const ayar = ayarYukle();
  ayar.arama.llm.baseUrl = '';
  ayar.arama.llm.model = 'sahte-arama-model';
  ayar.arama.llm.apiKey = 'status-secret-api-key';
  testAyar = ayar;
  ayar.beden.izinler.telefon = true;
  cihaz = cihazSec(ayar);
  beden = bedenBaslat({ ayar, token: tokenAl('beden'), cihaz, log: sessizLog, host: '127.0.0.1', port: 0 });
  await new Promise((r) => beden.once('listening', r));
  ayar.beyin.bedenUrl = `http://127.0.0.1:${beden.address().port}`;
  ayar.beyin.llm.baseUrl = sahte.url;
  ayar.beyin.llm.apiKey = 'sahte';
  beyin = beyinBaslat({ ayar, log: sessizLog, host: '127.0.0.1', port: 0 });
  await new Promise((r) => beyin.sunucu.once('listening', r));
  beyinUrl = `http://127.0.0.1:${beyin.sunucu.address().port}`;
  token = beyin.token;
});

after(() => {
  try {
    beyin.wss?.clients?.forEach((c) => c.terminate());
    beyin.wss?.close();
  } catch {}
  if (beyin.sunucu?.closeAllConnections) beyin.sunucu.closeAllConnections();
  beyin.sunucu.close();
  if (beden?.closeAllConnections) beden.closeAllConnections();
  beden.close();
  if (sahte.sunucu?.closeAllConnections) sahte.sunucu.closeAllConnections();
  sahte.sunucu.close();
  fs.rmSync(process.env.ASISTAN_HOME, { recursive: true, force: true });
});

const api = async (yol, govde, ekBaslik = {}) => {
  const y = await fetch(beyinUrl + '/api' + yol, {
    method: govde ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(govde ? { 'Content-Type': 'application/json' } : {}), ...ekBaslik },
    body: govde ? JSON.stringify(govde) : undefined,
  });
  return { durum: y.status, veri: await y.json() };
};

test('jsonAyikla çitli ve açıklamalı JSON’u çözer', () => {
  assert.deepEqual(jsonAyikla('İşte:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(jsonAyikla('{"b":[1,2]}'), { b: [1, 2] });
  assert.throws(() => jsonAyikla('json yok'));
});

test('token olmadan veya URL query ile panel API 401, sayfa giriş ekranına düşer', async () => {
  const y = await fetch(beyinUrl + '/api/durum');
  assert.equal(y.status, 401);
  const query = await fetch(`${beyinUrl}/api/durum?token=${token}`);
  assert.equal(query.status, 401, 'token query parametresinden kabul edilmemeli');
  const s = await fetch(beyinUrl + '/');
  assert.equal(s.status, 200);
  assert.match(await s.text(), /Giriş/);
  const eskiOturum = await fetch(`${beyinUrl}/telefon?gorev=test&token=${token}`, {
    headers: { Cookie: `asistan_token=${token}` },
    redirect: 'manual',
  });
  assert.equal(eskiOturum.status, 303);
  assert.equal(eskiOturum.headers.get('location'), '/telefon?gorev=test');
  assert.doesNotMatch(eskiOturum.headers.get('location') || '', /token=/);
});

test('giriş tokeni POST gövdesinden HttpOnly oturum çerezine alınır', async () => {
  const eskiBaglanti = await fetch(`${beyinUrl}/?token=${token}`);
  assert.equal(eskiBaglanti.status, 200);
  const girisHtml = await eskiBaglanti.text();
  assert.match(girisHtml, /Giriş/);
  assert.doesNotMatch(girisHtml, /searchParams\.get\(['"]token['"]\)|giris\(eskiToken\)/, 'giriş sayfası URL tokenını okumamalı veya kullanmamalı');
  assert.equal(eskiBaglanti.headers.get('set-cookie'), null, 'URL tokeni doğrudan oturum açmamalı');
  for (const dosya of ['panel.js', 'telefon.js']) {
    const kaynak = fs.readFileSync(new URL(`../beyin/web/${dosya}`, import.meta.url), 'utf8');
    assert.doesNotMatch(kaynak, /localStorage\.(?:getItem|setItem)\s*\(\s*['"]asistan_token['"]/, `${dosya} tokenı localStorage'dan okumamalı veya oraya yazmamalı`);
  }

  const hatali = await fetch(`${beyinUrl}/api/giris`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'yanlis' }),
  });
  assert.equal(hatali.status, 401);

  const y = await fetch(`${beyinUrl}/api/giris`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  assert.equal(y.status, 204);
  const cerez = y.headers.get('set-cookie') || '';
  assert.match(cerez, /asistan_token=/);
  assert.match(cerez, /HttpOnly/i);
  assert.match(cerez, /SameSite=Lax/i);
  assert.doesNotMatch(cerez, /Secure/i, 'HTTP geliştirme sunucusunda Secure işareti yok');

  const cerezBasligi = { Cookie: cerez.split(';')[0] };
  const panel = await fetch(`${beyinUrl}/api/durum`, { headers: cerezBasligi });
  assert.equal(panel.status, 200, 'oturum çereziyle API erişimi olmalı');
  const sayfa = await fetch(`${beyinUrl}/`, { headers: cerezBasligi });
  assert.match(sayfa.headers.get('set-cookie') || '', /HttpOnly/i, 'eski oturum çerezi de güvenli özniteliklerle yenilenmeli');
  assert.match(sayfa.headers.get('referrer-policy') || '', /no-referrer/i);
});

test('TLS sonlandıran proxy için COOKIE_SECURE=1 Secure çerezi zorlar', async () => {
  const onceki = process.env.COOKIE_SECURE;
  process.env.COOKIE_SECURE = '1';
  try {
    const y = await fetch(`${beyinUrl}/api/giris`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    assert.equal(y.status, 204);
    assert.match(y.headers.get('set-cookie') || '', /Secure/i);
  } finally {
    if (onceki === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = onceki;
  }
});

test('/api/durum bedeni ve modeli raporlar', async () => {
  const { durum, veri } = await api('/durum');
  assert.equal(durum, 200);
  assert.equal(veri.beden.durum, 'yasiyor');
  assert.equal(veri.beden.mod, 'mock');
  assert.equal(veri.kullanici, 'Test Kullanıcı');
});

test('/api/durum provider anahtarını, URL parolasını veya query sırrını sızdırmaz', async () => {
  const oncekiUrl = beyin.llm.baseUrl;
  const oncekiBedenUrl = beyin.beden.url;
  beyin.llm.baseUrl = 'https://durum-user:durum-pass@provider.example/v1?token=durum-query-secret';
  beyin.beden.url = 'http://body-user:body-pass@127.0.0.1:1/v1?token=body-query-secret';
  try {
    const { durum, veri } = await api('/durum');
    assert.equal(durum, 200);
    assert.equal(veri.llm.baseUrl, 'https://provider.example/v1');
    assert.equal(veri.arama.llm.baseUrl, sahte.url);
    assert.equal(veri.arama.llm.model, 'sahte-arama-model');
    assert.equal(veri.arama.llm.apiKeyConfigured, true);
    assert.equal(veri.beden.hata, 'beden sağlık kontrolü başarısız');
    const govde = JSON.stringify(veri);
    assert.doesNotMatch(govde, /status-secret-api-key|durum-user|durum-pass|durum-query-secret|body-user|body-pass|body-query-secret/);
  } finally {
    beyin.llm.baseUrl = oncekiUrl;
    beyin.beden.url = oncekiBedenUrl;
  }
});

test('model otomatik seçilir (tercihen sonnet)', async () => {
  const { veri } = await api('/modeller');
  assert.deepEqual(veri.modeller, ['sahte/model-1', 'sahte/sonnet']);
  assert.equal(beyin.llm.model, 'sahte/sonnet');
});

test('sohbet: araç çağrısı → beden → yanıt', async () => {
  const { durum, veri } = await api('/sohbet', { oturum: 't1', metin: 'pil kaç?' });
  assert.equal(durum, 200);
  assert.equal(veri.adimlar.length, 1);
  assert.equal(veri.adimlar[0].arac, 'pil_durumu');
  assert.match(veri.adimlar[0].sonuc, /"percentage":87/);
  assert.match(veri.metin, /Araç sonucu/);
  // sistem mesajı kullanıcı adını ve hafızayı içeriyor mu
  const sonIstek = sahte.istekler.at(-1);
  assert.match(sonIstek.messages[0].content, /Test Kullanıcı/);
  assert.match(sonIstek.messages[0].content, /KALICI HAFIZA/);
});

test('sohbet: bak aracı görüntüyü sonraki mesaja ekler', async () => {
  const { veri } = await api('/sohbet', { oturum: 't2', metin: 'etrafa bak' });
  assert.equal(veri.adimlar[0].arac, 'bak');
  const sonIstek = sahte.istekler.at(-1);
  const resimli = sonIstek.messages.find((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
  assert.ok(resimli, 'image_url içeren mesaj bekleniyordu');
  assert.match(resimli.content[1].image_url.url, /^data:image\/png;base64,/);
  // tool mesajı assistant tool_calls'tan hemen sonra gelmeli
  const idx = sonIstek.messages.findIndex((m) => m.tool_calls);
  assert.equal(sonIstek.messages[idx + 1].role, 'tool');
});

test('Cebimon sohbetten doğal uygulamalı istek alıp kalıcı canlı görev tahtası oluşturur', async () => {
  const { durum, veri } = await api('/sohbet', { oturum: 'cebi-plan', metin: 'Kızımın saçını örmeme yardım et' });
  assert.equal(durum, 200);
  assert.ok(veri.adimlar.some((a) => a.arac === 'cebi_planla'));
  assert.match(veri.metin, /Görev tahtasını hazırladım/);
  const { veri: c } = await api('/cebi');
  assert.equal(c.oturum.ortam, 'kişisel bakım');
  assert.equal(c.oturum.adimlar[0].durum, 'aktif');
  assert.equal(c.oturum.adimlar[1].durum, 'bekliyor');
});

test('Cebimon plan API LLM planını kalıcılaştırır, risk etiketinde fail-closed kalır', async () => {
  const { durum, veri } = await api('/cebi/planla', { talimat: 'Kızımın saçını örmeme yardım et' });
  assert.equal(durum, 200);
  assert.equal(veri.planKaynak, 'llm');
  assert.equal(veri.adimlar.length, 3);
  assert.equal(veri.adimlar[0].durum, 'aktif');
  assert.equal(veri.risk, 'dusuk', 'LLM, yerel kişisel bakım sınıflandırmasını değiştirmez');
  const { durum: temizDurum, veri: temiz } = await api('/cebi/planla', { talimat: 'Elektrik panosunu onarmama yardım et' });
  assert.equal(temizDurum, 200);
  assert.equal(temiz.risk, 'yuksek');
});

test('tarayıcı mikrofon yedeği için korumalı Türkçe STT API’si', async () => {
  const { durum, veri } = await api('/sese-yazi', { ses: Buffer.from('sahte ses').toString('base64'), mime: 'audio/webm' });
  assert.equal(durum, 200);
  assert.equal(veri.metin, 'sahte transkript');
  const codecs = await api('/sese-yazi', { ses: Buffer.from('sahte ses').toString('base64'), mime: 'audio/webm;codecs=opus' });
  assert.equal(codecs.durum, 200);
  const buyuk = await api('/sese-yazi', { ses: '!', mime: 'audio/webm' });
  assert.equal(buyuk.durum, 400);
  const mime = await api('/sese-yazi', { ses: Buffer.from('x').toString('base64'), mime: 'text/plain' });
  assert.equal(mime.durum, 400);
});

test('Cebimon kişisel verileri silme rotası geçmişi sıfırlar', async () => {
  await api('/cebi/planla', { talimat: 'Bir belgeyi düzenle' });
  await api('/cebi/bitir', { basarili: false, ozet: 'yarıda kaldı' });
  const { durum, veri } = await api('/cebi/temizle', {});
  assert.equal(durum, 200);
  assert.equal(veri.oturum, null);
  assert.equal(veri.gecmis.length, 0);
  assert.equal(veri.ad, 'Aspasia');
});

test('Cebimon plan API kamera ve mikrofon kanıtını LLM ile değerlendirip aktif adımı ilerletir', async () => {
  const { durum, veri: plan } = await api('/cebi/planla', { talimat: 'Kızımın saçını örmeme yardım et' });
  assert.equal(durum, 200);
  assert.equal(plan.ortam, 'kişisel bakım');
  const { durum: evalDurum, veri: sonuc } = await api('/cebi/degerlendir', {
    gorsel: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/',
    ses: Buffer.from('sahte ses').toString('base64'), mime: 'audio/webm',
  });
  assert.equal(evalDurum, 200);
  assert.equal(sonuc.duyulan, 'sahte transkript');
  assert.equal(sonuc.adimTamamlandi, true);
  assert.equal(sonuc.oturum.adimlar[0].durum, 'tamamlandi');
  assert.equal(sonuc.oturum.adimlar[1].durum, 'aktif');
  assert.ok(sonuc.inceleme.gozlem);
  const { veri: kalici } = await api('/cebi');
  assert.equal(kalici.oturum.adimlar[0].durum, 'tamamlandi');
});

test('Cebimon değerlendirmesi fail-closed: string false veya güvenlik alanı eksikliği tamamlatmaz', async () => {
  await api('/cebi/planla', { talimat: 'Bir belgeyi incele' });
  sahte.ayarlar.cebiDegerlendirme = { tamamlandi: 'false', guven: 0.99, gozlem: 'Şüpheli yanıt' };
  try {
    const { durum, veri } = await api('/cebi/degerlendir', {
      gorsel: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/',
      ses: Buffer.from('sahte ses').toString('base64'), mime: 'audio/webm',
    });
    assert.equal(durum, 200);
    assert.equal(veri.adimTamamlandi, false);
    assert.equal(veri.inceleme.guvenli, false);
    assert.equal(veri.oturum.adimlar[0].durum, 'aktif');
  } finally { delete sahte.ayarlar.cebiDegerlendirme; }
  const { durum: durumBypass } = await api('/cebi/adim', { metin: 'Atlama denemesi', durum: 'tamamlandi' });
  assert.equal(durumBypass, 400);
});

test('Cebimon yüksek riskli adımı kullanıcı onayı olmadan ilerletmez', async () => {
  await api('/cebi/planla', { talimat: 'Arabayı kriko ile kaldırma işim için yardım et' });
  beyin.cebimon.veri.oturum.risk = 'yuksek';
  beyin.cebimon.kaydet();
  const { veri: sonuc } = await api('/cebi/degerlendir', {
    gorsel: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/',
    ses: Buffer.from('sahte ses').toString('base64'), mime: 'audio/webm',
  });
  assert.equal(sonuc.adimTamamlandi, false);
  assert.equal(sonuc.onayGerekli, true);
  assert.equal(sonuc.oturum.adimlar[0].durum, 'onay_bekliyor');
  const { veri: onay } = await api('/cebi/onay', { onay: true });
  assert.equal(onay.oturum.adimlar[0].durum, 'tamamlandi');
  assert.equal(onay.oturum.adimlar[1].durum, 'aktif');
});

test('Cebimon adım değerlendirmesi kamera ve ses kanıtı olmadan reddedilir', async () => {
  await api('/cebi/planla', { talimat: 'Bir belgeyi incelememe yardım et' });
  const { durum, veri } = await api('/cebi/degerlendir', { ses: Buffer.from('ses').toString('base64'), mime: 'audio/webm' });
  assert.equal(durum, 400);
  assert.match(veri.hata, /kamera görüntüsü/);
});

test('görev: talimattan brifing üretilir ve kaydedilir', async () => {
  const { durum, veri: g } = await api('/gorevler', { talimat: "Ahmet'i ara, yarınki toplantıyı 16:00'a ertele" });
  assert.equal(durum, 200);
  assert.equal(g.durum, 'hazir');
  assert.equal(g.kisi.numara, '+905551112233');
  assert.equal(g.konusma_noktalari.length, 3);
  const { veri: liste } = await api('/gorevler');
  assert.ok(liste.gorevler.some((x) => x.id === g.id));
  const sistem = beyin.gorevler.aramaSistemMesaji(g);
  assert.match(sistem, /TELEFONDA konuşuyorsun/);
  assert.match(sistem, /dijital asistan olduğunu açıkça söyle/);
  assert.match(sistem, /\[GORUSME_BITTI\]/);
});

test('görev: hücresel arama bedeni çevirir ve brifing döner', async () => {
  const { veri: g } = await api('/gorevler', { talimat: 'Ahmet’i ara', numara: '+905559998877' });
  assert.equal(g.kisi.numara, '+905559998877', 'verilen numara brifingdekini ezmeli');
  const { durum, veri } = await api(`/gorevler/${g.id}/hucresel-ara`, {});
  assert.equal(durum, 200);
  assert.equal(veri.arandi, '+905559998877');
  assert.ok(veri.brifing.acilis);
  assert.equal(cihaz.olaylar.filter((o) => o.tip === 'ara').length, 1);
  assert.equal(beyin.gorevler.al(g.id).durum, 'araniyor');
  const { veri: kapali } = await api(`/gorevler/${g.id}/sonuc`, { basarili: true, ozet: 'Elle girildi' });
  assert.equal(kapali.durum, 'tamamlandi');
  assert.match(beyin.hafiza.oku(), /Elle girildi/);
});

test('telefon köprüsü: WebSocket üzerinden tam görüşme ve özet', async () => {
  const { veri: g } = await api('/gorevler', { talimat: 'Ahmet’i ara, toplantıyı ertele' });
  const wsUrl = beyinUrl.replace('http', 'ws') + '/ws/telefon';
  const ws = new WebSocket(wsUrl, { headers: { Cookie: `asistan_token=${token}` } });
  const gelen = [];
  const bekle = (tip, zamanAsimi = 5000) =>
    new Promise((coz, reddet) => {
      const mevcut = gelen.find((m) => m.tip === tip && !m._tuketildi);
      if (mevcut) {
        mevcut._tuketildi = true;
        return coz(mevcut);
      }
      const t = setTimeout(() => reddet(new Error(`'${tip}' beklenirken zaman aşımı; gelenler: ${gelen.map((m) => m.tip).join(',')}`)), zamanAsimi);
      const dinle = (m) => {
        if (m.tip === tip && !m._tuketildi) {
          m._tuketildi = true;
          clearTimeout(t);
          bekleyenler.delete(dinle);
          coz(m);
        }
      };
      bekleyenler.add(dinle);
    });
  const bekleyenler = new Set();
  ws.on('message', (veri, ikili) => {
    if (ikili) return;
    const m = JSON.parse(veri.toString());
    gelen.push(m);
    for (const d of [...bekleyenler]) d(m);
  });
  await new Promise((r) => ws.once('open', r));

  ws.send(JSON.stringify({ tip: 'baslat', gorevId: g.id, mod: 'tarayici-ses' }));
  const hazir = await bekle('hazir');
  assert.equal(hazir.gorev.id, g.id);
  const acilis = await bekle('metin');
  assert.equal(acilis.rol, 'asistan');
  assert.match(acilis.metin, /dijital asistanı/);
  assert.equal(acilis.sesGelecek, false, 'tarayıcı sesi modunda sunucu ses göndermez');

  ws.send(JSON.stringify({ tip: 'metin', metin: 'Olur, ertelenebilir.' }));
  const yanki = await bekle('metin'); // karşı taraf satırı
  assert.equal(yanki.rol, 'karsi');
  const cevap = await bekle('metin');
  assert.equal(cevap.rol, 'asistan');
  assert.match(cevap.metin, /on altı/);

  ws.send(JSON.stringify({ tip: 'metin', metin: 'Tamam, hoşça kal' }));
  await bekle('metin'); // karsi
  const veda = await bekle('metin');
  assert.ok(!veda.metin.includes('[GORUSME_BITTI]'), 'bitiş etiketi kullanıcıya sızmamalı');
  const bitti = await bekle('bitti');
  assert.equal(bitti.sebep, 'asistan-kapatti');
  assert.equal(bitti.gorev.durum, 'tamamlandi');
  assert.equal(bitti.gorev.sonuc.basarili, true);
  assert.equal(bitti.gorev.transkript.length, 5);
  ws.close();
});

test('telefon köprüsü: sunucu sesi modunda ses gelir ve STT çalışır', async () => {
  const ws = new WebSocket(beyinUrl.replace('http', 'ws') + '/ws/telefon', { headers: { Cookie: `asistan_token=${token}` } });
  const metinler = [];
  let ikiliSayisi = 0;
  const bekleyenler = new Set();
  const bekle = (kosul, zamanAsimi = 5000) =>
    new Promise((coz, reddet) => {
      const mevcut = kosul();
      if (mevcut) return coz(mevcut);
      const t = setTimeout(() => reddet(new Error(`beklenen olay için zaman aşımı (${zamanAsimi}ms)`)), zamanAsimi);
      const dinle = () => {
        const simdi = kosul();
        if (simdi) {
          clearTimeout(t);
          bekleyenler.delete(dinle);
          coz(simdi);
        }
      };
      bekleyenler.add(dinle);
    });

  ws.on('message', (veri, ikili) => {
    if (ikili) ikiliSayisi++;
    else metinler.push(JSON.parse(veri.toString()));
    for (const d of [...bekleyenler]) d();
  });

  try {
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ tip: 'baslat', mod: 'sunucu-ses' }));
    await bekle(() => metinler.some((m) => m.tip === 'hazir'));
    await bekle(() => metinler.some((m) => m.tip === 'ses' && m.mime === 'audio/mpeg') && ikiliSayisi >= 1);
    assert.ok(metinler.some((m) => m.tip === 'hazir'));
    assert.ok(metinler.some((m) => m.tip === 'ses' && m.mime === 'audio/mpeg'));
    assert.ok(ikiliSayisi >= 1, 'mp3 ikili çerçevesi bekleniyordu');

    ws.send(JSON.stringify({ tip: 'ses', mime: 'audio/webm' }));
    ws.send(Buffer.from('sahte-webm-verisi'));
    await bekle(() => metinler.some((m) => m.tip === 'metin' && m.rol === 'karsi' && m.metin === 'sahte transkript'));

    ws.send(JSON.stringify({ tip: 'bitir' }));
    await bekle(() => metinler.some((m) => m.tip === 'bitti' && m.sebep === 'kullanici-kapatti'));
  } finally {
    ws.close();
  }
});

test('telefon köprüsü: URL query tokenı WebSocket yetkilendirmez', async () => {
  const ws = new WebSocket(beyinUrl.replace('http', 'ws') + `/ws/telefon?token=${token}`);
  const hata = await new Promise((r) => {
    ws.once('error', r);
    ws.once('unexpected-response', (_req, res) => r(new Error(String(res.statusCode))));
  });
  assert.match(String(hata.message), /401/);
});

test('görev: kayıt silme — transkript dahil dosya yok olur', async () => {
  const { veri: g } = await api('/gorevler', { talimat: 'Silinmek üzere test görevi' });
  const sil = await api(`/gorevler/${g.id}/sil`, {});
  assert.equal(sil.durum, 200);
  assert.equal(sil.veri.silindi, g.id);
  const yok = await api(`/gorevler/${g.id}`);
  assert.equal(yok.durum, 404, 'silinen görev bir daha okunamamalı');
});

test('voip-ara: ses testi yeşil değilken arama ÇALDIRILMAZ (423)', async () => {
  const { veri: g } = await api('/gorevler', { talimat: 'Kapı testi araması', numara: '05550000000' });
  const { durum, veri } = await api(`/gorevler/${g.id}/voip-ara`, {});
  assert.equal(durum, 423);
  assert.match(veri.hata, /ses testi/);
  // Görev araniyor'a geçmemeli
  const { veri: taze } = await api(`/gorevler/${g.id}`);
  assert.notEqual(taze.durum, 'araniyor', 'kapı kapalıyken görev araniyor olmamalı');
});

test('GET /api/ayarlar mevcut yapılandırmayı döner', async () => {
  const { durum, veri } = await api('/ayarlar');
  assert.equal(durum, 200);
  assert.ok(veri.kullanici);
  assert.ok(veri.llm);
  assert.ok(veri.ses);
  assert.ok(veri.sip);
});

test('POST /api/ayarlar ayarları günceller ve kaydeder', async () => {
  const { durum, veri } = await api('/ayarlar', {
    kullanici: { ad: 'Salim Gümüş', asistanAdi: 'Cebimon' },
    llm: { apiKey: 'sk-yeni-test-key', model: 'yeni-model' },
    ses: { fishAudioApiKey: 'sk-fish-yeni-key', ttsSaglayici: 'fish_audio' },
    sip: { sunucu: 'sip.zadarma.com', kullanici: '123456', sifre: 'gizli123' },
  });
  assert.equal(durum, 200);
  assert.equal(veri.tamam, true);
  const { veri: taze } = await api('/ayarlar');
  assert.equal(taze.kullanici.ad, 'Salim Gümüş');
  assert.equal(taze.kullanici.asistanAdi, 'Cebimon');
  assert.equal(taze.llm.apiKey, 'sk-yeni-test-key');
  assert.equal(taze.llm.model, 'yeni-model');
  assert.equal(taze.ses.fishAudioApiKey, 'sk-fish-yeni-key');
  assert.equal(taze.sip.kullanici, '123456');
});

test('GET /api/sesler hazır ve aktif sesleri listeler', async () => {
  const { durum, veri } = await api('/sesler');
  assert.equal(durum, 200);
  assert.ok(veri.aktif);
  assert.ok(Array.isArray(veri.sesler));
  assert.ok(veri.sesler.some((s) => s.ad === 'Haluk Bilginer'));
  assert.ok(veri.sesler.some((s) => s.ad === 'Sedat Peker'));
});

test('POST /api/ses/varsayilan-yap varsayılan sesi değiştirir', async () => {
  const { durum, veri } = await api('/ses/varsayilan-yap', { sesId: '66f55da63a4a47b982ae64723dd79194', tur: 'fish_audio', ad: 'Haluk Bilginer' });
  assert.equal(durum, 200);
  assert.equal(veri.tamam, true);
  assert.equal(veri.aktif.tur, 'fish_audio');
  assert.equal(veri.aktif.id, '66f55da63a4a47b982ae64723dd79194');
});

test('POST /api/ses/ozel-ekle yeni ses tanımlar', async () => {
  const { durum, veri } = await api('/ses/ozel-ekle', { id: '11223344556677889900aabbccddeeff', ad: 'Test Klon', aciklama: 'Açıklama' });
  assert.equal(durum, 200);
  assert.equal(veri.tamam, true);
  assert.equal(veri.ses.ad, 'Test Klon');
  const { veri: liste } = await api('/sesler');
  assert.ok(liste.ozelSesler.some((s) => s.ad === 'Test Klon'));
});

test('POST /api/hizli-ara VoIP aramasını seçilen sesle tetikler (kapı testi uyarısı dahil)', async () => {
  const { durum, veri } = await api('/hizli-ara', { numara: '05321234567', ses: 'haluk', talimat: 'Hızlı arama testi' });
  assert.equal(durum, 423);
  assert.match(veri.hata, /ses testi/);
});

test('arac: ses_sec asistan sesini başarıyla değiştirir', async () => {
  const { aracBul } = await import('../beyin/araclar.mjs');
  const arac = aracBul('ses_sec');
  assert.ok(arac);
  const sonuc = await arac.calistir({ ses: 'Sedat Peker' }, { ayar: beyin.asistan.ayar, llm: beyin.llm });
  assert.match(sonuc.metin, /Sedat Peker/);
});

