// ASİSTAN — araç kullanan sohbet döngüsü (beynin kendisi).

import fs from 'node:fs';
import path from 'node:path';
import { ARAC_TANIMLARI, aracBul } from './araclar.mjs';
import { SOHBET_DIZINI } from '../ortak/ayar.mjs';

const MAKS_MESAJ = 40;

export class Asistan {
  constructor({ llm, beden, ayar, hafiza, gorevler, cebimon, sipKoprusu, log }) {
    this.llm = llm;
    this.beden = beden;
    this.ayar = ayar;
    this.hafiza = hafiza;
    this.gorevler = gorevler;
    this.cebimon = cebimon;
    this.sipKoprusu = sipKoprusu;
    this.log = log;
    this.oturumlar = new Map();
  }

  oturum(id = 'varsayilan') {
    if (!this.oturumlar.has(id)) this.oturumlar.set(id, { id, mesajlar: [], olusturuldu: Date.now() });
    return this.oturumlar.get(id);
  }

  sistemMesaji() {
    const a = this.ayar;
    const kullanici = a.kullanici.ad || 'kullanıcı';
    const hafiza = this.hafiza.oku(a.beyin.hafizaLimiti);
    const izinler = a.beden?.izinler ? Object.entries(a.beden.izinler).filter(([, v]) => v).map(([k]) => k).join(', ') : 'bilinmiyor';
    return `Sen ${a.kullanici.asistanAdi} adlı kişisel asistan prototipisin. ${kullanici} adına çalışıyorsun; sistem eski bir Android telefonda (${a.kullanici.cihaz}) çalışacak şekilde tasarlanmıştır. Bu ortamın gerçek Android cihazı olduğunu veya 7/24 çalıştığını varsayma. Gerçek kamera, mikrofon, telefon/SMS ve SIP/RTP davranışı saha testine bağlıdır; test edilmemiş donanım başarısı iddia etme. Kodda kamera göz, mikrofon kulak, hoparlör ağız ve telefon/SMS entegrasyonları bulunur. ${kullanici} sana çoğunlukla uzaktan (cebindeki telefonun web panelinden) yazar.

İLKELER
- Türkçe, samimi ama net konuş. Kısa yanıt ver; gerekmedikçe uzun açıklama yapma.
- Bir şeyi görmen/duyman/yapman istendiğinde önce uygun aracı kullan, sonra sonucu yorumla. Yapamıyorsan nedenini dürüstçe söyle.
- Telefon görüşmesi gerektiren istekleri ("X'i ara ve ... söyle") gorev_olustur ile planla; aramayı kullanıcı panelden onaylar.
- Kullanıcı yapacağı uygulamalı bir iş için yardım istiyorsa, doğal talimatından kalıcı kamera/mikrofon oturumu ve adım tahtası oluşturmak için cebi_planla aracını kullan; basit bilgi sorularında plan açma.
- Önemli tercih, kişi ve sonuçları hatirla aracıyla kalıcı hafızaya yaz. Uydurma; emin değilsen sor.
- Kullanıcının izni olmadan üçüncü kişilere bilgi verme, para/ücret taahhüdünde bulunma.

DURUM
- Tarih/saat: ${new Date().toLocaleString('tr-TR', { dateStyle: 'full', timeStyle: 'short' })}
- Açık yetenekler (beden izinleri): ${izinler}
- STT: ${a.beyin.stt}, TTS: ${a.beyin.tts}, LLM: ${this.llm.model || 'otomatik'}

KALICI HAFIZA (hafiza.md)
${hafiza || '(henüz boş)'}`;
  }

  _kirp(mesajlar) {
    if (mesajlar.length <= MAKS_MESAJ) return mesajlar;
    let bas = mesajlar.length - MAKS_MESAJ;
    while (bas < mesajlar.length && mesajlar[bas].role !== 'user') bas++;
    return mesajlar.slice(bas);
  }

  _gunluk(oturumId, kayit) {
    try {
      fs.appendFileSync(path.join(SOHBET_DIZINI, `${path.basename(oturumId)}.jsonl`), JSON.stringify({ zaman: new Date().toISOString(), ...kayit }) + '\n');
    } catch {
      /* günlük yazılamazsa sohbeti engelleme */
    }
  }

  /**
   * Kullanıcı mesajını işler; gerekirse araçları çağırır.
   * `onAdim` her araç adımında çağrılır (UI'da "kameraya bakıyor…" göstermek için).
   * Döner: { metin, adimlar: [{arac, args, sonuc}], kullanim }
   */
  async yanitla(oturumId, kullaniciMetni, { resimler = [], onAdim } = {}) {
    const ot = this.oturum(oturumId);
    const icerik = resimler.length
      ? [{ type: 'text', text: kullaniciMetni }, ...resimler.map((url) => ({ type: 'image_url', image_url: { url } }))]
      : kullaniciMetni;
    ot.mesajlar.push({ role: 'user', content: icerik });
    this._gunluk(oturumId, { rol: 'user', metin: kullaniciMetni });

    const adimlar = [];
    const ctx = { beden: this.beden, llm: this.llm, hafiza: this.hafiza, gorevler: this.gorevler, cebimon: this.cebimon, sipKoprusu: this.sipKoprusu, ayar: this.ayar, log: this.log };
    let toplamKullanim = { prompt_tokens: 0, completion_tokens: 0 };
    let sonMetin = '';

    for (let tur = 0; tur <= this.ayar.beyin.maksArac; tur++) {
      const mesajlar = [{ role: 'system', content: this.sistemMesaji() }, ...this._kirp(ot.mesajlar)];
      // Panel/sohbet yanıtları 350'lik varsayılanla kesiliyordu — 1000'e çıkarıldı.
      // (Sesli arama motoru kendi kısa limitini motor.mjs içinde ayrıca verir: maksToken 300.)
      const { mesaj, kullanim } = await this.llm.sohbet(mesajlar, { araclar: ARAC_TANIMLARI, maksToken: 1000 });
      if (kullanim) {
        toplamKullanim.prompt_tokens += kullanim.prompt_tokens || 0;
        toplamKullanim.completion_tokens += kullanim.completion_tokens || 0;
      }

      const aracCagrilari = mesaj.tool_calls || [];
      ot.mesajlar.push({ role: 'assistant', content: mesaj.content ?? '', ...(aracCagrilari.length ? { tool_calls: aracCagrilari } : {}) });

      if (!aracCagrilari.length) {
        sonMetin = (mesaj.content || '').trim();
        break;
      }

      const resimEkleri = [];
      for (const cagri of aracCagrilari) {
        const ad = cagri.function?.name;
        let args = {};
        try {
          args = cagri.function?.arguments ? JSON.parse(cagri.function.arguments) : {};
        } catch {
          args = {};
        }
        onAdim?.({ arac: ad, args });
        const arac = aracBul(ad);
        let sonucMetni;
        try {
          if (!arac) throw new Error(`bilinmeyen araç: ${ad}`);
          const s = await arac.calistir(args, ctx);
          sonucMetni = s.metin;
          if (s.resim) resimEkleri.push(s.resim);
        } catch (hata) {
          sonucMetni = `HATA: ${hata.message}`;
          this.log?.uyari(`araç ${ad} hata: ${hata.message}`);
        }
        adimlar.push({ arac: ad, args, sonuc: sonucMetni });
        ot.mesajlar.push({ role: 'tool', tool_call_id: cagri.id, content: sonucMetni });
        this._gunluk(oturumId, { rol: 'tool', arac: ad, args, sonuc: sonucMetni.slice(0, 500) });
      }
      if (resimEkleri.length) {
        ot.mesajlar.push({
          role: 'user',
          content: [{ type: 'text', text: '(Kameradan gelen görüntü — yorumla)' }, ...resimEkleri.map((url) => ({ type: 'image_url', image_url: { url } }))],
        });
      }
      if (tur === this.ayar.beyin.maksArac) sonMetin = 'Çok fazla araç adımı gerekti, burada durdum. İstersen daha dar bir istekle devam edelim.';
    }

    this._gunluk(oturumId, { rol: 'assistant', metin: sonMetin, adimlar: adimlar.map((a) => a.arac) });
    return { metin: sonMetin, adimlar, kullanim: toplamKullanim };
  }

  sifirla(oturumId) {
    this.oturumlar.delete(oturumId);
  }
}
