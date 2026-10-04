// BEYİN — ajan + web paneli + telefon köprüsü sunucusu.
// Cebindeki telefondan http://<eski-telefon-ip>:20131/ adresinde açılır; giriş anahtarı POST ile verilir.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ayarYukle, ayarKaydet, envGuncelle, baresipHesapGuncelle, tokenAl, logOlustur, ASISTAN_HOME } from '../ortak/ayar.mjs';
import { HAZIR_SESLER, sesiCoz } from './araclar.mjs';
import { LLMIstemci, guvenliUrlGorunumu } from './llm.mjs';
import { BedenIstemci } from './beden-istemci.mjs';
import { Hafiza } from './hafiza.mjs';
import { GorevYoneticisi } from './gorev.mjs';
import { Asistan } from './asistan.mjs';
import { tarayiciKoprusuKur } from './kopru/tarayici.mjs';
import { SipKoprusu } from './kopru/sip.mjs';
import { Telemetri } from '../ortak/telemetri.mjs';
import { Cebimon } from './cebi.mjs';

const WEB_DIZINI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const BASLANGIC = Date.now();

function jsonYanit(res, kod, veri) {
  const govde = JSON.stringify(veri);
  res.writeHead(kod, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(govde) });
  res.end(govde);
}

function govdeOku(req, limit = 12 * 1024 * 1024) {
  return new Promise((coz, reddet) => {
    const parcalar = [];
    let boyut = 0;
    req.on('data', (p) => {
      boyut += p.length;
      if (boyut > limit) {
        reddet(Object.assign(new Error('istek çok büyük'), { kod: 413 }));
        req.destroy();
        return;
      }
      parcalar.push(p);
    });
    req.on('end', () => {
      if (!parcalar.length) return coz({});
      try {
        coz(JSON.parse(Buffer.concat(parcalar).toString('utf8')));
      } catch {
        reddet(Object.assign(new Error('geçersiz JSON'), { kod: 400 }));
      }
    });
    req.on('error', reddet);
  });
}

function cerezler(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((p) => p.trim().split('=').map(decodeURIComponent))
      .filter((p) => p[0]),
  );
}

/** Sabit zamanlı token karşılaştırma (zamanlama saldırısına karşı). */
function tokenEslesir(a, b) {
  const x = crypto.createHash('sha256').update(String(a || '')).digest();
  const y = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(x, y);
}

function agAdresleri() {
  const liste = [];
  for (const [ad, arayuzler] of Object.entries(os.networkInterfaces())) {
    for (const a of arayuzler || []) if (a.family === 'IPv4' && !a.internal) liste.push({ arayuz: ad, ip: a.address });
  }
  return liste;
}

export function beyinBaslat({ ayar = ayarYukle(), token = tokenAl('beyin'), bedenToken = tokenAl('beden'), log = logOlustur('beyin'), host, port } = {}) {
  const telemetri = new Telemetri();
  const cebimon = new Cebimon({ ad: ayar.kullanici.asistanAdi });
  const llm = new LLMIstemci({ ...ayar.beyin.llm, ttsSaglayici: ayar.beyin.tts, telemetry: telemetri });
  const aramaAyar = ayar.arama?.llm || {};
  const aramaBaseUrl = aramaAyar.baseUrl || (aramaAyar.model ? '' : llm.baseUrl);
  const aramaApiKey = aramaAyar.apiKey || (
    aramaBaseUrl.includes('groq.com') ? (ayar.beyin.llm.groqApiKey || process.env.GROQ_API_KEY) :
    aramaBaseUrl.includes('cerebras.ai') ? (ayar.beyin.llm.cerebrasApiKey || process.env.CEREBRAS_API_KEY) :
    aramaBaseUrl.includes('openrouter.ai') ? (ayar.beyin.llm.openrouterApiKey || process.env.OPENROUTER_API_KEY) :
    llm.apiKey
  );
  const aramaLlm = (aramaAyar.model || aramaAyar.baseUrl)
    ? new LLMIstemci({
        baseUrl: aramaBaseUrl || llm.baseUrl,
        apiKey: aramaApiKey,
        model: aramaAyar.model || llm.model,
        sicaklik: 0.3,
        sttModel: ayar.beyin.llm.sttModel,
        ttsModel: ayar.beyin.llm.ttsModel,
        ttsVoice: ayar.beyin.llm.ttsVoice,
        ttsSaglayici: ayar.beyin.tts,
        groqApiKey: ayar.beyin.llm.groqApiKey,
        openrouterApiKey: ayar.beyin.llm.openrouterApiKey,
        cerebrasApiKey: ayar.beyin.llm.cerebrasApiKey,
        elevenlabsApiKey: ayar.beyin.llm.elevenlabsApiKey,
        elevenlabsVoiceId: ayar.beyin.llm.elevenlabsVoiceId,
        elevenlabsModel: ayar.beyin.llm.elevenlabsModel,
        fishAudioApiKey: ayar.beyin.llm.fishAudioApiKey,
        fishAudioVoiceId: ayar.beyin.llm.fishAudioVoiceId,
        telemetry: telemetri,
      })
    : llm;
  const beden = new BedenIstemci({ url: ayar.beyin.bedenUrl, token: bedenToken });
  const hafiza = new Hafiza();
  const gorevler = new GorevYoneticisi({ llm, ayar, hafiza, log });
  const sipKoprusu = new SipKoprusu({ llm: aramaLlm, gorevler, ayar, log });
  const asistan = new Asistan({ llm, beden, ayar, hafiza, gorevler, cebimon, sipKoprusu, log });

  const yetkiliMi = (req) => {
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return tokenEslesir(bearer, token) || tokenEslesir(cerezler(req).asistan_token, token);
  };

  async function api(req, res, url) {
    const yol = url.pathname.replace(/^\/api/, '');
    const govde = req.method === 'POST' ? await govdeOku(req) : {};
    const M = req.method;

    if (M === 'GET' && yol === '/durum') {
      const bedenDurum = await beden.saglik();
      let yetenekler = null;
      if (bedenDurum.durum === 'yasiyor') yetenekler = await beden.yetenekler().catch(() => null);
      return {
        asistan: ayar.kullanici.asistanAdi,
        kullanici: ayar.kullanici.ad,
        calismaSuresi: Math.round((Date.now() - BASLANGIC) / 1000),
        beden: { ...bedenDurum, yetenekler },
        llm: { baseUrl: guvenliUrlGorunumu(llm.baseUrl), model: llm.model || '(otomatik)', stt: ayar.beyin.stt, tts: ayar.beyin.tts },
        arama: {
          varsayilanMod: ayar.arama?.varsayilanMod,
          aiOlduguSoylensin: ayar.arama?.aiOlduguSoylensin,
          maksSure: ayar.arama?.maksSure,
          llm: {
            baseUrl: guvenliUrlGorunumu(aramaLlm.baseUrl),
            model: aramaLlm.model || '(otomatik)',
            apiKeyConfigured: Boolean(aramaApiKey),
          },
        },
        ag: agAdresleri(),
        bellek: { rssMB: Math.round(process.memoryUsage().rss / 1048576), bosMB: Math.round(os.freemem() / 1048576) },
      };
    }
    if (M === 'GET' && yol === '/modeller') return { modeller: await llm.modeller(), secili: llm.model };
    if (M === 'GET' && yol === '/maliyet') return telemetri.rapor({ gun: Math.min(365, Math.max(1, Number(url.searchParams.get('gun') || 1))) });
    if (M === 'GET' && yol === '/kara-kutu') return { olaylar: telemetri.oku({ limit: Math.min(2000, Math.max(1, Number(url.searchParams.get('limit') || 200))) }) };
    if (M === 'GET' && yol === '/cebi') {
      const bedenDurum = await beden.saglik();
      const pil = bedenDurum.durum === 'yasiyor' ? await beden.pil().catch(() => null) : null;
      return cebimon.durum({ pil, beden: bedenDurum, maliyet: telemetri.rapor({ gun: 1 }) });
    }
    if (M === 'POST' && yol === '/cebi/planla') {
      if (!govde.talimat?.trim()) throw Object.assign(new Error('talimat gerekli'), { kod: 400 });
      return cebimon.planlaAkilli(String(govde.talimat), llm);
    }
    if (M === 'POST' && yol === '/cebi/degerlendir') return cebimon.adimDegerlendir({ llm, gorsel: govde.gorsel, ses: govde.ses, mime: govde.mime });
    if (M === 'POST' && yol === '/cebi/onay') {
      if (typeof govde.onay !== 'boolean') throw Object.assign(new Error('onay true/false olmalı'), { kod: 400 });
      return cebimon.adimOnayla(govde.onay);
    }
    if (M === 'POST' && yol === '/cebi/oturum') return cebimon.oturumBaslat({ ortam: govde.ortam, amac: govde.amac, risk: govde.risk });
    if (M === 'POST' && yol === '/cebi/adim') return cebimon.adim(String(govde.metin || ''), govde.durum || 'bekliyor');
    if (M === 'POST' && yol === '/cebi/bitir') return cebimon.oturumBitir({ basarili: govde.basarili !== false, ozet: String(govde.ozet || '') });
    if (M === 'POST' && yol === '/cebi/temizle') return cebimon.temizle();
    if (M === 'POST' && yol === '/sese-yazi') {
      const ses = govde.ses;
      const mime = String(govde.mime || 'audio/webm').split(';', 1)[0].toLowerCase();
      if (typeof ses !== 'string' || ses.length > 10_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(ses)) throw Object.assign(new Error('geçerli ses kaydı gerekli veya kayıt çok büyük'), { kod: 400 });
      if (!['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/mpeg'].includes(mime)) throw Object.assign(new Error('desteklenmeyen ses biçimi'), { kod: 400 });
      const sesBuffer = Buffer.from(ses, 'base64');
      if (!sesBuffer.length || sesBuffer.length > 7_000_000) throw Object.assign(new Error('ses kaydı geçersiz veya çok büyük'), { kod: 400 });
      return { metin: await llm.yaziyaCevir(sesBuffer, { mime, dil: 'tr' }) };
    }

    if (M === 'POST' && yol === '/sohbet') {
      if (!govde.metin?.trim() && !govde.resimler?.length) throw Object.assign(new Error('metin gerekli'), { kod: 400 });
      const oturum = String(govde.oturum || 'panel');
      return asistan.yanitla(oturum, String(govde.metin || '(görsel gönderildi)'), { resimler: govde.resimler || [] });
    }
    if (M === 'POST' && yol === '/sohbet/sifirla') {
      asistan.sifirla(String(govde.oturum || 'panel'));
      return { tamam: true };
    }
    if (M === 'GET' && yol === '/hafiza') return { icerik: hafiza.oku(50_000) };
    if (M === 'POST' && yol === '/hafiza') return { satir: hafiza.hatirla(String(govde.metin || ''), govde.etiket || 'not') };

    if (M === 'POST' && yol === '/bak') {
      const s = await beden.fotografCek(Number(govde.kamera ?? 0));
      return { ad: s.ad, mime: s.mime, base64: s.base64 };
    }
    if (M === 'POST' && yol === '/soyle') {
      if (ayar.beyin.tts !== 'android') {
        try {
          const ses = await llm.seslendir(String(govde.metin || ''));
          await beden.sesCal({ base64: ses.toString('base64'), uzanti: 'mp3' });
        } catch {
          await beden.konus(String(govde.metin || ''), ayar.kullanici.dil);
        }
      } else await beden.konus(String(govde.metin || ''), ayar.kullanici.dil);
      return { tamam: true };
    }
    if (M === 'POST' && yol === '/pil') return beden.pil();

    if (M === 'GET' && yol === '/gorevler') return { gorevler: gorevler.listele() };
    if (M === 'POST' && yol === '/gorevler') {
      if (!govde.talimat?.trim()) throw Object.assign(new Error('talimat gerekli'), { kod: 400 });
      return gorevler.olustur(String(govde.talimat), { kaynak: 'panel', numara: govde.numara });
    }
    if (M === 'POST' && yol === '/voip/ara') {
      const numara = govde.numara;
      if (!numara) throw Object.assign(new Error('numara gerekli'), { kod: 400 });
      return sipKoprusu.ara({ numara, gorev: govde.gorev });
    }
    if (M === 'POST' && yol === '/hizli-ara') {
      const numara = String(govde.numara || '').trim();
      if (!numara) throw Object.assign(new Error('numara gerekli'), { kod: 400 });
      const secilenSes = sesiCoz(govde.ses || govde.sesId, ayar);
      const sesId = secilenSes ? secilenSes.id : (govde.sesId || (ayar.beyin.tts === 'fish_audio' ? ayar.beyin.llm.fishAudioVoiceId : ayar.beyin.llm.ttsVoice));
      const talimat = govde.talimat || `${numara} ile telefon görüşmesi`;
      const g = await gorevler.olustur(talimat, { kaynak: 'hizli-ara', numara });
      if (sesId) g.ses = sesId;
      if (govde.acilis) g.acilis = govde.acilis;
      const s = await sipKoprusu.ara({ gorev: g, numara });
      gorevler.guncelle(g.id, { durum: 'araniyor', mod: 'voip', kisi: { ...g.kisi, numara }, ses: sesId });
      return { tamam: true, gorevId: g.id, durum: 'araniyor', ses: sesId, ...s };
    }

    if (M === 'GET' && yol === '/sesler') {
      const aktifId = ayar.beyin.tts === 'fish_audio'
        ? (ayar.beyin.llm.fishAudioVoiceId || HAZIR_SESLER[0].id)
        : (ayar.beyin.llm.ttsVoice || 'tr-TR-EmelNeural');
      const aktifSes = HAZIR_SESLER.find((s) => s.id === aktifId)
        || (ayar.ozelSesler || []).find((s) => s.id === aktifId)
        || { id: aktifId, ad: aktifId, tur: ayar.beyin.tts, etiket: 'Aktif Ses' };
      return {
        aktif: { ...aktifSes, tur: ayar.beyin.tts },
        sesler: HAZIR_SESLER,
        ozelSesler: ayar.ozelSesler || [],
      };
    }
    if (M === 'POST' && yol === '/ses/on-dinle') {
      const sesGiris = govde.sesId || govde.ses;
      if (!sesGiris) throw Object.assign(new Error('sesId gerekli'), { kod: 400 });
      const cozulmus = sesiCoz(sesGiris, ayar);
      const sesId = cozulmus ? cozulmus.id : sesGiris;
      const tur = cozulmus?.tur || govde.tur || (sesId.length === 32 ? 'fish_audio' : 'edge-tts');
      const metin = String(govde.metin || 'Merhaba! Ben senin yapay zeka asistanınım, nasıl yardımcı olabilirim?');
      const sesBuf = await llm.seslendir(metin, { ses: sesId, motor: tur, format: 'mp3' });
      if (!sesBuf || !sesBuf.length) throw Object.assign(new Error('Ses sentezlenemedi'), { kod: 500 });
      return { tamam: true, sesBase64: sesBuf.toString('base64'), mime: 'audio/mp3' };
    }
    if (M === 'POST' && yol === '/ses/varsayilan-yap') {
      const sesGiris = govde.sesId || govde.ses;
      if (!sesGiris) throw Object.assign(new Error('sesId gerekli'), { kod: 400 });
      const cozulmus = sesiCoz(sesGiris, ayar);
      const sesId = cozulmus ? cozulmus.id : sesGiris;
      const tur = cozulmus?.tur || govde.tur || (sesId.length === 32 ? 'fish_audio' : 'edge-tts');
      const ad = cozulmus?.ad || govde.ad || sesId;
      if (tur === 'fish_audio') {
        ayar.beyin.tts = 'fish_audio';
        ayar.beyin.llm.fishAudioVoiceId = sesId;
        llm.ttsSaglayici = 'fish_audio';
        llm.fishAudioVoiceId = sesId;
        aramaLlm.ttsSaglayici = 'fish_audio';
        aramaLlm.fishAudioVoiceId = sesId;
        envGuncelle({ TTS_SAGLAYICI: 'fish_audio', FISH_AUDIO_VOICE_ID: sesId });
      } else {
        ayar.beyin.tts = tur || 'edge-tts';
        ayar.beyin.llm.ttsVoice = sesId;
        llm.ttsSaglayici = ayar.beyin.tts;
        llm.ttsVoice = sesId;
        aramaLlm.ttsSaglayici = ayar.beyin.tts;
        aramaLlm.ttsVoice = sesId;
        envGuncelle({ TTS_SAGLAYICI: ayar.beyin.tts, TTS_VOICE: sesId });
      }
      ayarKaydet(ayar);
      return { tamam: true, aktif: { id: sesId, ad, tur: ayar.beyin.tts } };
    }
    if (M === 'POST' && yol === '/ses/ozel-ekle') {
      const id = String(govde.id || '').trim();
      const ad = String(govde.ad || '').trim();
      const aciklama = String(govde.aciklama || '').trim();
      if (!id || !ad) throw Object.assign(new Error('Voice ID ve İsim zorunludur'), { kod: 400 });
      if (!ayar.ozelSesler) ayar.ozelSesler = [];
      const yeniSes = { id, ad, tur: 'fish_audio', kategori: 'klon', etiket: 'Özel Klon', aciklama: aciklama || 'Özel tanımlı ses' };
      const idx = ayar.ozelSesler.findIndex((s) => s.id === id);
      if (idx >= 0) ayar.ozelSesler[idx] = yeniSes;
      else ayar.ozelSesler.push(yeniSes);
      ayarKaydet(ayar);
      return { tamam: true, ses: yeniSes };
    }

    if (M === 'GET' && yol === '/ayarlar') {
      return {
        kullanici: {
          ad: ayar.kullanici.ad || '',
          asistanAdi: ayar.kullanici.asistanAdi || 'Aspasia',
          dil: ayar.kullanici.dil || 'tr-TR',
        },
        llm: {
          baseUrl: guvenliUrlGorunumu(llm.baseUrl),
          apiKey: llm.apiKey || '',
          model: llm.model || '',
          groqApiKey: ayar.beyin.llm.groqApiKey || '',
          openrouterApiKey: ayar.beyin.llm.openrouterApiKey || '',
        },
        ses: {
          ttsSaglayici: ayar.beyin.tts || 'piper',
          sttSaglayici: ayar.beyin.stt || 'android',
          ttsVoice: ayar.beyin.llm.ttsVoice || 'tr-TR-EmelNeural',
          fishAudioApiKey: ayar.beyin.llm.fishAudioApiKey || '',
          fishAudioVoiceId: ayar.beyin.llm.fishAudioVoiceId || '66f55da63a4a47b982ae64723dd79194',
        },
        sip: {
          sunucu: ayar.sip?.sunucu || 'pbx.zadarma.com',
          kullanici: ayar.sip?.kullanici || '',
          sifre: ayar.sip?.sifre ? '••••••••' : '',
          port: ayar.sip?.port || 5060,
        },
        ozelSesler: ayar.ozelSesler || [],
      };
    }
    if (M === 'POST' && yol === '/ayarlar') {
      const envGuncellemeleri = {};

      if (govde.kullanici?.ad !== undefined) {
        ayar.kullanici.ad = String(govde.kullanici.ad).trim();
        envGuncellemeleri.KULLANICI_ADI = ayar.kullanici.ad;
      }
      if (govde.kullanici?.asistanAdi !== undefined) {
        ayar.kullanici.asistanAdi = String(govde.kullanici.asistanAdi).trim();
        cebimon.ad = ayar.kullanici.asistanAdi;
        envGuncellemeleri.ASISTAN_ADI = ayar.kullanici.asistanAdi;
      }
      if (govde.llm?.baseUrl !== undefined && govde.llm.baseUrl.trim()) {
        ayar.beyin.llm.baseUrl = String(govde.llm.baseUrl).trim();
        llm.baseUrl = ayar.beyin.llm.baseUrl;
        aramaLlm.baseUrl = ayar.beyin.llm.baseUrl;
        envGuncellemeleri.LLM_BASE_URL = ayar.beyin.llm.baseUrl;
      }
      if (govde.llm?.apiKey !== undefined) {
        ayar.beyin.llm.apiKey = String(govde.llm.apiKey).trim();
        llm.apiKey = ayar.beyin.llm.apiKey;
        aramaLlm.apiKey = ayar.beyin.llm.apiKey;
        envGuncellemeleri.LLM_API_KEY = ayar.beyin.llm.apiKey;
      }
      if (govde.llm?.model !== undefined) {
        ayar.beyin.llm.model = String(govde.llm.model).trim();
        llm.model = ayar.beyin.llm.model;
        aramaLlm.model = ayar.beyin.llm.model;
        envGuncellemeleri.LLM_MODEL = ayar.beyin.llm.model;
      }
      if (govde.llm?.groqApiKey !== undefined) {
        ayar.beyin.llm.groqApiKey = String(govde.llm.groqApiKey).trim();
        llm.groqApiKey = ayar.beyin.llm.groqApiKey;
        envGuncellemeleri.GROQ_API_KEY = ayar.beyin.llm.groqApiKey;
      }
      if (govde.llm?.openrouterApiKey !== undefined) {
        ayar.beyin.llm.openrouterApiKey = String(govde.llm.openrouterApiKey).trim();
        llm.openrouterApiKey = ayar.beyin.llm.openrouterApiKey;
        envGuncellemeleri.OPENROUTER_API_KEY = ayar.beyin.llm.openrouterApiKey;
      }
      if (govde.ses?.fishAudioApiKey !== undefined) {
        ayar.beyin.llm.fishAudioApiKey = String(govde.ses.fishAudioApiKey).trim();
        llm.fishAudioApiKey = ayar.beyin.llm.fishAudioApiKey;
        aramaLlm.fishAudioApiKey = ayar.beyin.llm.fishAudioApiKey;
        envGuncellemeleri.FISH_AUDIO_API_KEY = ayar.beyin.llm.fishAudioApiKey;
      }
      if (govde.ses?.fishAudioVoiceId !== undefined) {
        ayar.beyin.llm.fishAudioVoiceId = String(govde.ses.fishAudioVoiceId).trim();
        llm.fishAudioVoiceId = ayar.beyin.llm.fishAudioVoiceId;
        aramaLlm.fishAudioVoiceId = ayar.beyin.llm.fishAudioVoiceId;
        envGuncellemeleri.FISH_AUDIO_VOICE_ID = ayar.beyin.llm.fishAudioVoiceId;
      }
      if (govde.ses?.ttsSaglayici !== undefined) {
        ayar.beyin.tts = String(govde.ses.ttsSaglayici).trim();
        llm.ttsSaglayici = ayar.beyin.tts;
        aramaLlm.ttsSaglayici = ayar.beyin.tts;
        envGuncellemeleri.TTS_SAGLAYICI = ayar.beyin.tts;
      }
      if (govde.ses?.ttsVoice !== undefined) {
        ayar.beyin.llm.ttsVoice = String(govde.ses.ttsVoice).trim();
        llm.ttsVoice = ayar.beyin.llm.ttsVoice;
        aramaLlm.ttsVoice = ayar.beyin.llm.ttsVoice;
        envGuncellemeleri.TTS_VOICE = ayar.beyin.llm.ttsVoice;
      }
      if (govde.sip) {
        if (!ayar.sip) ayar.sip = {};
        if (govde.sip.sunucu) { ayar.sip.sunucu = String(govde.sip.sunucu).trim(); envGuncellemeleri.SIP_SERVER = ayar.sip.sunucu; }
        if (govde.sip.kullanici) { ayar.sip.kullanici = String(govde.sip.kullanici).trim(); envGuncellemeleri.SIP_USER = ayar.sip.kullanici; }
        if (govde.sip.sifre && govde.sip.sifre !== '••••••••') { ayar.sip.sifre = String(govde.sip.sifre).trim(); envGuncellemeleri.SIP_PASS = ayar.sip.sifre; }
        if (govde.sip.port) { ayar.sip.port = Number(govde.sip.port); envGuncellemeleri.SIP_PORT = String(ayar.sip.port); }
      }

      ayarKaydet(ayar);
      envGuncelle(envGuncellemeleri);
      if (ayar.sip?.kullanici && ayar.sip?.sunucu && ayar.sip?.sifre) {
        baresipHesapGuncelle(ayar.sip);
      }

      return { tamam: true, mesaj: 'Ayarlar başarıyla kaydedildi ve uygulandı.' };
    }
    const gorevEs = yol.match(/^\/gorevler\/([^/]+)(?:\/([^/]+))?$/);
    if (gorevEs) {
      const [, id, eylem] = gorevEs;
      const g = gorevler.al(id);
      if (!g) throw Object.assign(new Error('görev yok'), { kod: 404 });
      if (M === 'GET' && !eylem) return g;
      if (M === 'POST' && !eylem) {
        const izinli = ['durum', 'kisi', 'mod', 'konusma_noktalari', 'sinirlar', 'acilis', 'amac', 'baslik', 'ton'];
        const yama = Object.fromEntries(Object.entries(govde).filter(([k]) => izinli.includes(k)));
        return gorevler.guncelle(id, yama);
      }
      if (M === 'POST' && eylem === 'hucresel-ara') {
        const numara = govde.numara || g.kisi?.numara;
        if (!numara) throw Object.assign(new Error('numara yok'), { kod: 400 });
        const s = await beden.ara(numara);
        gorevler.guncelle(id, { durum: 'araniyor', mod: 'hucresel', kisi: { ...g.kisi, numara } });
        return { ...s, brifing: { acilis: g.acilis, konusma_noktalari: g.konusma_noktalari, sinirlar: g.sinirlar } };
      }
      if (M === 'POST' && eylem === 'voip-ara') {
        const numara = govde.numara || g.kisi?.numara;
        if (!numara) throw Object.assign(new Error('numara yok'), { kod: 400 });
        const s = await sipKoprusu.ara({ gorev: g, numara });
        gorevler.guncelle(id, { durum: 'araniyor', mod: 'voip', kisi: { ...g.kisi, numara } });
        return { ...s, brifing: { acilis: g.acilis, konusma_noktalari: g.konusma_noktalari, sinirlar: g.sinirlar } };
      }
      if (M === 'POST' && eylem === 'sil') {
        // Gizlilik: kullanıcı görev kaydını (transkript dahil) kalıcı olarak silebilmeli
        gorevler.sil(id);
        return { silindi: id };
      }
      if (M === 'POST' && eylem === 'sonuc') {
        const sonuc = { basarili: Boolean(govde.basarili), ozet: String(govde.ozet || ''), kararlar: govde.kararlar || [], takip: govde.takip || [], bitis: new Date().toISOString(), sebep: 'elle-girildi' };
        hafiza.hatirla(`Görüşme #${id} (${g.kisi?.ad || '?'}): ${sonuc.ozet}`, 'sonuc');
        return gorevler.guncelle(id, { sonuc, durum: sonuc.basarili ? 'tamamlandi' : 'basarisiz' });
      }
    }
    throw Object.assign(new Error('rota yok'), { kod: 404 });
  }

  function statik(res, dosyaAdi, ekBasliklar = {}) {
    const tam = path.join(WEB_DIZINI, path.normalize(dosyaAdi).replace(/^(\.\.[/\\])+/, ''));
    if (!tam.startsWith(WEB_DIZINI) || !fs.existsSync(tam) || fs.statSync(tam).isDirectory()) return jsonYanit(res, 404, { hata: 'yok' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(tam)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...ekBasliklar });
    fs.createReadStream(tam).pipe(res);
  }

  // ~/.asistan/tls/{cert,key}.pem varsa HTTPS: tarayıcıda mikrofon/konuşma tanıma için güvenli bağlam gerekir.
  const tlsDizini = path.join(ASISTAN_HOME, 'tls');
  const tls = ['cert.pem', 'key.pem'].every((d) => fs.existsSync(path.join(tlsDizini, d)))
    ? { cert: fs.readFileSync(path.join(tlsDizini, 'cert.pem')), key: fs.readFileSync(path.join(tlsDizini, 'key.pem')) }
    : null;

  const oturumCerezi = () => {
    const guvenli = tls || process.env.COOKIE_SECURE === '1';
    return `asistan_token=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${guvenli ? '; Secure' : ''}`;
  };
  const istekIsleyici = async (req, res) => {
    const url = new URL(req.url, 'http://beyin');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (url.pathname === '/saglik') return jsonYanit(res, 200, { durum: 'yasiyor', calismaSuresi: Math.round((Date.now() - BASLANGIC) / 1000) });

      // Tarayıcı tokenini yalnızca POST gövdesinden al; URL/localStorage'a koyma.
      if (url.pathname === '/api/giris' && req.method === 'POST') {
        res.setHeader('Cache-Control', 'no-store');
        const govde = await govdeOku(req, 4096);
        if (!tokenEslesir(govde.token, token)) {
          return jsonYanit(res, 401, { hata: 'erişim anahtarı geçersiz' });
        }
        res.writeHead(204, { 'Set-Cookie': oturumCerezi() });
        return res.end();
      }

      const yetkili = yetkiliMi(req);
      const sayfa = { '/': 'index.html', '/telefon': 'telefon.html', '/giris': 'giris.html' }[url.pathname];
      if (sayfa) {
        if (!yetkili) return statik(res, 'giris.html', { 'Cache-Control': 'no-store' });
        // Eski bağlantılarda kalan token query'sini, yetkili çerez varsa hemen URL'den çıkar.
        if (url.searchParams.has('token')) {
          const temizParametreler = new URLSearchParams(url.searchParams);
          temizParametreler.delete('token');
          const sorgu = temizParametreler.toString();
          res.writeHead(303, {
            Location: `${url.pathname}${sorgu ? `?${sorgu}` : ''}`,
            'Set-Cookie': oturumCerezi(),
            'Cache-Control': 'no-store',
          });
          return res.end();
        }
        // Oturum çerezi taşıyan HTML yanıtını önbelleğe koyma; eski çerez de HttpOnly olarak yenilenir.
        return statik(res, sayfa, { 'Set-Cookie': oturumCerezi(), 'Cache-Control': 'no-store' });
      }
      if (url.pathname.startsWith('/statik/')) return statik(res, url.pathname.slice('/statik/'.length));
      if (url.pathname === '/sw.js' || url.pathname === '/manifest.webmanifest') return statik(res, url.pathname.slice(1)); // PWA: kök kapsam

      if (url.pathname.startsWith('/api/')) {
        if (!yetkili) return jsonYanit(res, 401, { hata: 'yetkisiz — giriş çerezi veya Authorization: Bearer gerekli' });
        const sonuc = await api(req, res, url);
        return jsonYanit(res, 200, sonuc);
      }
      jsonYanit(res, 404, { hata: 'yok' });
    } catch (hata) {
      const kod = hata.kod || 500;
      if (kod >= 500) log.hata(`${req.method} ${url.pathname}: ${hata.message}`);
      jsonYanit(res, kod, { hata: hata.message });
    }
  };
  const sunucu = tls ? https.createServer(tls, istekIsleyici) : http.createServer(istekIsleyici);
  const sema = tls ? 'https' : 'http';

  const wss = tarayiciKoprusuKur({ sunucu, yetkiliMi, llm: aramaLlm, gorevler, ayar, log });

  const dinleHost = host ?? ayar.beyin.host;
  const dinlePort = port ?? ayar.beyin.port;
  sunucu.listen(dinlePort, dinleHost, async () => {
    const p = sunucu.address().port;
    log.bilgi(`Beyin ayakta → ${sema}://${dinleHost}:${p}${tls ? ' (TLS: ~/.asistan/tls)' : ''}`);
    for (const a of agAdresleri()) log.bilgi(`  Panel: ${sema}://${a.ip}:${p}/  (${a.arayuz})`);
    log.bilgi(`  Giriş anahtarı dosyası: ${path.join(ASISTAN_HOME, 'beyin.token')}`);
    const bd = await beden.saglik();
    log.bilgi(`Beden: ${bd.durum}${bd.mod ? ' (' + bd.mod + ')' : ''}`);
    try {
      log.bilgi(`LLM modeli: ${await llm.modelSagla()} @ ${guvenliUrlGorunumu(llm.baseUrl)}`);
    } catch (hata) {
      log.uyari(`LLM hazır değil: ${hata.message} — 9router çalışıyor mu? LLM_API_KEY doğru mu?`);
    }
  });

  return { sunucu, wss, asistan, gorevler, cebimon, llm, beden, hafiza, token };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  beyinBaslat();
}
