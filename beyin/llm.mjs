// 9router, OpenRouter, Groq ve Edge-TTS istemcisi: sohbet, STT, TTS.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Telemetri } from '../ortak/telemetri.mjs';

export function guvenliUrlGorunumu(adres) {
  try {
    const url = new URL(adres);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '(geçersiz URL)';
  }
}

function yerel9routerMi(adres) {
  try {
    const url = new URL(adres);
    const localhost = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
    return url.protocol === 'http:' && localhost && url.port === '20128' && url.pathname.replace(/\/+$/, '') === '/v1';
  } catch {
    return false;
  }
}

export class LLMHatasi extends Error {
  constructor(mesaj, { durum, govde } = {}) {
    super(mesaj);
    this.durum = durum;
    Object.defineProperty(this, 'govde', { value: govde, enumerable: false });
  }
}

export class LLMIstemci {
  constructor({
    baseUrl,
    apiKey,
    model,
    sicaklik = 0.4,
    sttModel = 'whisper-large-v3-turbo',
    ttsModel = 'tts-1',
    ttsVoice = 'tr-TR-EmelNeural',
    ttsSaglayici,
    elevenlabsApiKey,
    elevenlabsVoiceId,
    elevenlabsModel,
    fishAudioApiKey,
    fishAudioVoiceId,
    zamanAsimi = 120_000,
    openrouterApiKey,
    groqApiKey,
    cerebrasApiKey,
    telemetry,
  } = {}) {
    this.openrouterApiKey = openrouterApiKey || process.env.OPENROUTER_API_KEY || '';
    this.groqApiKey = groqApiKey || process.env.GROQ_API_KEY || '';
    this.cerebrasApiKey = cerebrasApiKey || process.env.CEREBRAS_API_KEY || '';
    this.elevenlabsApiKey = elevenlabsApiKey || process.env.ELEVENLABS_API_KEY || '';
    this.elevenlabsVoiceId = elevenlabsVoiceId || process.env.ELEVENLABS_VOICE_ID || 'cgSgspJ2msm6clMCkdW9';
    this.elevenlabsModel = elevenlabsModel || process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
    this.fishAudioApiKey = fishAudioApiKey || process.env.FISH_AUDIO_API_KEY || '';
    this.fishAudioVoiceId = fishAudioVoiceId || process.env.FISH_AUDIO_VOICE_ID || '';
    this.ttsSaglayici = ttsSaglayici || process.env.TTS_SAGLAYICI || '';

    this.apiKey = apiKey || process.env.LLM_API_KEY || this.openrouterApiKey || '';
    this.baseUrl = (baseUrl || process.env.LLM_BASE_URL || (this.apiKey.startsWith('sk-or-') ? 'https://openrouter.ai/api/v1' : 'http://127.0.0.1:20128/v1')).replace(/\/+$/, '');
    if (process.env.ENABLE_9ROUTER !== '0' && !yerel9routerMi(this.baseUrl)) {
      throw new LLMHatasi(`Doğrudan/uzak LLM endpoint'i için ENABLE_9ROUTER=0 açıkça ayarlanmalı (${guvenliUrlGorunumu(this.baseUrl)})`);
    }
    this.model = model || process.env.LLM_MODEL || (this.apiKey.startsWith('sk-or-') ? 'meta-llama/llama-3.3-70b-instruct' : '');
    this.sicaklik = sicaklik;
    this.sttModel = sttModel || process.env.STT_MODEL || 'whisper-large-v3-turbo';
    this.ttsModel = ttsModel || process.env.TTS_MODEL || 'tts-1';
    this.ttsVoice = ttsVoice || process.env.TTS_VOICE || 'tr-TR-EmelNeural';
    this.zamanAsimi = zamanAsimi;
    this.telemetri = telemetry || new Telemetri();
    this.piperModel = process.env.PIPER_MODEL || '';
    this.piperBin = process.env.PIPER_BIN || 'piper';
    this.promptUSDPer1K = Number(process.env.LLM_PROMPT_USD_PER_1K || 0);
    this.completionUSDPer1K = Number(process.env.LLM_COMPLETION_USD_PER_1K || 0);
    this._ttsOnbellek = new Map();
  }

  _basliklar(ek = {}) {
    const b = { ...ek };
    if (this.apiKey) b.Authorization = `Bearer ${this.apiKey}`;
    if (this.baseUrl.includes('openrouter.ai')) {
      b['HTTP-Referer'] = 'https://github.com/AppleCurse/asistanim-cebimde';
      b['X-Title'] = 'Asistanim Cebimde';
    }
    return b;
  }

  async _istek(yol, secenekler = {}) {
    let yanit;
    try {
      yanit = await fetch(this.baseUrl + yol, { ...secenekler, headers: this._basliklar(secenekler.headers), signal: AbortSignal.timeout(this.zamanAsimi) });
    } catch (hata) {
      const kod = hata?.cause?.code || hata?.code;
      throw new LLMHatasi(`LLM ulaşılamadı (${guvenliUrlGorunumu(this.baseUrl)})${kod ? ` [${kod}]` : ''}`);
    }
    if (!yanit.ok) {
      const govde = await yanit.text().catch(() => '');
      throw new LLMHatasi(`LLM isteği başarısız (${yanit.status}) ${yol}`, { durum: yanit.status, govde });
    }
    return yanit;
  }

  async modeller() {
    const y = await this._istek('/models');
    const veri = await y.json();
    return (veri.data || []).map((m) => m.id);
  }

  /** Model belirtilmemişse listeden makul bir tane seçer. */
  async modelSagla() {
    if (this.model) return this.model;
    if (this.baseUrl.includes('openrouter.ai')) {
      this.model = 'meta-llama/llama-3.3-70b-instruct';
      return this.model;
    }
    try {
      const liste = await this.modeller();
      if (liste.length) {
        const tercih = liste.find((m) => /llama-3\.3|sonnet|gpt-4|gemini|kimi|deepseek/i.test(m)) || liste[0];
        this.model = tercih;
        return tercih;
      }
    } catch {
      // 9router yanıt vermezse
    }
    if (this.openrouterApiKey && process.env.ENABLE_9ROUTER === '0') {
      this.model = 'meta-llama/llama-3.3-70b-instruct';
      return this.model;
    }
    throw new LLMHatasi('Kullanılabilir LLM modeli bulunamadı — panelden bir sağlayıcı bağlayın veya .env ayarlayın');
  }

  /**
   * OpenAI chat/completions. `mesajlar` OpenAI biçiminde; `araclar` function-calling tanımları.
   * Dönen değer: { mesaj, kullanim, model }
   */
  async sohbet(mesajlar, { araclar, model, sicaklik, maksToken } = {}) {
    let modelAdi = model || (await this.modelSagla());
    // Görsel varsa ve model metin-only ise Gemini Vision modeline geç
    const resimVar = mesajlar.some((m) =>
      Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url')
    );
    if (resimVar && !/gemini|gpt-4o|claude-3|vision/i.test(modelAdi)) {
      modelAdi = 'google/gemini-2.5-flash-lite';
    }
    const govde = {
      model: modelAdi,
      messages: mesajlar,
      temperature: sicaklik ?? this.sicaklik,
    };
    if (araclar?.length) {
      govde.tools = araclar;
      govde.tool_choice = 'auto';
    }
    govde.max_tokens = maksToken || 350;
    if (/gpt-oss|o1|o3/i.test(modelAdi)) {
      govde.reasoning_effort = 'low';
    }

    let yanit;
    const dogrudanSaglayiciAcik = process.env.ENABLE_9ROUTER === '0';
    try {
      yanit = await this._istek('/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(govde),
      });
    } catch (hata) {
      const affordMatch = String(hata.govde || hata.message || '').match(/can only afford (\d+)/i);
      if (affordMatch && dogrudanSaglayiciAcik && this.groqApiKey && !this.baseUrl.includes('groq.com')) {
        console.log('[LLM] OpenRouter kredi kısıtı tespit edildi, Groq yedeğine geçiliyor (llama-3.3-70b-versatile)');
        const yedekIstemci = new LLMIstemci({
          baseUrl: 'https://api.groq.com/openai/v1',
          apiKey: this.groqApiKey,
          model: 'llama-3.3-70b-versatile',
          sicaklik: this.sicaklik,
          groqApiKey: this.groqApiKey,
          elevenlabsApiKey: this.elevenlabsApiKey,
          elevenlabsVoiceId: this.elevenlabsVoiceId,
          elevenlabsModel: this.elevenlabsModel,
          ttsSaglayici: this.ttsSaglayici,
          telemetry: this.telemetri,
        });
        return yedekIstemci.sohbet(mesajlar, { araclar, model: 'llama-3.3-70b-versatile', sicaklik, maksToken });
      } else if (affordMatch && Number(affordMatch[1]) >= 50 && (!maksToken || maksToken > Number(affordMatch[1]))) {
        const yeniLimit = Math.max(50, Number(affordMatch[1]) - 10);
        console.log(`[LLM] Kredi kısıtı nedeniyle max_tokens ${yeniLimit} olarak ayarlanıp tekrar deneniyor...`);
        govde.max_tokens = yeniLimit;
        yanit = await this._istek('/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(govde),
        });
      } else if (dogrudanSaglayiciAcik && this.groqApiKey && !this.baseUrl.includes('groq.com')) {
        console.log('[LLM] Sağlayıcı hatası, Groq yedeğine geçiliyor (llama-3.3-70b-versatile)');
        const yedekIstemci = new LLMIstemci({
          baseUrl: 'https://api.groq.com/openai/v1',
          apiKey: this.groqApiKey,
          model: 'llama-3.3-70b-versatile',
          sicaklik: this.sicaklik,
          groqApiKey: this.groqApiKey,
          elevenlabsApiKey: this.elevenlabsApiKey,
          elevenlabsVoiceId: this.elevenlabsVoiceId,
          elevenlabsModel: this.elevenlabsModel,
          ttsSaglayici: this.ttsSaglayici,
          telemetry: this.telemetri,
        });
        return yedekIstemci.sohbet(mesajlar, { araclar, model: 'llama-3.3-70b-versatile', sicaklik, maksToken });
      } else if (dogrudanSaglayiciAcik && this.openrouterApiKey && !this.baseUrl.includes('openrouter.ai')) {
        console.log('[LLM] 9router başarısız, OpenRouter yedeğine geçiliyor (meta-llama/llama-3.3-70b-instruct)');
        const yedekIstemci = new LLMIstemci({
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: this.openrouterApiKey,
          model: 'meta-llama/llama-3.3-70b-instruct',
          sicaklik: this.sicaklik,
        });
        return yedekIstemci.sohbet(mesajlar, { araclar, model: 'meta-llama/llama-3.3-70b-instruct', sicaklik, maksToken });
      } else {
        throw hata;
      }
    }

    const veri = await yanit.json();
    const secim = veri.choices?.[0];
    if (!secim?.message) throw new LLMHatasi('LLM boş yanıt döndürdü', { govde: JSON.stringify(veri).slice(0, 400) });
    const kullanim = veri.usage;
    this.telemetri?.yaz('llm', {
      model: veri.model || govde.model,
      prompt: kullanim?.prompt_tokens || 0,
      completion: kullanim?.completion_tokens || 0,
      token: (kullanim?.prompt_tokens || 0) + (kullanim?.completion_tokens || 0),
      maliyetTL: (((kullanim?.prompt_tokens || 0) / 1000) * this.promptUSDPer1K + ((kullanim?.completion_tokens || 0) / 1000) * this.completionUSDPer1K) * 35,
    });
    return { mesaj: secim.message, kullanim, model: veri.model || govde.model, bitis: secim.finish_reason };
  }

  /** Metin isteyip JSON bekleyen çağrılar için toleranslı ayrıştırıcı. */
  async jsonSohbet(mesajlar, secenekler = {}) {
    const { mesaj } = await this.sohbet(mesajlar, { ...secenekler, sicaklik: secenekler.sicaklik ?? 0.2 });
    return jsonAyikla(mesaj.content);
  }

  /** Ses → metin. `ses` Buffer; `mime` örn. audio/webm, audio/mp4, audio/wav */
  async yaziyaCevir(ses, { mime = 'audio/wav', dil = 'tr', model, dosyaAdi } = {}) {
    const groqKey = process.env.ENABLE_9ROUTER === '0'
      ? (this.groqApiKey || (this.apiKey.startsWith('gsk_') ? this.apiKey : ''))
      : '';
    if (groqKey) {
      try {
        const form = new FormData();
        const uzanti = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg' }[mime.split(';')[0]] || 'wav';
        form.append('file', new Blob([ses], { type: mime }), dosyaAdi || `ses.${uzanti}`);
        form.append('model', 'whisper-large-v3-turbo');
        if (dil) form.append('language', dil);
        form.append('response_format', 'json');

        const y = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${groqKey}` },
          body: form,
          signal: AbortSignal.timeout(this.zamanAsimi),
        });
        if (y.ok) {
          const veri = await y.json();
          return (veri.text || '').trim();
        }
      } catch (hata) {
        // Groq başarısızsa aşağıda 9router'ı dene — ama sessizce yutma, logla
        console.log(`[LLM] Groq STT başarısız (${hata.message}) — 9router deneniyor`);
      }
    }

    const form = new FormData();
    const uzanti = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg' }[mime.split(';')[0]] || 'bin';
    form.append('file', new Blob([ses], { type: mime }), dosyaAdi || `ses.${uzanti}`);
    form.append('model', model || this.sttModel);
    if (dil) form.append('language', dil);
    form.append('response_format', 'json');
    const y = await this._istek('/audio/transcriptions', { method: 'POST', body: form });
    const veri = await y.json();
    return (veri.text || '').trim();
  }

  /** Metin → ses (Buffer). İkinci argüman seçenek nesnesi ya da doğrudan ses kimliği (string) olabilir;
   *  görüşme motoru `gorev.ses`'i düz metin olarak geçirir — eskiden bu sessizce yok sayılıyordu. */
  async seslendir(metin, secenek = {}) {
    const { model, ses, format = 'mp3' } = typeof secenek === 'string' ? { ses: secenek } : (secenek || {});
    if (!metin || !metin.trim()) return Buffer.alloc(0);
    const sesSecimi = ses || this.ttsVoice || 'tr-TR-EmelNeural';
    const onbellekAnahtari = `${metin.trim()}|${model || ''}|${sesSecimi}|${format}`;
    if (this._ttsOnbellek?.has(onbellekAnahtari)) {
      return this._ttsOnbellek.get(onbellekAnahtari);
    }
    const onbellekleVeDon = (buf) => {
      if (buf && buf.length > 0 && this._ttsOnbellek) {
        if (this._ttsOnbellek.size > 30) {
          const ilk = this._ttsOnbellek.keys().next().value;
          this._ttsOnbellek.delete(ilk);
        }
        this._ttsOnbellek.set(onbellekAnahtari, buf);
      }
      return buf;
    };

    // 0. Fish Audio: ultra ucuz, yüksek kaliteli sıfır atışlı ses klonlama
    const fishAudioSecili = this.ttsSaglayici === 'fish_audio' || (this.fishAudioApiKey && this.ttsSaglayici !== 'elevenlabs' && !this.piperModel && this.ttsSaglayici !== 'edge-tts' && this.ttsSaglayici !== '9router');
    if (this.fishAudioApiKey && fishAudioSecili) {
      const refId = ses || this.fishAudioVoiceId;
      try {
        const govde = {
          text: metin,
          format: format || 'mp3',
        };
        if (refId) govde.reference_id = refId;
        const y = await fetch('https://api.fish.audio/v1/tts', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.fishAudioApiKey}`,
            'Content-Type': 'application/json',
            'model': 's2.1-pro-free',
          },
          body: JSON.stringify(govde),
          signal: AbortSignal.timeout(Math.min(this.zamanAsimi, 30_000)),
        });
        if (!y.ok) throw new Error(`Fish Audio HTTP ${y.status}`);
        const sesBuffer = Buffer.from(await y.arrayBuffer());
        if (sesBuffer && sesBuffer.length > 0) {
          this.telemetri?.yaz('tts', { motor: 'fish_audio', karakter: metin.length });
          return onbellekleVeDon(sesBuffer);
        }
      } catch (hata) {
        console.log(`[TTS] Fish Audio başarısız (${hata.message}) — yedek motora geçiliyor`);
      }
    }

    // 1. ElevenLabs: yüksek kaliteli doğal ses (öncelikli TTS veya anahtar tanımlıysa)
    const elevenlabsSecili = this.ttsSaglayici === 'elevenlabs' || (this.elevenlabsApiKey && !this.piperModel && this.ttsSaglayici !== 'edge-tts' && this.ttsSaglayici !== '9router');
    if (this.elevenlabsApiKey && elevenlabsSecili) {
      const sesId = ses || this.elevenlabsVoiceId || 'cgSgspJ2msm6clMCkdW9';
      try {
        const y = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${sesId}`, {
          method: 'POST',
          headers: {
            'xi-api-key': this.elevenlabsApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: metin,
            model_id: model || this.elevenlabsModel || 'eleven_multilingual_v2',
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
            },
          }),
          signal: AbortSignal.timeout(Math.min(this.zamanAsimi, 30_000)),
        });
        if (!y.ok) throw new Error(`ElevenLabs HTTP ${y.status}`);
        const sesBuffer = Buffer.from(await y.arrayBuffer());
        if (sesBuffer && sesBuffer.length > 0) {
          this.telemetri?.yaz('tts', { motor: 'elevenlabs', karakter: metin.length });
          return onbellekleVeDon(sesBuffer);
        }
      } catch (hata) {
        console.log(`[TTS] ElevenLabs başarısız (${hata.message}) — yedek motora geçiliyor`);
      }
    }

    // 2. Piper: tamamen cihaz içinde, ağsız ve düşük gecikmeli Türkçe TTS.
    // PIPER_MODEL bir .onnx dosyasını göstermelidir; model depoya gömülmez.
    if (this.piperModel) {
      const cikti = path.join(os.tmpdir(), `asistan-piper-${process.pid}-${Date.now()}.wav`);
      try {
        await new Promise((resolve, reject) => {
          const p = spawn(this.piperBin, ['--model', this.piperModel, '--output_file', cikti], { stdio: ['pipe', 'ignore', 'pipe'] });
          let hata = '';
          p.stderr.on('data', (d) => { hata += d; });
          p.on('error', reject);
          p.on('close', (kod) => kod === 0 ? resolve() : reject(new Error(hata || `piper çıkış kodu ${kod}`)));
          p.stdin.end(metin);
        });
        const sesBuffer = fs.readFileSync(cikti);
        fs.rmSync(cikti, { force: true });
        if (sesBuffer.length) { this.telemetri?.yaz('tts', { motor: 'piper', karakter: metin.length }); return onbellekleVeDon(sesBuffer); }
      } catch { fs.rmSync(cikti, { force: true }); }
    }

    // 3. Termux / sistemde edge-tts varsa doğrudan kullan (ücretsiz, doğal Türkçe, ultra hızlı)
    try {
      const sesBuffer = await new Promise((resolve, reject) => {
        const p = spawn('edge-tts', ['--voice', sesSecimi, '--text', metin, '--write-media', '-'], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const parcalar = [];
        p.stdout.on('data', (d) => parcalar.push(d));
        p.on('close', (kod) => {
          if (kod === 0 && parcalar.length > 0) resolve(Buffer.concat(parcalar));
          else reject(new Error(`edge-tts çıkış kodu: ${kod}`));
        });
        p.on('error', reject);
      });
      if (sesBuffer && sesBuffer.length > 0) {
        this.telemetri?.yaz('tts', { motor: 'edge-tts', karakter: metin.length });
        return onbellekleVeDon(sesBuffer);
      }
    } catch {
      // edge-tts kurulu değilse veya hata verirse fallback
    }

    // 4. 9router / OpenAI seslendirme ucu
    const y = await this._istek('/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model || this.ttsModel, input: metin, voice: sesSecimi, response_format: format }),
    });
    this.telemetri?.yaz('tts', { motor: '9router', karakter: metin.length });
    return onbellekleVeDon(Buffer.from(await y.arrayBuffer()));
  }
}

/** Yanıtın içinden ilk JSON nesnesini çıkarır (```json çitleri, açıklama metni vb. tolere edilir). */
export function jsonAyikla(metin) {
  if (!metin) throw new LLMHatasi('JSON bekleniyordu, boş içerik geldi');
  const temiz = String(metin).replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(temiz);
  } catch {
    /* aşağıda dene */
  }
  const bas = temiz.indexOf('{');
  const son = temiz.lastIndexOf('}');
  if (bas >= 0 && son > bas) {
    try {
      return JSON.parse(temiz.slice(bas, son + 1));
    } catch {
      /* düş */
    }
  }
  throw new LLMHatasi(`JSON ayrıştırılamadı: ${temiz.slice(0, 200)}`);
}
