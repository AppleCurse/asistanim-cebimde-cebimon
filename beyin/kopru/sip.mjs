// SIP / VOIP TAŞIYICISI — Baresip üzerinden gerçek telefon aramaları.
// Baresip proot Ubuntu içinde çalışır, Termux üzerindeki beyin ctrl_tcp (port 4444)
// ve /tmp/baresip_{in,out}.fifo üzerinden çift yönlü ses ve komutları yönetir.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Gorusme } from './motor.mjs';
import { ASISTAN_HOME } from '../../ortak/ayar.mjs';

const ROOTFS_TMP = '/data/data/com.termux/files/usr/var/lib/proot-distro/containers/ubuntu/rootfs/tmp';
const BASE_TMP = fs.existsSync(ROOTFS_TMP) ? ROOTFS_TMP : '/tmp';

/** DJB Netstring kodlama: <uzunluk>:<veri>, */
export function netstringKodla(nesne) {
  const json = JSON.stringify(nesne);
  const len = Buffer.byteLength(json, 'utf8');
  return `${len}:${json},`;
}

/** Netstring ve JSON akış ayrıştırıcı */
export class NetstringAyristirici {
  constructor(onMesaj) {
    this.onMesaj = onMesaj;
    this.tampon = '';
  }

  besle(chunk) {
    this.tampon += chunk.toString('utf8');
    // Ayrıştırılamayan çöp akış tamponu sonsuz büyümesin (256 KB tavan)
    if (this.tampon.length > 256 * 1024) {
      this.tampon = '';
      return;
    }
    while (this.tampon.length > 0) {
      // 1. Netstring formatı: <uzunluk>:<json>,
      const ikiNokta = this.tampon.indexOf(':');
      if (ikiNokta !== -1) {
        const lenStr = this.tampon.slice(0, ikiNokta).trim();
        const len = parseInt(lenStr, 10);
        if (!isNaN(len) && len > 0 && len < 100000) {
          if (this.tampon.length >= ikiNokta + 1 + len + 1) {
            const veri = this.tampon.slice(ikiNokta + 1, ikiNokta + 1 + len);
            this.tampon = this.tampon.slice(ikiNokta + 1 + len + 1);
            try {
              this.onMesaj(JSON.parse(veri));
            } catch {}
            continue;
          } else {
            break; // paketin kalan kısmı henüz gelmedi
          }
        }
      }

      // 2. Satır bazlı / düz JSON formatı
      const satirSonu = this.tampon.indexOf('\n');
      if (satirSonu !== -1) {
        const satir = this.tampon.slice(0, satirSonu).trim();
        this.tampon = this.tampon.slice(satirSonu + 1);
        if (satir.startsWith('{') && satir.endsWith('}')) {
          try {
            this.onMesaj(JSON.parse(satir));
          } catch {}
        }
        continue;
      }
      break;
    }
  }
}

/** 8000Hz 16-bit Mono PCM -> 44 byte standart WAV sarmalayici */
export function pcmToWav(pcm, sampleRate = 8000, channels = 1) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** RMS Enerji hesaplama (VAD icin) */
export function hesaplaRMS(pcm) {
  if (pcm.length < 2) return 0;
  let toplam = 0;
  const ornekSayisi = Math.floor(pcm.length / 2);
  for (let i = 0; i < pcm.length; i += 2) {
    const val = pcm.readInt16LE(i);
    toplam += val * val;
  }
  return Math.sqrt(toplam / ornekSayisi);
}

const FFMPEG_KOMUTU = fs.existsSync('/data/data/com.termux/files/usr/bin/ffmpeg')
  ? '/data/data/com.termux/files/usr/bin/ffmpeg'
  : 'ffmpeg';

/** Herhangi bir ses buffer'ini (MP3/WAV) ffmpeg ile 8000Hz 16-bit Mono RAW PCM'e donusturur */
export function pcmyeDonustur(sesBuffer) {
  return new Promise((coz, reddet) => {
    const ff = spawn(FFMPEG_KOMUTU, [
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ar', '8000',
      '-ac', '1',
      'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'ignore'] });

    const parcalar = [];
    ff.stdout.on('data', (d) => parcalar.push(d));
    ff.on('close', (kod) => {
      if (kod === 0) coz(Buffer.concat(parcalar));
      else reddet(new Error(`ffmpeg dönüştürme hatası: kod ${kod}`));
    });
    ff.on('error', reddet);
    ff.stdin.end(sesBuffer);
  });
}

export class SipKoprusu {
  constructor({ llm, gorevler, ayar, log, port = 4444, host = '127.0.0.1', fifoDizini = BASE_TMP, sesKapisiYolu = path.join(ASISTAN_HOME, 'run', 'ses-kanali-ok'), yazmaHatasiKurtarmaMs = 5000 }) {
    this.llm = llm;
    this.gorevler = gorevler;
    this.ayar = ayar;
    this.log = log;
    this.port = port;
    this.host = host;
    this.sipServer = process.env.SIP_SERVER || 'pbx.zadarma.com';
    this.soket = null;
    this.aktifGorusme = null;
    this.calanSesPcm = null;
    this.calanSesKonumu = 0;
    this.sesCalmaDurduruldu = false;
    this._acilisCaliniyor = false;
    this.besleyiciZamanlayici = null;
    this.inFifoFd = null;
    this.outFifoFd = null;
    this.outFifoStream = null;
    this.cagriAktif = false;
    // Ses gidiş hattı (mic.raw) sağlığı: besleyici sayaçları + kanal gözcüsü
    this.inFifoYolu = `${fifoDizini}/mic.raw`;
    this.outFifoYolu = `${fifoDizini}/spk.raw`;
    this.sesKapisiYolu = sesKapisiYolu;
    this.yazmaHatasiKurtarmaMs = yazmaHatasiKurtarmaMs;
    this.besleyiciBasariliSayac = 0;   // son sıfırlamadan beri başarıyla yazılan paket
    this.besleyiciHataSayaci = 0;      // toplam yazma hatası (sessizce YUTULMAZ)
    this._yazmaHatasiBaslangic = null; // aralıksız yazma hatasının başladığı an
    this._sesKanaliOlusuLoglandi = false;
    this.sesKanaliDurumu = 'dogrulanmadi'; // dogrulanmadi | saglam | olu
    this.sesKanalGozcusu = null;
    this.spkKeeperFd = null;
    this._fifoKilitleriniAc();
  }

  _fifoKilitleriniAc() {
    try {
      if (this.inFifoFd == null && fs.existsSync(this.inFifoYolu)) {
        this.inFifoFd = fs.openSync(this.inFifoYolu, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
      }
    } catch (e) {
      this.log?.uyari?.(`inFifo açılamadı: ${e.message}`);
    }
    try {
      if (this.spkKeeperFd == null && fs.existsSync(this.outFifoYolu)) {
        this.spkKeeperFd = fs.openSync(this.outFifoYolu, fs.constants.O_RDWR);
      }
      if (this.outFifoFd == null && fs.existsSync(this.outFifoYolu)) {
        this.outFifoFd = fs.openSync(this.outFifoYolu, fs.constants.O_RDWR);
      }
    } catch (e) {
      this.log?.uyari?.(`outFifo açılamadı: ${e.message}`);
    }
  }

  /** mic.raw fd'sini kapatıp yoldan yeniden açar (kendi kendine iyileştirme).
   *  Sebep: baresip-kur.sh FIFO'ları yeniden yarattığında beyin eski (deleted) inode'a
   *  yapışık kalabilir; ya da boru ucu bir noktada ölmüş olabilir. */
  _micFdYenidenAc(sebep = '') {
    if (this.inFifoFd != null) {
      try { fs.closeSync(this.inFifoFd); } catch {}
      this.inFifoFd = null;
    }
    try {
      if (fs.existsSync(this.inFifoYolu)) {
        this.inFifoFd = fs.openSync(this.inFifoYolu, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
        this.log?.bilgi?.(`mic.raw fd yoldan yeniden açıldı${sebep ? ` (${sebep})` : ''}`);
        return true;
      }
      this.log?.hata?.(`mic.raw yeniden açılamadı: yol yok (${this.inFifoYolu})`);
    } catch (e) {
      this.log?.hata?.(`mic.raw yeniden açılamadı: ${e.message}`);
    }
    return false;
  }

  /** spk.raw fd'sini ve ReadStream'ini kapatıp yoldan yeniden açar.
   *  Node.js ReadStream yok edildiğinde fd'yi de kapattığından sonraki aramada
   *  EBADF almamak ve Baresip ALSA yazma hattının (Broken pipe) kopmaması için
   *  her çağrıda ve hata anında spk.raw temizden yeniden açılır. */
  _spkFdYenidenAc(sebep = '') {
    if (this.outFifoStream) {
      try { this.outFifoStream.destroy(); } catch {}
      this.outFifoStream = null;
      this.outFifoFd = null;
    } else if (this.outFifoFd != null) {
      try { fs.closeSync(this.outFifoFd); } catch {}
      this.outFifoFd = null;
    }
    try {
      if (fs.existsSync(this.outFifoYolu)) {
        this.outFifoFd = fs.openSync(this.outFifoYolu, fs.constants.O_RDWR);
        this.log?.bilgi?.(`spk.raw fd yoldan yeniden açıldı${sebep ? ` (${sebep})` : ''}`);
        return true;
      }
      this.log?.hata?.(`spk.raw yeniden açılamadı: yol yok (${this.outFifoYolu})`);
    } catch (e) {
      this.log?.hata?.(`spk.raw yeniden açılamadı: ${e.message}`);
    }
    return false;
  }

  /** Arama kapısı: ses testi yeşil (scripts/termux/ses-testi.sh) olmadan arama ÇALDIRILMAZ.
   *  SES_KANALI_KAPISI=0 ortam değişkeni kapıyı tamamen açar (acil bypass). */
  _sesKapisiAcikMi() {
    if (process.env.SES_KANALI_KAPISI === '0') return true;
    try { return fs.existsSync(this.sesKapisiYolu); } catch { return false; }
  }

  _baglan() {
    return new Promise((coz, reddet) => {
      const s = net.connect(this.port, this.host, () => {
        this.log.bilgi(`Baresip ctrl_tcp bağlandı (${this.host}:${this.port})`);
        coz(s);
      });
      s.on('error', (err) => {
        this.log?.uyari?.(`Baresip ctrl_tcp bağlantı hatası: ${err.message}`);
        reddet(err);
      });
    });
  }

  formatlaNumara(num) {
    if (String(num || '').includes('@')) return String(num);
    let n = String(num || '').replace(/\D+/g, '');
    if (n.startsWith('00')) n = n.slice(2);
    if (n.startsWith('0') && n.length === 11) return '90' + n.slice(1);
    if (n.length === 10) return '90' + n;
    return n;
  }

  /** Baresip mikrofon girişine (mic.raw) kesintisiz, duvar saatine kilitli S16LE PCM basan besleyici.
   *  Yazma hataları sessizce YUTULMAZ: sayar, loglar ve 5 sn sürerse fd'yi kapatıp yoldan
   *  yeniden açar (kendi kendine iyileştirme). Başarı sayacı kanal gözcüsüne beslenir. */
  _sesBesleyiciBaslat() {
    if (this.inFifoFd == null) {
      this._fifoKilitleriniAc();
    }
    if (this.inFifoFd == null) {
      this.log.uyari(`mic.raw açılamadı: kilit yok`);
      return;
    }

    const sessizPaket = Buffer.alloc(320); // 20ms @ 8000Hz 16-bit mono = 320 byte
    let baslangicZamani = Date.now();
    let gonderilenPaketSayisi = 0;
    this._besleyiciZamaniniSifirla = () => {
      baslangicZamani = Date.now();
      gonderilenPaketSayisi = 0;
      this._yazmaHatasiBaslangic = null;
    };

    if (this.besleyiciZamanlayici) clearInterval(this.besleyiciZamanlayici);
    this.besleyiciZamanlayici = setInterval(() => {
      if (this.inFifoFd == null) return;
      const gecenMs = Date.now() - baslangicZamani;
      const olmasiGereken = Math.floor(gecenMs / 20);
      const fark = Math.min(5, Math.max(0, olmasiGereken - gonderilenPaketSayisi));
      if (fark <= 0) return;

      for (let i = 0; i < fark; i++) {
        let paket = sessizPaket;
        if (this.calanSesPcm && !this.sesCalmaDurduruldu) {
          const kalan = this.calanSesPcm.length - this.calanSesKonumu;
          if (kalan > 0) {
            const boy = Math.min(320, kalan);
            paket = this.calanSesPcm.slice(this.calanSesKonumu, this.calanSesKonumu + boy);
            this.calanSesKonumu += boy;
            if (boy < 320) {
              paket = Buffer.concat([paket, Buffer.alloc(320 - boy)]);
            }
          } else {
            this.calanSesPcm = null;
            this.calanSesKonumu = 0;
            this._acilisCaliniyor = false;
          }
        }
        try {
          const yazilan = fs.writeSync(this.inFifoFd, paket);
          if (yazilan === paket.length) {
            this.besleyiciBasariliSayac++;
            this._yazmaHatasiBaslangic = null;
            gonderilenPaketSayisi++;
          } else {
            // 320 bayt PIPE_BUF'tan küçük; kısmi yazım olmamalı — yine de say
            this.besleyiciBasariliSayac++;
            gonderilenPaketSayisi++;
          }
        } catch (hata) {
          if (hata.code === 'EAGAIN' && !this.cagriAktif) {
            // Çaldırma esnasında karşı taraf henüz açmadığından ALSA mikrofondan okumaz;
            // 64 KB boru dolunca gelen EAGAIN normaldir, hata sayılmaz
            break;
          }
          this.besleyiciHataSayaci++;
          const simdi = Date.now();
          if (this._yazmaHatasiBaslangic == null) this._yazmaHatasiBaslangic = simdi;
          if (this.besleyiciHataSayaci === 1 || this.besleyiciHataSayaci % 100 === 0) {
            this.log.uyari(`mic.raw yazma hatası: ${hata.code || hata.message} (toplam ${this.besleyiciHataSayaci})`);
          }
          // EAGAIN/aralıksız hata 5 sn sürerse: fd'yi kapatıp yoldan yeniden aç (kendi kendine iyileştirme)
          if (simdi - this._yazmaHatasiBaslangic >= this.yazmaHatasiKurtarmaMs) {
            const sureSn = Math.round((simdi - this._yazmaHatasiBaslangic) / 1000);
            this.log.uyari(`mic.raw yazma hatası ${sureSn} sn sürüyor (${hata.code || hata.message}) — fd kapatılıp yoldan yeniden açılıyor`);
            this._micFdYenidenAc(`yazma hatası ${sureSn} sn`);
            this._yazmaHatasiBaslangic = null;
            // Duvar saatini yeniden hizala: birikmiş gecikme yığını sesi hızlandırarak patlamasın
            baslangicZamani = Date.now();
            gonderilenPaketSayisi = 0;
            // Çağrı aktifken 5 sn boyunca tek bayt yazılamadıysa gidiş hattı ölüdür
            if (this.cagriAktif && !this._sesKanaliOlusuLoglandi) {
              this._sesKanaliOlusuLoglandi = true;
              this.sesKanaliDurumu = 'olu';
              this.log.hata('⚠️ SES KANALI ÖLÜ — kullanıcı ses duymayacak (mic.raw\'a 5 sn\'dir yazılamıyor)');
            }
          }
          break;
        }
      }
    }, 10);
  }

  /** Baresip hoparlör çıkışını (spk.raw) dinleyip VAD ve yankı kapısı ile karşı tarafın konuşmasını yakalar */
  _sesDinleyiciBaslat(gorusme, tasiyici) {
    this._spkFdYenidenAc('dinleyici başlatma');
    if (!this.outFifoFd) {
      this.log.uyari(`spk.raw dinleyici başlatılamadı: kilit yok`);
      return;
    }

    let konusmaParcalari = [];
    let sessizlikAdimSayisi = 0;
    let tabanGurultu = 100;
    let sonSttZamani = 0;
    let bargeInSayaci = 0;

    try {
      this.outFifoStream = fs.createReadStream(null, { fd: this.outFifoFd, autoClose: true, highWaterMark: 320 });
      this.outFifoStream.on('data', (chunk) => {
        // Yalnızca çağrı aktifken karşı tarafın sesini işle (çaldırma/ringback tonunu yok say)
        if (!this.cagriAktif) return;

        const rms = hesaplaRMS(chunk);
        const asistanKonusuyor = Boolean(this.calanSesPcm && !this.sesCalmaDurduruldu);

        // 1. YANKI KAPISI & BARGE-IN:
        // Açılış brifingi sırasında hat oturma çıtırtısı veya tekil gürültüler asistanı ASLA susturamaz.
        if (asistanKonusuyor) {
          konusmaParcalari = [];
          if (!this._acilisCaliniyor && rms > 2400) {
            bargeInSayaci++;
            if (bargeInSayaci >= 15) { // En az 300ms aralıksız yüksek ses
              this.log.bilgi(`[Barge-in] Karşı taraf söz kesti (RMS ${Math.round(rms)}), asistan susturuluyor`);
              bargeInSayaci = 0;
              tasiyici.sesDurdur();
            }
          } else {
            bargeInSayaci = 0;
          }
          return;
        }

        // Görüşme motoru yanıt hazırlıyorsa yeni kayıt alma
        if (gorusme.durum === 'dusunuyor') {
          konusmaParcalari = [];
          return;
        }

        // 2. ADAPTİF GÜRÜLTÜ TABANI:
        if (rms < 300) {
          tabanGurultu = tabanGurultu * 0.95 + rms * 0.05;
        }
        const dinamikEsik = Math.max(400, tabanGurultu * 2.5);

        // 3. VAD (Ses Aktivite Algılama):
        if (rms > dinamikEsik) {
          konusmaParcalari.push(chunk);
          sessizlikAdimSayisi = 0;
        } else if (konusmaParcalari.length > 0) {
          konusmaParcalari.push(chunk);
          sessizlikAdimSayisi++;
          // 40 x 20ms = ~800ms sessizlik -> karşı tarafın cümlesi bitti
          if (sessizlikAdimSayisi >= 40) {
            const pcmVeri = Buffer.concat(konusmaParcalari);
            konusmaParcalari = [];
            sessizlikAdimSayisi = 0;
            const simdi = Date.now();
            // En az 0.8 saniye (12800 bayt) ve iki STT isteği arasında en az 1.5s boşluk
            if (pcmVeri.length >= 12800 && simdi - sonSttZamani > 1500) {
              sonSttZamani = simdi;
              const wav = pcmToWav(pcmVeri);
              gorusme.sesGeldi(wav, 'audio/wav').catch((e) => this.log.hata(`STT hatası: ${e.message}`));
            }
          }
        }
      });
      this.outFifoStream.on('error', (e) => {
        this.log.uyari(`spk.raw okuma: ${e.message}`);
        if (e.code === 'EBADF') {
          this._spkFdYenidenAc('EBADF kurtarma');
        }
      });
    } catch (e) {
      this.log.uyari(`spk.raw dinleyici başlatılamadı: ${e.message}`);
    }
  }

  /** Kanal gözcüsü: CALL_ESTABLISHED'tan sonra 2 sn içinde besleyici 100 paket
   *  başarıyla yazamadıysa gidiş hattı ölüdür — kullanıcı hiçbir şey duymayacak.
   *  "konusuyor" durumu asla "duyuldu" diye rapORLANMAZ; gözcü "saglam" demedikçe
   *  sesin karşı tarafa ulaştığı bilinmez. */
  _sesKanalGozcusuBaslat() {
    clearTimeout(this.sesKanalGozcusu);
    this.besleyiciBasariliSayac = 0;
    this._sesKanaliOlusuLoglandi = false;
    this.sesKanalGozcusu = setTimeout(() => {
      if (!this.cagriAktif) return;
      const n = this.besleyiciBasariliSayac;
      if (n < 100) {
        this.sesKanaliDurumu = 'olu';
        this._sesKanaliOlusuLoglandi = true;
        this.log.hata(`⚠️ SES KANALI ÖLÜ — kullanıcı ses duymayacak (2 sn'de ${n}/100 paket yazıldı)`);
        this.log.uyari('Not: "konusuyor" durumu "duyuldu" anlamına DEĞİL — ses karşı tarafa gitmedi');
      } else {
        this.sesKanaliDurumu = 'saglam';
        this.log.bilgi(`✅ Ses gidiş hattı sağlam (2 sn'de ${n} paket yazıldı)`);
      }
    }, 2000);
  }

  async ara(secimler) {
    // Eşzamanlı arama kilidi: çağrı sürerken ikinci arama ilkini bozmasın (çift çaldırma!)
    if (this._aramaKilit) {
      throw Object.assign(new Error('Zaten aktif bir çağrı var — önce bitmesini bekleyin'), { kod: 409 });
    }
    this._aramaKilit = true;
    try {
      return await this._araIc(secimler);
    } catch (hata) {
      this._aramaKilit = false;
      throw hata;
    }
  }

  async _araIc({ gorev, numara }) {
    // ARAMA KAPISI: ses testi (scripts/termux/ses-testi.sh) yeşil olmadan kimse ÇALDIRILMAZ.
    if (!this._sesKapisiAcikMi()) {
      throw Object.assign(
        new Error('Ses kanalı doğrulanmadı — ses testi yeşil olana kadar arama kapalı. Önce `bash scripts/termux/ses-testi.sh` çalıştır (çaldırmadan kanıtlar). Acil bypass: SES_KANALI_KAPISI=0'),
        { kod: 423 },
      );
    }
    const hedefNumara = this.formatlaNumara(numara || gorev?.kisi?.numara);
    if (!hedefNumara) throw new Error('Geçersiz telefon numarası');

    this.log.bilgi(`VoIP dış arama başlatılıyor (Görev #${gorev?.id || 'serbest'}; numara günlüğe yazılmadı)`);

    const asistanAdi = this.ayar?.kullanici?.asistanAdi || 'Aspasia';
    const sahip = this.ayar?.kullanici?.ad ? `${this.ayar.kullanici.ad}'ın asistanı` : 'asistanınız';
    const acilis = gorev?.acilis || `Merhaba! Ben ${sahip} ${asistanAdi}, nasılsınız?`;

    // Açılış konuşmasını arama çevrilmeden ÖNCE seslendirip PCM'e dönüştür (sıfır gecikme)
    this._acilisPcm = null;
    if (this.llm && typeof this.llm.seslendir === 'function') {
      this.log.bilgi('Açılış konuşması önceden hazırlanıyor (metin günlüğe yazılmadı).');
      try {
        const buf = await this.llm.seslendir(acilis, gorev?.ses);
        this._acilisPcm = await pcmyeDonustur(buf);
        this.log.bilgi(`Açılış PCM sesi hazır (${this._acilisPcm.length} bayt)`);
      } catch (e) {
        this.log.uyari(`Açılış sesi önbellekleme hatası: ${e.message}`);
      }
    }

    const soket = await this._baglan();
    this.soket = soket;

    const komutGonder = (k) => {
      if (this.soket && !this.soket.destroyed) {
        this.soket.write(netstringKodla(k));
      }
    };

    const tasiyici = {
      metin: (rol) => {
        this.log.bilgi(`Görüşme metni alındı/gönderildi (rol: ${rol}; içerik günlüğe yazılmadı).`);
      },
      sesCal: async (buffer) => {
        try {
          if (this._acilisPcm && !this.calanSesPcm) {
            this.log.bilgi('Açılış PCM sesi önbellekten sıfır gecikmeyle yayına verildi');
            this.calanSesPcm = this._acilisPcm;
            this._acilisPcm = null;
            this.calanSesKonumu = 0;
            this.sesCalmaDurduruldu = false;
            this._acilisCaliniyor = true;
            return;
          }
          this.log.bilgi('TTS sesi dönüştürülüyor ve çalma kuyruğuna alınıyor...');
          const pcm = await pcmyeDonustur(buffer);
          this.calanSesPcm = pcm;
          this.calanSesKonumu = 0;
          this.sesCalmaDurduruldu = false;
          // Dürüst rapor: "konusuyor" ≠ "duyuldu". Ses ancak gözcü "saglam" dediyse gitmiştir.
          if (this.sesKanaliDurumu === 'olu') {
            this.log.uyari('TTS kuyruğa alındı AMA ses kanalı ölü — kullanıcı BUNU DUYMAYACAK ("konusuyor" ≠ "duyuldu")');
          } else if (this.sesKanaliDurumu !== 'saglam') {
            this.log.uyari('TTS kuyruğa alındı; kullanıcıya ulaşıp ulaşmadığı henüz doğrulanmadı ("konusuyor" ≠ "duyuldu")');
          }
        } catch (e) {
          this.log.hata(`TTS çalma hatası: ${e.message}`);
        }
      },
      sesDurdur: () => {
        this.log.bilgi('Barge-in: Asistan sesi kesildi');
        this.sesCalmaDurduruldu = true;
        this.calanSesPcm = null;
        this.calanSesKonumu = 0;
      },
      durum: (d) => {
        this.log.bilgi(`Arama durumu: ${String(d?.asama || 'bilinmiyor')}${d?.sebep ? ` (${d.sebep})` : ''}`);
      },
      bitti: (g, ek) => {
        this.log.bilgi(`Arama tamamlandı: ${ek.sebep} (süre: ${ek.sure}s)`);
        komutGonder({ command: 'hangup' });
        this._temizle();
      }
    };

    const gorusme = new Gorusme({
      llm: this.llm,
      gorevler: this.gorevler,
      gorev,
      ayar: this.ayar,
      tasiyici,
      log: this.log,
      mod: 'sunucu-ses'
    });
    this.aktifGorusme = gorusme;

    let baslatildi = false;
    const gorusmeyiBaslat = (sebep) => {
      if (baslatildi) return;
      baslatildi = true;
      this.cagriAktif = true;
      this.log.bilgi(`📞 ÇAĞRI AKTİF (${sebep})! Aspasia söze başlıyor.`);
      this._besleyiciZamaniniSifirla?.();
      // Kanal gözcüsü: 2 sn içinde 100 paket yazılamazsa SES KANALI ÖLÜ diye bağır
      this._sesKanalGozcusuBaslat();
      gorusme.baslat().catch((e) => this.log.hata(`Görüşme başlatma: ${e.message}`));
    };

    // FIFO'ları Baresip açılışı için hemen hazır tut (besleyici sessiz paket basarak saati besler)
    this._micFdYenidenAc('arama başlangıcı');
    this._sesBesleyiciBaslat();
    this._sesDinleyiciBaslat(gorusme, tasiyici);

    // Baresip olaylarını dinle (Yalnızca çağrı açılınca söze başla)
    const ayristirici = new NetstringAyristirici((msg) => {
      const tip = msg.type || msg.event || 'bilinmiyor';
      this.log.bilgi(`[Baresip Olay] ${tip} (ayrıntılar gizli)`);
      if (tip === 'CALL_ESTABLISHED' || tip === 'CALL_ANSWERED') {
        gorusmeyiBaslat(`SIP ${tip}`);
      } else if (tip === 'CALL_INCOMING') {
        this.log.bilgi(`[Baresip] Gelen çağrı tespit edildi: ${msg.peeruri || ''} - otomatik yanıtlanıyor`);
        komutGonder({ command: 'accept' });
      } else if (tip === 'CALL_CLOSED') {
        this.log.bilgi('📴 ÇAĞRI SONLANDI (Karşı taraf veya santral kapattı).');
        gorusme.bitir('karsi-kapatti').catch(() => {});
        this._temizle();
      }
    });

    soket.on('data', (d) => {
      this.log.bilgi(`[Baresip Ham Çıktı] ${d.length} bayt alındı (içerik gizli).`);
      ayristirici.besle(d);
    });
    soket.on('close', () => this._temizle());
    soket.on('error', (e) => {
      this.log.uyari(`Baresip soket hatası: ${e.message}`);
      this._temizle();
    });

    // 45 saniye çağrı cevaplanma zaman aşımı (asılı kalma koruması)
    clearTimeout(this._cagriZamanAsimi);
    this._cagriZamanAsimi = setTimeout(() => {
      if (!this.cagriAktif) {
        this.log.uyari('45 saniye içinde çağrı açılmadı veya bağlantı kurulamadı — kilit ve oturum temizleniyor.');
        gorusme.bitir('cevap-yok').catch(() => {});
        komutGonder({ command: 'hangup' });
        this._temizle();
      }
    }, 45000);

    // Aramayı çevir (Baresip UA eşleşmesi için domain içeren tam SIP URI formatı kullanılır)
    const dialParam = hedefNumara.includes('@')
      ? (hedefNumara.startsWith('sip:') ? hedefNumara : `sip:${hedefNumara}`)
      : `sip:${hedefNumara}@${this.sipServer}`;
    this.log.bilgi('Baresip arama komutu gönderiliyor (hedef numara günlüğe yazılmadı).');
    komutGonder({ command: 'dial', params: dialParam });
    // Dürüst rapor: "çevrildi" ≠ "duyuldu". Ses kanalı gözcüsü sonucu ayrıca loglar.
    return {
      basarili: true,
      numara: hedefNumara,
      sesKanali: this.sesKanaliDurumu,
      not: 'Çağrı çevrildi; sesin kullanıcıya ulaştığı henüz doğrulanmadı — "duyuldu" diye raporlamayın. Gözcü sonucu loglara yazar (⚠️ SES KANALI ÖLÜ / ✅ Ses gidiş hattı sağlam).',
    };
  }

  _temizle() {
    this.cagriAktif = false;
    this._aramaKilit = false;
    clearTimeout(this._cagriZamanAsimi);
    this._cagriZamanAsimi = null;
    clearTimeout(this.sesKanalGozcusu);
    this.sesKanalGozcusu = null;
    this.sesKanaliDurumu = 'dogrulanmadi';
    this._sesKanaliOlusuLoglandi = false;
    if (this.besleyiciZamanlayici) {
      clearInterval(this.besleyiciZamanlayici);
      this.besleyiciZamanlayici = null;
    }
    if (this.outFifoStream) {
      try { this.outFifoStream.destroy(); } catch {}
      this.outFifoStream = null;
      this.outFifoFd = null;
    } else if (this.outFifoFd != null) {
      try { fs.closeSync(this.outFifoFd); } catch {}
      this.outFifoFd = null;
    }
    if (this.soket) {
      try { this.soket.destroy(); } catch {}
      this.soket = null;
    }
    this.calanSesPcm = null;
    this._acilisPcm = null;
    this._acilisCaliniyor = false;
    this.sesCalmaDurduruldu = true;
    this.aktifGorusme = null;
  }
}
