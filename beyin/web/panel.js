// Panel — Cebindeki telefondan asistanı yönetme kokpiti.
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// LLM/kullanıcı metnini innerHTML'e gömerken HTML kaçışı (XSS sertleştirmesi)
const kacir = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Eski sürümde localStorage'a yazılmış tokenı temizle; yeni oturum HttpOnly çerezle yönetilir.
try { localStorage.removeItem('asistan_token'); } catch {}

// /bak ile çekilen son görsel: bir sonraki sohbet mesajına eklenir ("bu ne?" diye sorabilmek için)
let bekleyenGorsel = null;
let calanSesObjesi = null;

let bildirimZamanlayici;
function bildir(metin, hata = false) {
  const el = $('#bildirim');
  if (!el) return;
  el.textContent = metin;
  el.classList.toggle('toast-hata', hata);
  el.hidden = false;
  clearTimeout(bildirimZamanlayici);
  bildirimZamanlayici = setTimeout(() => { el.hidden = true; }, 6000);
}

async function api(yol, govde) {
  let y;
  try {
    y = await fetch(`/api${yol}`, {
      method: govde ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: govde ? { 'Content-Type': 'application/json' } : {},
      body: govde ? JSON.stringify(govde) : undefined,
    });
  } catch (agHatasi) {
    throw new Error('Bağlantı hatası (' + agHatasi.message + ')');
  }
  const veri = await y.json().catch(() => ({}));
  if (!y.ok) {
    throw new Error(veri.hata || y.statusText || `Sunucu hatası (HTTP ${y.status})`);
  }
  return veri;
}

/* ==========================================================================
   SEKME (TAB) YÖNETİMİ
   ========================================================================== */
function sekmeDegistir(hedefSekme) {
  $$('.sekme-icerik').forEach((el) => {
    el.classList.toggle('aktif', el.id === `tab-${hedefSekme}`);
  });
  $$('.sekme-btn, .alt-sekme-btn').forEach((btn) => {
    btn.classList.toggle('aktif', btn.dataset.sekme === hedefSekme);
  });

  if (hedefSekme === 'sesler') sesleriYukle();
  else if (hedefSekme === 'ayarlar') ayarlariYukle();
  else if (hedefSekme === 'durum') {
    durumYukle();
    gorevleriYukle();
    hafizaYukle();
  }
}

$$('.sekme-btn, .alt-sekme-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const hedef = btn.dataset.sekme;
    if (hedef) sekmeDegistir(hedef);
  });
});

/* ==========================================================================
   SES STÜDYOSU (VOICE ENGINE & FISH AUDIO)
   ========================================================================== */
async function sesleriYukle() {
  try {
    const res = await api('/sesler');
    const aktif = res.aktif || {};
    
    // Aktif ses kartı (Hero)
    if ($('#aktifSesAdi')) $('#aktifSesAdi').textContent = aktif.ad || aktif.id || 'Haluk Bilginer';
    if ($('#aktifSesAciklama')) $('#aktifSesAciklama').textContent = aktif.aciklama || (aktif.tur === 'fish_audio' ? 'Fish Audio Klon Ses' : 'Doğal Türkçe Ses');
    if ($('#aktifSesRozet')) $('#aktifSesRozet').textContent = aktif.tur === 'fish_audio' ? '🎭 Fish Audio Klon' : '🎙️ Doğal Ses';

    // Hızlı arama formundaki ses seçim menüsünü güncelle
    const hizliSesSecici = $('#hizliSes');
    if (hizliSesSecici) {
      const seciliDeger = hizliSesSecici.value;
      const tumSesler = [...(res.sesler || []), ...(res.ozelSesler || [])];
      hizliSesSecici.innerHTML = tumSesler.map((s) => {
        const ikon = s.tur === 'fish_audio' ? '🎭' : '🎙️';
        return `<option value="${kacir(s.id)}">${ikon} ${kacir(s.ad)} (${kacir(s.etiket || (s.tur === 'fish_audio' ? 'Klon' : 'Doğal'))})</option>`;
      }).join('');
      if (seciliDeger && tumSesler.some((s) => s.id === seciliDeger)) {
        hizliSesSecici.value = seciliDeger;
      } else if (aktif.id) {
        hizliSesSecici.value = aktif.id;
      }
    }

    // Sesler sekmesindeki ses kartları ızgarası
    const izgara = $('#sesKartlariIzgara');
    if (izgara) {
      const tumSesler = [...(res.sesler || []), ...(res.ozelSesler || [])];
      izgara.innerHTML = tumSesler.map((s) => {
        const aktifMi = s.id === aktif.id;
        const klonMu = s.tur === 'fish_audio';
        return `
          <div class="ses-karti ${aktifMi ? 'aktif-ses' : ''}" data-ses-id="${kacir(s.id)}" data-tur="${kacir(s.tur || 'fish_audio')}" data-ad="${kacir(s.ad)}">
            <div class="ses-karti-ust">
              <div class="ses-avatar ${klonMu ? '' : 'dogal'}">${klonMu ? '🎭' : '🎙️'}</div>
              <div class="ses-bilgi">
                <h3>${kacir(s.ad)}</h3>
                <span class="ses-rozet-etiket ${klonMu ? '' : 'dogal'}">${kacir(s.etiket || (klonMu ? 'Fish Audio Klon' : 'Doğal Ses'))}</span>
              </div>
            </div>
            <p class="ses-aciklama">${kacir(s.aciklama || (klonMu ? 'Özel klon ses modeli' : 'Net ve akıcı Türkçe asistan sesi'))}</p>
            <div class="ses-eylemler">
              <button class="buton btn-on-dinle" type="button" data-eylem="dinle">🔊 Dinle</button>
              <button class="buton ${aktifMi ? 'birincil' : ''} btn-varsayilan" type="button" data-eylem="varsayilan" ${aktifMi ? 'disabled' : ''}>
                ${aktifMi ? '✓ Aktif' : '⭐ Varsayılan'}
              </button>
            </div>
          </div>
        `;
      }).join('');
    }
  } catch (hata) {
    bildir('Ses modelleri yüklenemedi: ' + hata.message, true);
  }
}

// Ses kartları tıklama olayları (Ön Dinle ve Varsayılan Yap)
$('#sesKartlariIzgara')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-eylem]');
  if (!btn) return;
  const kart = btn.closest('.ses-karti');
  if (!kart) return;
  const sesId = kart.dataset.sesId;
  const tur = kart.dataset.tur;
  const ad = kart.dataset.ad;

  if (btn.dataset.eylem === 'dinle') {
    const eskiMetin = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Yükleniyor…';
    try {
      if (calanSesObjesi) {
        calanSesObjesi.pause();
        calanSesObjesi = null;
      }
      const res = await api('/ses/on-dinle', {
        sesId,
        tur,
        metin: `Merhaba, ben ${ad} sesinizle konuşan yapay zeka asistanınızım. Sesim nasıl geliyor?`
      });
      btn.textContent = '🔊 Çalıyor…';
      const ses = new Audio('data:audio/mp3;base64,' + res.sesBase64);
      calanSesObjesi = ses;
      ses.onended = () => { btn.textContent = eskiMetin; btn.disabled = false; calanSesObjesi = null; };
      ses.onerror = () => { btn.textContent = eskiMetin; btn.disabled = false; calanSesObjesi = null; bildir('Ses çalınamadı.', true); };
      await ses.play();
    } catch (hata) {
      bildir('Ön dinleme hatası: ' + hata.message, true);
      btn.textContent = eskiMetin;
      btn.disabled = false;
    }
  }

  if (btn.dataset.eylem === 'varsayilan') {
    btn.disabled = true;
    try {
      await api('/ses/varsayilan-yap', { sesId, tur, ad });
      bildir(`Varsayılan ses "${ad}" olarak güncellendi ✓`);
      await sesleriYukle();
    } catch (hata) {
      bildir('Ses ayarlanamadı: ' + hata.message, true);
      btn.disabled = false;
    }
  }
});

// Yeni Özel Klon Ses Ekleme Formu
$('#ozelSesForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#ozelSesId').value.trim();
  const ad = $('#ozelSesAdi').value.trim();
  const aciklama = $('#ozelSesAciklama').value.trim();
  if (!id || !ad) return;

  const btn = $('#ozelSesKaydetBtn');
  btn.disabled = true;
  try {
    await api('/ses/ozel-ekle', { id, ad, aciklama });
    bildir(`Özel ses "${ad}" başarıyla eklendi!`);
    $('#ozelSesId').value = '';
    $('#ozelSesAdi').value = '';
    $('#ozelSesAciklama').value = '';
    await sesleriYukle();
  } catch (hata) {
    bildir('Özel ses eklenemedi: ' + hata.message, true);
  } finally {
    btn.disabled = false;
  }
});

/* ==========================================================================
   HIZLI ARAMA (VOIP ONE-TAP DIAL)
   ========================================================================== */
$('#hizliAraForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const numara = $('#hizliNumara').value.trim();
  if (!numara) return;
  const sesId = $('#hizliSes').value;
  const talimat = $('#hizliTalimat').value.trim();

  const btn = $('#hizliAraBtn');
  btn.disabled = true;
  const eskiMetin = btn.innerHTML;
  btn.innerHTML = '📞 Arama Başlatılıyor…';

  try {
    const res = await api('/hizli-ara', { numara, sesId, talimat });
    bildir(`Arama başlatıldı: ${numara} çevriliyor!`);
    $('#hizliTalimat').value = '';
    // Görevleri yenile
    gorevleriYukle();
  } catch (hata) {
    bildir('Arama başlatılamadı: ' + hata.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = eskiMetin;
  }
});

/* ==========================================================================
   AYARLAR VE ENTEGRASYON MERKEZİ (SIFIR TERMİNAL)
   ========================================================================== */
async function ayarlariYukle() {
  try {
    const a = await api('/ayarlar');
    if ($('#llmBaseUrl')) $('#llmBaseUrl').value = a.llm?.baseUrl || '';
    if ($('#llmApiKey')) $('#llmApiKey').value = a.llm?.apiKey || '';
    if ($('#llmModel')) $('#llmModel').value = a.llm?.model || '';
    if ($('#groqApiKey')) $('#groqApiKey').value = a.llm?.groqApiKey || '';
    if ($('#openrouterApiKey')) $('#openrouterApiKey').value = a.llm?.openrouterApiKey || '';

    if ($('#fishAudioApiKey')) $('#fishAudioApiKey').value = a.ses?.fishAudioApiKey || '';
    if ($('#ttsSaglayici')) $('#ttsSaglayici').value = a.ses?.ttsSaglayici || 'fish_audio';
    if ($('#ttsVoice')) $('#ttsVoice').value = a.ses?.ttsVoice || 'tr-TR-EmelNeural';

    if ($('#sipServer')) $('#sipServer').value = a.sip?.sunucu || 'pbx.zadarma.com';
    if ($('#sipUser')) $('#sipUser').value = a.sip?.kullanici || '';
    if ($('#sipPass')) $('#sipPass').value = a.sip?.sifre || '';
    if ($('#sipPort')) $('#sipPort').value = a.sip?.port || 5060;

    if ($('#kullaniciAdi')) $('#kullaniciAdi').value = a.kullanici?.ad || '';
    if ($('#asistanAdiAyar')) $('#asistanAdiAyar').value = a.kullanici?.asistanAdi || 'Aspasia';
  } catch (hata) {
    bildir('Ayarlar yüklenemedi: ' + hata.message, true);
  }
}

async function ayarlariKaydet() {
  const btn = $('#ayarlariKaydetBtn');
  const btnUst = $('#ayarlariKaydetBtnUst');
  if (btn) btn.disabled = true;
  if (btnUst) btnUst.disabled = true;

  const govde = {
    kullanici: {
      ad: $('#kullaniciAdi')?.value.trim(),
      asistanAdi: $('#asistanAdiAyar')?.value.trim(),
    },
    llm: {
      baseUrl: $('#llmBaseUrl')?.value.trim(),
      apiKey: $('#llmApiKey')?.value.trim(),
      model: $('#llmModel')?.value.trim(),
      groqApiKey: $('#groqApiKey')?.value.trim(),
      openrouterApiKey: $('#openrouterApiKey')?.value.trim(),
    },
    ses: {
      fishAudioApiKey: $('#fishAudioApiKey')?.value.trim(),
      ttsSaglayici: $('#ttsSaglayici')?.value,
      ttsVoice: $('#ttsVoice')?.value,
    },
    sip: {
      sunucu: $('#sipServer')?.value.trim(),
      kullanici: $('#sipUser')?.value.trim(),
      sifre: $('#sipPass')?.value.trim(),
      port: Number($('#sipPort')?.value || 5060),
    },
  };

  try {
    const res = await api('/ayarlar', govde);
    bildir(res.mesaj || 'Tüm ayarlar kaydedildi ve uygulandı ✓');
    if (govde.kullanici.asistanAdi) {
      $('#asistanAdi').textContent = govde.kullanici.asistanAdi;
      $('#cebiAd').textContent = govde.kullanici.asistanAdi;
    }
    if (govde.kullanici.ad) {
      $('#kullaniciEtiket').textContent = govde.kullanici.ad + ' İçin Hazır';
    }
    await sesleriYukle();
  } catch (hata) {
    bildir('Ayar kaydetme hatası: ' + hata.message, true);
  } finally {
    if (btn) btn.disabled = false;
    if (btnUst) btnUst.disabled = false;
  }
}

$('#ayarlarFormu')?.addEventListener('submit', (e) => {
  e.preventDefault();
  ayarlariKaydet();
});
$('#ayarlariKaydetBtnUst')?.addEventListener('click', ayarlariKaydet);

/* ==========================================================================
   SOHBET VE SESLİ ETKİLEŞİM
   ========================================================================== */
function balon(sinif, metin, resim) {
  const d = document.createElement('div');
  d.className = 'balon ' + sinif;
  d.textContent = metin;
  if (resim) {
    const img = document.createElement('img');
    img.src = resim;
    d.appendChild(img);
  }
  $('#sohbet').appendChild(d);
  $('#sohbet').scrollTop = $('#sohbet').scrollHeight;
  return d;
}

function adimNotu(adimlar) {
  if (!adimlar?.length) return;
  const d = document.createElement('div');
  d.className = 'adim';
  d.textContent = '⚙ ' + adimlar.map((a) => a.arac).join(' → ');
  $('#sohbet').appendChild(d);
}

async function sohbetGonder(metin) {
  if (!metin?.trim()) return;
  $('#mesaj').value = '';
  balon('sen', metin);
  $('#gonder').disabled = true;
  const bekle = balon('sistem', 'düşünüyor…');
  try {
    const y = await api('/sohbet', { oturum: 'panel', metin, resimler: bekleyenGorsel ? [bekleyenGorsel] : [] });
    bekleyenGorsel = null;
    bekle.remove();
    adimNotu(y.adimlar);
    balon('asistan', y.metin || '(boş yanıt)');
    if (y.adimlar?.some((a) => a.arac === 'gorev_olustur' || a.arac === 'hizli_ara')) gorevleriYukle();
    if (y.adimlar?.some((a) => a.arac === 'cebi_planla')) cebimonYukle();
    if (y.adimlar?.some((a) => a.arac === 'hatirla')) hafizaYukle();
    if (y.adimlar?.some((a) => a.arac === 'ses_sec')) sesleriYukle();
  } catch (h) {
    bekle.textContent = 'Hata: ' + h.message;
    bekle.classList.add('hata');
  } finally {
    $('#gonder').disabled = false;
  }
}

$('#sohbetForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  sohbetGonder($('#mesaj').value.trim());
});

document.querySelectorAll('[data-hizli]').forEach((b) => b.addEventListener('click', () => sohbetGonder(b.dataset.hizli)));

// Konuşma Tanıma (STT) ve Mikrofon Yedeği
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let tani;
let taniDinliyor = false;
let yedekKaydedici;
let yedekAkis;
let yedekZamanlayici;
let yedekParcalar = [];
let yedekBitiriyor = false;

async function yedekKaydiBaslat() {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Bu tarayıcı mikrofon kaydını desteklemiyor.');
  yedekAkis = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported?.(m));
  try {
    yedekKaydedici = new MediaRecorder(yedekAkis, mime ? { mimeType: mime } : undefined);
  } catch (h) {
    yedekAkis.getTracks().forEach((t) => t.stop());
    yedekAkis = null;
    throw new Error('Ses kaydı başlatılamadı: ' + h.message);
  }
  yedekParcalar = [];
  yedekBitiriyor = false;
  yedekKaydedici.ondataavailable = (e) => { if (e.data.size) yedekParcalar.push(e.data); };
  yedekKaydedici.onstop = async () => {
    clearTimeout(yedekZamanlayici);
    const blob = new Blob(yedekParcalar, { type: yedekKaydedici.mimeType || 'audio/webm' });
    yedekAkis?.getTracks().forEach((t) => t.stop());
    yedekAkis = null;
    $('#mikrofon').classList.remove('dinliyor');
    $('#mikrofon').textContent = '🎙';
    try {
      if (blob.size < 500) throw new Error('Ses çok kısa; tekrar deneyebilirsin.');
      $('#sesDurumu').textContent = 'Ses yazıya çevriliyor…';
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const { metin } = await api('/sese-yazi', { ses: btoa(binary), mime: blob.type.split(';')[0] || 'audio/webm' });
      if (!metin?.trim()) throw new Error('Konuşma anlaşılamadı.');
      $('#mesaj').value = metin;
      $('#sesDurumu').textContent = 'Konuşman yazıya çevrildi.';
      await sohbetGonder(metin);
    } catch (h) {
      $('#sesDurumu').textContent = h.message;
    }
  };
  yedekKaydedici.start();
  $('#mikrofon').classList.add('dinliyor');
  $('#mikrofon').textContent = '■';
  $('#sesDurumu').textContent = 'Kaydediyorum… Bitirmek için tekrar dokun.';
  yedekZamanlayici = setTimeout(yedekKaydiDurdur, 30_000);
}

function yedekKaydiDurdur() {
  if (yedekKaydedici?.state === 'recording' && !yedekBitiriyor) {
    yedekBitiriyor = true;
    clearTimeout(yedekZamanlayici);
    yedekKaydedici.stop();
  }
}

if (SpeechRecognition) {
  tani = new SpeechRecognition();
  tani.lang = 'tr-TR';
  tani.interimResults = false;
  tani.continuous = false;
  tani.onstart = () => { taniDinliyor = true; $('#mikrofon').classList.add('dinliyor'); $('#sesDurumu').textContent = 'Dinliyorum…'; };
  tani.onresult = (e) => { $('#mesaj').value = e.results[0][0].transcript; sohbetGonder(e.results[0][0].transcript); };
  tani.onerror = async (e) => {
    $('#mikrofon').classList.remove('dinliyor');
    if (e.error !== 'aborted') {
      try {
        $('#sesDurumu').textContent = 'Sunucu mikrofon yedeğine geçiliyor…';
        await yedekKaydiBaslat();
      } catch (h) {
        $('#sesDurumu').textContent = `${h.message} İstersen yazıyla devam et.`;
      }
    }
  };
  tani.onend = () => {
    taniDinliyor = false;
    if (yedekKaydedici?.state !== 'recording') {
      $('#mikrofon').classList.remove('dinliyor');
      $('#sesDurumu').textContent = 'Mikrofon düğmesine dokunup konuş; terminal yazmak yok.';
    }
  };
  $('#mikrofon')?.addEventListener('click', () => {
    if (yedekKaydedici?.state === 'recording') { yedekKaydiDurdur(); return; }
    if (taniDinliyor) { tani.stop(); return; }
    try { tani.start(); } catch { yedekKaydiBaslat().catch((h) => { $('#sesDurumu').textContent = h.message; }); }
  });
} else if (navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined') {
  $('#mikrofon')?.addEventListener('click', () => {
    if (yedekKaydedici?.state === 'recording') yedekKaydiDurdur();
    else yedekKaydiBaslat().catch((h) => { $('#sesDurumu').textContent = h.message; });
  });
  if ($('#sesDurumu')) $('#sesDurumu').textContent = 'Düğmeye dokunup konuş, bitirmek için tekrar dokun.';
}

$('#bak')?.addEventListener('click', async () => {
  const bekle = balon('sistem', 'kameraya bakıyor…');
  try {
    const f = await api('/bak', { kamera: 0 });
    bekle.remove();
    bekleyenGorsel = `data:${f.mime};base64,${f.base64}`;
    balon('asistan', 'Şu an gördüğüm görüntü:', bekleyenGorsel);
  } catch (h) {
    bekle.textContent = 'Hata: ' + h.message;
  }
});

$('#soyle')?.addEventListener('click', async () => {
  const metin = prompt('Telefonun hoparlöründen ne söylensin?');
  if (!metin) return;
  try {
    await api('/soyle', { metin });
    balon('sistem', `🔊 "${metin}" hoparlörden seslendirildi.`);
  } catch (h) {
    balon('sistem', 'Hata: ' + h.message);
  }
});

$('#sifirla')?.addEventListener('click', async () => {
  await api('/sohbet/sifirla', { oturum: 'panel' });
  $('#sohbet').innerHTML = '';
  balon('sistem', 'Sohbet temizlendi.');
});

/* ==========================================================================
   DURUM, SAĞLIK VE GÖREVLER
   ========================================================================== */
async function durumYukle() {
  try {
    const d = await api('/durum');
    $('#asistanAdi').textContent = d.asistan || 'Aspasia';
    if (d.kullanici) $('#kullaniciEtiket').textContent = d.kullanici + ' İçin Hazır';
    
    const yasiyor = d.beden?.durum === 'yasiyor';
    $('#nabiz').className = 'nabiz' + (yasiyor ? ' yasiyor' : '');
    const pil = yasiyor ? await api('/pil', {}).catch(() => null) : null;
    const maliyet = await api('/maliyet?gun=1').catch(() => null);
    
    const rozet = (b, s) => `<div class="rozet"><b>${kacir(b)}</b><span>${s}</span></div>`;
    $('#durum').innerHTML =
      rozet('Beden', yasiyor ? `yaşıyor (${kacir(d.beden.mod)})` : '<span class="hata">ulaşılamıyor</span>') +
      rozet('Pil', pil ? `%${kacir(pil.percentage)} ${pil.status === 'CHARGING' ? '⚡' : ''} ${pil.temperature ? kacir(pil.temperature) + '°C' : ''}` : '—') +
      rozet('Bugün', maliyet ? `${kacir(maliyet.token)} token` : '—') +
      rozet('LLM', kacir(d.llm.model || 'otomatik')) +
      rozet('Kulak / Ağız', `${kacir(d.llm.stt)} / ${kacir(d.llm.tts)}`) +
      rozet('Çalışma', `${Math.floor(d.calismaSuresi / 3600)}s ${Math.floor((d.calismaSuresi % 3600) / 60)}dk`) +
      rozet('RAM', `${kacir(d.bellek.rssMB)} MB`);
    
    if ($('#agBilgi')) $('#agBilgi').textContent = 'Ağ IP: ' + (d.ag || []).map((a) => `${a.ip} (${a.arayuz})`).join(', ');
  } catch (h) {
    if ($('#durum')) $('#durum').innerHTML = `<div class="rozet hata">${h.message}</div>`;
  }
}

async function gorevleriYukle() {
  const hedef = $('#gorevler');
  if (!hedef) return;
  try {
    const { gorevler } = await api('/gorevler');
    if (!gorevler?.length) {
      hedef.innerHTML = '<p class="soluk">Henüz görüşme görevi yok.</p>';
      return;
    }
    hedef.innerHTML = gorevler.map((g) => {
      const liste = (d) => (Array.isArray(d) && d.length ? `<ul>${d.map((x) => `<li>${kacir(x)}</li>`).join('')}</ul>` : '');
      const sonuc = g.sonuc ? `<p><b>Sonuç:</b> ${g.sonuc.basarili ? '✅' : '❌'} ${kacir(g.sonuc.ozet || '')}</p>${liste(g.sonuc.takip)}` : '';
      const aranabilir = ['hazir', 'taslak'].includes(g.durum);
      const iptalEdilebilir = ['hazir', 'taslak', 'araniyor'].includes(g.durum);
      return `
        <div class="gorev" data-id="${kacir(g.id)}">
          <div class="ust">
            <strong>${kacir(g.baslik || g.talimat)}</strong>
            <span class="durum ${kacir(g.durum)}">${kacir(g.durum)}</span>
          </div>
          <div class="soluk">${kacir(g.kisi?.ad || '?')} · ${kacir(g.kisi?.numara || 'numara yok')} · ${kacir(g.amac || '')}</div>
          ${liste(g.konusma_noktalari)}${sonuc}
          <div class="eylemler">
            ${aranabilir ? `<a class="buton birincil" href="/telefon?gorev=${encodeURIComponent(g.id)}" target="_blank">📞 WebPhone</a>` : ''}
            ${aranabilir && g.kisi?.numara ? `<button class="buton" data-eylem="voip">📳 VoIP Santralden Ara</button>` : ''}
            ${aranabilir && g.kisi?.numara ? `<button class="buton" data-eylem="hucresel">📱 Hattan Çevir</button>` : ''}
            ${iptalEdilebilir ? `<button class="buton tehlike" data-eylem="iptal">İptal</button>` : ''}
            <button class="buton tehlike" data-eylem="sil">🗑 Sil</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (h) {
    hedef.innerHTML = `<p class="soluk hata">Görevler alınamadı: ${h.message}</p>`;
  }
}

$('#gorevler')?.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-eylem]');
  if (!b) return;
  const id = b.closest('.gorev').dataset.id;
  try {
    if (b.dataset.eylem === 'iptal') await api(`/gorevler/${id}`, { durum: 'iptal' });
    if (b.dataset.eylem === 'sil') {
      if (!confirm('Bu görev kaydı kalıcı olarak silinecek. Onaylıyor musunuz?')) return;
      await api(`/gorevler/${id}/sil`, {});
    }
    if (b.dataset.eylem === 'voip') {
      const s = await api(`/gorevler/${id}/voip-ara`, {});
      bildir('VoIP çağrısı başlatıldı: ' + s.numara);
    }
    if (b.dataset.eylem === 'hucresel') {
      const s = await api(`/gorevler/${id}/hucresel-ara`, {});
      bildir(`Çevriliyor: ${s.arandi}`);
    }
    await gorevleriYukle();
  } catch (h) {
    bildir('Hata: ' + h.message, true);
  }
});

$('#gorevForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const talimat = $('#talimat').value.trim();
  if (!talimat) return;
  const numara = $('#numara').value.trim();
  const dugme = e.target.querySelector('button');
  dugme.disabled = true;
  try {
    await api('/gorevler', { talimat, numara: numara || undefined });
    $('#talimat').value = '';
    $('#numara').value = '';
    await gorevleriYukle();
  } catch (h) {
    bildir('Hata: ' + h.message, true);
  } finally {
    dugme.disabled = false;
  }
});

async function hafizaYukle() {
  const el = $('#hafiza');
  if (!el) return;
  try {
    const { icerik } = await api('/hafiza');
    el.textContent = icerik || '(Hafıza henüz boş)';
  } catch (h) {
    el.textContent = h.message;
  }
}

/* ==========================================================================
   CEBİMON GÖREV TAHTASI
   ========================================================================== */
const sinifAdlari = { kivilcim: 'Kıvılcım', nobetci: 'Nöbetçi', sekreter: 'Sekreter', gezgin: 'Gezgin', operator: 'Operatör', usta: 'Usta' };
const modAdlari = { hazir: 'Hazır', nobette: 'Nöbette', dusunuyor: 'Düşünüyor', konusuyor: 'Konuşuyor', supheli: 'Onay bekliyor', yarali: 'Desteğe ihtiyacı var' };

function cebiTahtayiCiz(oturum) {
  const hedef = $('#cebiTahta');
  if (!hedef) return;
  if (!oturum) { hedef.innerHTML = '<p class="soluk">Henüz açık bir plan yok.</p>'; return; }
  const adimlar = (oturum.adimlar || []).map((a) => {
    const ikon = a.durum === 'tamamlandi' ? '✓' : a.durum === 'aktif' ? '→' : a.durum === 'onay_bekliyor' ? '!' : '○';
    const inceleme = a.incelemeler?.at(-1);
    return `<li class="plan-adim ${kacir(a.durum)}"><b>${ikon} ${kacir(a.metin)}</b>${inceleme ? `<p class="soluk">${kacir(inceleme.geriBildirim || inceleme.gozlem)} · güven %${Math.round(inceleme.guven * 100)}</p>` : ''}</li>`;
  }).join('');
  const aktif = oturum.adimlar?.find((a) => a.durum === 'aktif');
  const bekleyen = oturum.adimlar?.find((a) => a.durum === 'onay_bekliyor');
  hedef.innerHTML = `
    <div class="cebi-plan-kart">
      <div class="ust"><strong>${kacir(oturum.ortam)} · ${kacir(oturum.risk)} risk</strong><span class="hazir-rozet">${oturum.tamamlandi ? 'Tamamlandı' : oturum.bekleyenOnay ? 'Onay bekliyor' : 'Devam ediyor'}</span></div>
      <p class="soluk">${kacir(oturum.amac)}</p><ol class="plan-adimlar">${adimlar}</ol>
      <div class="eylemler" style="display:flex;gap:6px;margin-top:10px">
        ${aktif ? '<button class="buton birincil" data-cebi-eylem="incele">📷🎙 Aktif Adımı Doğrula</button>' : ''}
        ${bekleyen ? '<button class="buton birincil" data-cebi-eylem="onay">Adımı Onayla</button><button class="buton tehlike" data-cebi-eylem="reddet">Onaylama</button>' : ''}
        ${oturum.tamamlandi ? '<button class="buton" data-cebi-eylem="bitir">Oturumu Bitir</button>' : ''}
      </div>
    </div>
  `;
}

async function cebimonYukle() {
  try {
    const c = await api('/cebi');
    if ($('#cebiAd')) $('#cebiAd').textContent = c.ad;
    if ($('#cebiSinif')) $('#cebiSinif').textContent = sinifAdlari[c.sinif] || c.sinif;
    if ($('#cebiMod')) $('#cebiMod').textContent = modAdlari[c.mod] || c.mod;
    if ($('#cebiCihaz')) $('#cebiCihaz').textContent = c.cihaz?.pil != null ? `Pil %${c.cihaz.pil}${c.cihaz.sicaklik ? ` · ${c.cihaz.sicaklik}°C` : ''}` : 'Cihaz hazır';
    if ($('#cebiMesaj')) $('#cebiMesaj').textContent = c.oturum ? `${c.oturum.ortam} · ${c.oturum.amac || 'yanında çalışıyor'}` : (c.gunluk?.notlar?.at(-1)?.metin || 'Buradayım. Ne yapmak istiyorsan bana söyle.');
    if ($('#cebiYuz')) $('#cebiYuz').textContent = c.mod === 'yarali' ? '!' : c.mod === 'dusunuyor' ? '…' : '✦';
    cebiTahtayiCiz(c.oturum);
  } catch {}
}

document.querySelectorAll('.cebi-aksiyon').forEach((b) => b.addEventListener('click', async () => {
  const o = await api('/cebi/oturum', { ortam: b.dataset.ortam, amac: b.dataset.amac, risk: b.dataset.ortam === 'is' ? 'orta' : 'dusuk' });
  await api('/cebi/adim', { metin: 'Kamerayı ve ortamı hazırla', durum: 'aktif' });
  await cebimonYukle();
  balon('sistem', `${o.ortam} oturumu başladı: ${o.amac}`);
  $('#mesaj').focus();
}));

$('#cebiPlanForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const talimat = $('#cebiTalimat').value.trim();
  if (!talimat) return;
  const dugme = e.target.querySelector('button');
  dugme.disabled = true;
  try {
    await api('/cebi/planla', { talimat });
    $('#cebiTalimat').value = '';
    await cebimonYukle();
  } catch (h) {
    bildir('Plan oluşturulamadı: ' + h.message, true);
  } finally {
    dugme.disabled = false;
  }
});

$('#cebiTemizle')?.addEventListener('click', async () => {
  if (!confirm('Cebimon geçmişi silinsin mi?')) return;
  try {
    await api('/cebi/temizle', {});
    await cebimonYukle();
    bildir('Geçmiş temizlendi.');
  } catch (h) {
    bildir('Hata: ' + h.message, true);
  }
});

/* PWA VE YENİLEME */
$('#yenile')?.addEventListener('click', (e) => {
  e.preventDefault();
  durumYukle();
  cebimonYukle();
  sesleriYukle();
  gorevleriYukle();
  hafizaYukle();
  bildir('Veriler güncellendi ✓');
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
let kurulumIstemi = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  kurulumIstemi = e;
  if ($('#kur')) $('#kur').style.display = '';
});
$('#kur')?.addEventListener('click', async () => {
  if (!kurulumIstemi) return;
  kurulumIstemi.prompt();
  await kurulumIstemi.userChoice.catch(() => {});
  kurulumIstemi = null;
  $('#kur').style.display = 'none';
});

// İlk çalıştırma
durumYukle();
cebimonYukle();
sesleriYukle();
gorevleriYukle();
hafizaYukle();
ayarlariYukle();

setInterval(() => {
  durumYukle();
  cebimonYukle();
}, 60_000);
