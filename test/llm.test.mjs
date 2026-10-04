import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LLMIstemci, guvenliUrlGorunumu } from '../beyin/llm.mjs';

test('URL durum/günlük gösterimi kimlik bilgisi ve query sırlarını temizler', () => {
  assert.equal(guvenliUrlGorunumu('https://kullanici:sifre@example.test/v1?token=secret#parca'), 'https://example.test/v1');
});

test('LLMIstemci: ElevenLabs yapılandırması varsayılanları doğru yükler', () => {
  const istemci = new LLMIstemci({
    elevenlabsApiKey: 'test-key-123',
    ttsSaglayici: 'elevenlabs',
  });
  assert.equal(istemci.elevenlabsApiKey, 'test-key-123');
  assert.equal(istemci.elevenlabsVoiceId, 'cgSgspJ2msm6clMCkdW9');
  assert.equal(istemci.elevenlabsModel, 'eleven_multilingual_v2');
  assert.equal(istemci.ttsSaglayici, 'elevenlabs');
});

test('LLMIstemci.seslendir: boş metinde boş Buffer döner', async () => {
  const istemci = new LLMIstemci();
  const res = await istemci.seslendir('   ');
  assert.equal(res.length, 0);
});

test('LLMIstemci.seslendir: ElevenLabs yapılandırıldığında doğru API çağrısı yapar ve ses döner', async () => {
  const orijinalFetch = globalThis.fetch;
  let cagrilanUrl = '';
  let cagrilanSecenekler = null;

  globalThis.fetch = async (url, options) => {
    cagrilanUrl = String(url);
    cagrilanSecenekler = options;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode('sahte-elevenlabs-mp3').buffer,
    };
  };

  const telemetriKayitlari = [];
  const sahteTelemetri = { yaz: (tur, veri) => telemetriKayitlari.push({ tur, veri }) };

  try {
    const istemci = new LLMIstemci({
      elevenlabsApiKey: 'el-key-xyz',
      elevenlabsVoiceId: 'test-ses-id',
      ttsSaglayici: 'elevenlabs',
      telemetry: sahteTelemetri,
    });

    const sesBuffer = await istemci.seslendir('Merhaba dünya');
    assert.equal(sesBuffer.toString(), 'sahte-elevenlabs-mp3');
    assert.equal(cagrilanUrl, 'https://api.elevenlabs.io/v1/text-to-speech/test-ses-id');
    assert.equal(cagrilanSecenekler.headers['xi-api-key'], 'el-key-xyz');
    assert.equal(cagrilanSecenekler.headers['Content-Type'], 'application/json');

    const govde = JSON.parse(cagrilanSecenekler.body);
    assert.equal(govde.text, 'Merhaba dünya');
    assert.equal(govde.model_id, 'eleven_multilingual_v2');

    const ttsLog = telemetriKayitlari.find((k) => k.tur === 'tts');
    assert.ok(ttsLog);
    assert.equal(ttsLog.veri.motor, 'elevenlabs');
    assert.equal(ttsLog.veri.karakter, 13);
  } finally {
    globalThis.fetch = orijinalFetch;
  }
});

test('LLMIstemci.seslendir: aynı metin ikinci kez çağrıldığında önbellekten anında döner', async () => {
  const orijinalFetch = globalThis.fetch;
  let cagriSayisi = 0;

  globalThis.fetch = async () => {
    cagriSayisi++;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode('onbellek-mp3').buffer,
    };
  };

  const sahteTelemetri = { yaz: () => {} };

  try {
    const istemci = new LLMIstemci({
      elevenlabsApiKey: 'el-key-cache',
      ttsSaglayici: 'elevenlabs',
      telemetry: sahteTelemetri,
    });

    const res1 = await istemci.seslendir('Aynı ses metni');
    const res2 = await istemci.seslendir('Aynı ses metni');
    assert.equal(res1.toString(), 'onbellek-mp3');
    assert.equal(res2.toString(), 'onbellek-mp3');
    assert.equal(cagriSayisi, 1, 'ikinci çağrıda ağ isteği yapılmamalı, önbellekten dönmeli');
  } finally {
    globalThis.fetch = orijinalFetch;
  }
});

test('LLMIstemci.seslendir: ElevenLabs başarısız olduğunda yedek motora düşer', async () => {
  const orijinalFetch = globalThis.fetch;
  let elevenlabsCagrildi = false;
  let speechCagrildi = false;

  globalThis.fetch = async (url, options) => {
    const s = String(url);
    if (s.includes('elevenlabs.io')) {
      elevenlabsCagrildi = true;
      return {
        ok: false,
        status: 402,
        text: async () => 'paid_plan_required',
      };
    }
    if (s.includes('/audio/speech')) {
      speechCagrildi = true;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode('yedek-mp3').buffer,
      };
    }
    return { ok: false, status: 404 };
  };

  try {
    const istemci = new LLMIstemci({
      baseUrl: 'http://127.0.0.1:20128/v1',
      apiKey: 'sahte',
      elevenlabsApiKey: 'el-key-hata',
      ttsSaglayici: 'elevenlabs',
    });

    const sesBuffer = await istemci.seslendir('Hata testi');
    assert.ok(elevenlabsCagrildi, 'ElevenLabs çağrılmış olmalı');
    assert.ok(sesBuffer && sesBuffer.length > 0, 'Yedek motordan (edge-tts veya 9router) ses üretilmiş olmalı');
    if (speechCagrildi) {
      assert.equal(sesBuffer.toString(), 'yedek-mp3');
    }
  } finally {
    globalThis.fetch = orijinalFetch;
  }
});

test('LLMIstemci.seslendir: ikinci argüman string ise ses kimliği olarak kullanılır (gorev.ses)', async () => {
  const orijinalFetch = globalThis.fetch;
  let govde = null;
  globalThis.fetch = async (url, options) => {
    govde = JSON.parse(options.body);
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('x').buffer };
  };
  try {
    const istemci = new LLMIstemci({ fishAudioApiKey: 'k', fishAudioVoiceId: 'varsayilan', ttsSaglayici: 'fish_audio' });
    await istemci.seslendir('Görev sesi testi', 'gorev-sesi-789');
    assert.equal(govde.reference_id, 'gorev-sesi-789');
  } finally {
    globalThis.fetch = orijinalFetch;
  }
});

test('LLMIstemci.seslendir: Fish Audio yapılandırıldığında doğru API çağrısı yapar ve ses döner', async () => {
  const orijinalFetch = globalThis.fetch;
  let cagrilanUrl = '';
  let cagrilanSecenekler = null;

  globalThis.fetch = async (url, options) => {
    cagrilanUrl = String(url);
    cagrilanSecenekler = options;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode('sahte-fish-audio-mp3').buffer,
    };
  };

  const telemetriKayitlari = [];
  const sahteTelemetri = { yaz: (tur, veri) => telemetriKayitlari.push({ tur, veri }) };

  try {
    const istemci = new LLMIstemci({
      fishAudioApiKey: 'fish-key-123',
      fishAudioVoiceId: 'voice-ref-456',
      ttsSaglayici: 'fish_audio',
      telemetry: sahteTelemetri,
    });

    const sesBuffer = await istemci.seslendir('Fish audio testi');
    assert.equal(sesBuffer.toString(), 'sahte-fish-audio-mp3');
    assert.equal(cagrilanUrl, 'https://api.fish.audio/v1/tts');
    assert.equal(cagrilanSecenekler.headers['Authorization'], 'Bearer fish-key-123');
    assert.equal(cagrilanSecenekler.headers['Content-Type'], 'application/json');

    const govde = JSON.parse(cagrilanSecenekler.body);
    assert.equal(govde.text, 'Fish audio testi');
    assert.equal(govde.reference_id, 'voice-ref-456');

    const ttsLog = telemetriKayitlari.find((k) => k.tur === 'tts');
    assert.ok(ttsLog);
    assert.equal(ttsLog.veri.motor, 'fish_audio');
  } finally {
    globalThis.fetch = orijinalFetch;
  }
});

test('LLMIstemci: sağlayıcı hata gövdesi mesaj/log çıktısına eklenmez', async () => {
  const oncekiEnable = process.env.ENABLE_9ROUTER;
  const oncekiFetch = globalThis.fetch;
  try {
    process.env.ENABLE_9ROUTER = '0';
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'api-key-secret query-secret' });
    const istemci = new LLMIstemci({ baseUrl: 'https://provider.example/v1', apiKey: 'api-key-secret' });
    const hata = await istemci.modeller().catch((e) => e);
    assert.match(hata.message, /401/);
    assert.doesNotMatch(hata.message, /api-key-secret|query-secret/);
    assert.doesNotMatch(JSON.stringify(hata), /api-key-secret|query-secret/);
  } finally {
    globalThis.fetch = oncekiFetch;
    if (oncekiEnable === undefined) delete process.env.ENABLE_9ROUTER;
    else process.env.ENABLE_9ROUTER = oncekiEnable;
  }
});

test('LLMIstemci: doğrudan/uzak endpoint açık ENABLE_9ROUTER=0 olmadan reddedilir', () => {
  const onceki = process.env.ENABLE_9ROUTER;
  try {
    process.env.ENABLE_9ROUTER = '1';
    assert.throws(
      () => new LLMIstemci({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk-test' }),
      /ENABLE_9ROUTER=0/,
    );
    process.env.ENABLE_9ROUTER = '0';
    assert.doesNotThrow(() => new LLMIstemci({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk-test' }));
  } finally {
    if (onceki === undefined) delete process.env.ENABLE_9ROUTER;
    else process.env.ENABLE_9ROUTER = onceki;
  }
});

test('LLMIstemci: 9router etkin iken sohbet/STT yedekleri doğrudan sağlayıcıya çıkmaz', async () => {
  const oncekiEnable = process.env.ENABLE_9ROUTER;
  const oncekiFetch = globalThis.fetch;
  const cagrilar = [];
  try {
    process.env.ENABLE_9ROUTER = '1';
    globalThis.fetch = async (url) => {
      cagrilar.push(String(url));
      if (String(url).endsWith('/audio/transcriptions')) {
        return { ok: true, status: 200, json: async () => ({ text: 'test transkript' }) };
      }
      return { ok: false, status: 503, text: async () => 'test hata' };
    };

    const istemci = new LLMIstemci({
      baseUrl: 'http://127.0.0.1:20128/v1',
      apiKey: 'yerel-test',
      model: 'test-model',
      groqApiKey: 'gsk-test',
      openrouterApiKey: 'sk-or-test',
    });
    await assert.rejects(istemci.sohbet([{ role: 'user', content: 'test' }]), /503/);
    const metin = await istemci.yaziyaCevir(Buffer.from('sahte ses'), { mime: 'audio/wav' });
    assert.equal(metin, 'test transkript');
    assert.equal(cagrilar.length, 2);
    assert.deepEqual(cagrilar, [
      'http://127.0.0.1:20128/v1/chat/completions',
      'http://127.0.0.1:20128/v1/audio/transcriptions',
    ]);
  } finally {
    globalThis.fetch = oncekiFetch;
    if (oncekiEnable === undefined) delete process.env.ENABLE_9ROUTER;
    else process.env.ENABLE_9ROUTER = oncekiEnable;
  }
});
