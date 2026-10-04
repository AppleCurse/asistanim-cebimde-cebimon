# Kurulum — Eski telefonu canlandırma

Tasarım hedefi: Xiaomi Redmi Note 8 (Android 9–11 / MIUI 12.x, root yok). Gerçek cihaz kurulumu bu checkout'ta doğrulanmamıştır; diğer Android'lerde izin, Termux:API ve arka plan davranışı değişebilir.

## 0. Telefonu hazırla

1. **Termux'u F-Droid'den kur** (Play Store sürümü eski ve bakımsız). Aynı kaynaktan: **Termux:API**, **Termux:Boot** (isteğe bağlı: Termux:Widget).
2. **Android OS izinleri:** Termux ve Termux:API için yalnızca kullanacağın donanım/işlevlere izin ver (ör. kamera veya mikrofon). Android izinleri, uygulamadaki ayrı `config.json` yetenek kapılarını açmaz: telefon/SMS/konum/kişiler/kabuk varsayılan kapalıdır ve bunları kullanmak için ayrıca bilinçli yapılandırma gerekir.
3. **MIUI pil yönetimi:** Ayarlar → Uygulamalar → Termux → Pil tasarrufu → **Kısıtlama yok**; **Otomatik başlat** → aç. Aynısını Termux:API ve Termux:Boot için yap. Ayarlar → Pil → "Uygulamaları arka planda kilitle" listesine Termux'u ekle (son uygulamalar ekranında kilit simgesi).
4. **Geliştirici seçenekleri** (Ayarlar → Telefon hakkında → MIUI sürümüne 7 kez dokun): "MIUI optimizasyonu"nu kapatmak agresif süreç öldürmeyi azaltır (isteğe bağlı). "Ekran açıkken uyanık kal" şarjda faydalı.
5. **Genişletilmiş RAM** seçeneği cihaz/ROM'da varsa isteğe bağlı olarak açılabilir; 4+1 GB, Redmi tasarım hedefindeki örnektir, gereksinim ya da doğrulanmış performans sonucu değildir.
6. Telefon sürekli şarjda duracaksa pili %60–80 bandında tutan akıllı priz/zamanlayıcı ömrü uzatır; MIUI'nin şarj sınırı yok. Isınmayı azaltmak için ekran parlaklığını en düşüğe çek, ekranı kapalı tut.

## 1. Termux kurulumu

Termux'ta tek satır (sürüm paketini indirir ve `kur.sh`'ı çalıştırır):

```bash
curl -fsSL https://github.com/AppleCurse/asistanim-cebimde/releases/latest/download/indir-kur.sh | bash -s -- --tls
```

Zip ile: sürümler sayfasından `.zip`'i indir → `termux-setup-storage` → `unzip -o ~/storage/downloads/asistanim-cebimde-v*.zip -d ~/` → `bash ~/asistanim-cebimde/scripts/termux/kur.sh --tls`.
Git ile (geliştirme): `pkg install -y git && git clone https://github.com/AppleCurse/asistanim-cebimde ~/asistanim-cebimde && bash ~/asistanim-cebimde/scripts/termux/kur.sh --tls`

Güncelleme: aynı tek satırı tekrar çalıştır (`~/.asistan` ve `.env` korunur).

`kur.sh` şunları yapar: `pkg` güncelleme; `nodejs-lts termux-api openssh ffmpeg jq zbar openssl-tool util-linux` kurulumu; `npm install`; `npm i -g 9router`; `~/.asistan` + tokenlar; `.env` kopyası; `--tls` ile HTTPS sertifikası; `--proot` ile Ubuntu + 9remote.

İlk kamera/mikrofon komutlarında Android izin pencereleri açılır — **izin ver**.

Doğrulama:

```bash
termux-battery-status          # JSON dönmeli
termux-camera-info             # kameraları listelemeli
termux-tts-speak "merhaba"     # konuşmalı
termux-speech-to-text          # bir şey söyle → yazıya çevirmeli (Google uygulaması gerekir)
```

`termux-speech-to-text` boş dönüyorsa: Google uygulaması / "Speech Services by Google" kurulu ve Türkçe çevrimdışı paket indirilmiş olmalı (Ayarlar → Sistem → Diller → Konuşma).

## 2. 9router: beyni bağla

```bash
bash scripts/termux/9router-servis.sh      # 9router'ı güvenli ilk parolayla ön planda başlatır
```

Sunucu çalışırken telefondaki tarayıcıda `http://localhost:20128` adresini aç → **Providers** → ücretsiz bir sağlayıcı bağla (OpenCode Free kayıtsız çalışır; Kiro, Vertex kredisi vb.) ya da kendi OpenAI/Anthropic/Gemini anahtarını gir. **Dashboard → API key**'i kopyala. Başlangıç parolası ilk çalıştırmada `0600` izinli dosyaya kaydedilir; başka bir Termux oturumunda `cat ~/.asistan/9router.initial-password` ile görüntüle (özelleştirilmiş `ASISTAN_HOME` varsa `.env`'yi kaynaklayıp o dizindeki dosyayı oku). Bu ön plan testi bittiğinde yönetilen arka plan başlatması için aşağıdaki `.env` ayarlarını yapıp `baslat.sh` kullan.

Görüşme motoru ve asistan ses çıkışı için sağlayıcılar (isteğe bağlı):
- **ElevenLabs (Ultra kaliteli doğal ses):** `TTS_SAGLAYICI=elevenlabs`, `ELEVENLABS_API_KEY=sk_...` ve `ELEVENLABS_VOICE_ID=cgSgspJ2msm6clMCkdW9` (Jessica).
- **Piper (Yerel & çevrimdışı):** `TTS_SAGLAYICI=piper`, `PIPER_MODEL=.../model.onnx` (ağsız ve düşük gecikmeli).
- **Edge-TTS (Ücretsiz & doğal):** `TTS_SAGLAYICI=edge-tts`, `TTS_VOICE=tr-TR-EmelNeural` (Termux'ta `edge-tts` paketiyle).
- **9router / Android:** `TTS_SAGLAYICI=9router` veya `TTS_SAGLAYICI=android` (Termux API TTS).
- Varsayılan STT `9router` üzerinden çalışır. Doğrudan Groq STT için `STT_SAGLAYICI=groq`, `GROQ_API_KEY` ve `ENABLE_9ROUTER=0` gerekir. Bu genel anahtar `baslat.sh`'ın 9router'ı başlatmasını da kapatır; sohbet için ayrıca `LLM_BASE_URL` ve uygun LLM anahtarını doğrudan sağlayıcıya göre yapılandır.

`~/asistanim-cebimde/.env`:

```env
LLM_BASE_URL=http://127.0.0.1:20128/v1
LLM_API_KEY=9r-...............
LLM_MODEL=kr/claude-sonnet-4.5     # 9router panelindeki model adı; boş bırakırsan ilk uygun model seçilir
KULLANICI_ADI="Adın Soyadın"        # tırnaklı; asistan aramalarda "X'in dijital asistanı" der
ASISTAN_ADI=Aspasia
```

Varsayılan `.env.example`, yerel 9router adresi ve `ENABLE_9ROUTER=1` kullanır; `baslat.sh` bu durumda router'ı başlatır. Doğrudan/uzak sağlayıcı için `LLM_BASE_URL` ve ilgili anahtarı açıkça yapılandırıp `.env` içinde `ENABLE_9ROUTER=0` ayarla. `1` ile uzak endpoint verilirse betik hata vererek durur.

İlk kez `baslat.sh` ile başlatılan 9router için başlangıç parolası rastgele üretilir ve `~/.asistan/9router.initial-password` dosyasına `0600` izinle kaydedilir; görüntülemek için `cat ~/.asistan/9router.initial-password` çalıştır. İsteğe bağlı `.env` değişkeni `INITIAL_PASSWORD`, yalnızca bu parola dosyası oluşturulurken kullanılır. Önceden kurulmuş 9router hesabının parolasını bu işlem değiştirmez.

Model listesi: `npm run modeller`

## 3. Başlat

```bash
bash ~/asistanim-cebimde/scripts/termux/baslat.sh
```

Çıktıda `Yerel Panel: https://192.168.x.y:20131/` satırını cebindeki telefonda aç (aynı Wi-Fi). Giriş anahtarı için Termux'ta `cat ~/.asistan/beyin.token` çalıştır ve giriş ekranına gir; anahtarı URL'ye ekleme. Tarayıcı "güvenli değil" derse (kendinden imzalı sertifika) **Gelişmiş → Devam et** — bir kez. Uyumlu tarayıcıda **⬇ Kur** veya menüde **Ana ekrana ekle** ile tam ekran mobil uygulama (PWA) olarak kullanabilirsin.

### Sıfır Terminal Mobil Yönetim Kokpiti
Panel açıldığında 4 temel sekme üzerinden tüm sistemi yönetebilirsin:
1. **💬 Kokpit (Asistan & Hızlı Arama):** Bas-konuş mikrofonla Türkçe sesli komut ver; **Hızlı Arama** kartından numarayı ve kullanılacak sesi seçerek tek dokunuşla VoIP santralinden arama başlat.
2. **🎭 Sesler (Ses Stüdyosu & Klonlar):** Fish Audio klon sesler (Haluk Bilginer `66f55da63a4a47b982ae64723dd79194`, Sedat Peker `4fef01e5df334bb0b1a039750058b760`) ve doğal sesleri tarayıcıda ön dinle (`🔊 Dinle`), tek tıkla varsayılan yap veya yeni özel ses ID'si ekle.
3. **⚙️ Ayarlar & API Merkezi:** LLM API anahtarlarını, Fish Audio anahtarını ve Zadarma SIP santral kullanıcı adı/şifresini formdan yapıştırıp kaydet. Terminalde `.env` düzenleme zorunluluğu yoktur; ayarlar anında uygulanır.
4. **📊 Durum & Geçmiş:** Beden, 9router, SIP, pil durumu, arama transkriptleri ve kalıcı hafızayı izle.

Terminalden deneme: `npm run sohbet` → `pil kaç?`, `etrafa bak`, `"test" de`.

Yönetim:

```bash
bash scripts/termux/durum.sh     # kim yaşıyor, panel adresi
bash scripts/termux/durdur.sh    # hepsini durdur
tail -f ~/.asistan/log/beyin.log # loglar
```

## 4. Açılışta otomatik kalksın

```bash
bash ~/asistanim-cebimde/scripts/termux/boot-kur.sh
```

Termux:Boot uygulamasını **bir kez aç** (Android kancayı kaydetsin). Kurulu hook yeniden başlatmada 15 sn bekleyip servisleri başlatmayı dener ve `~/.asistan/log/boot.log` dosyasına yazar; gerçek cihazda açılış davranışı henüz doğrulanmadı.

## 5. Uzaktan erişim (evden çıkınca)

En temiz yol **Tailscale**: eski telefona ve cebindekine Tailscale uygulamasını kur, aynı hesapla gir. Panel: `https://100.x.y.z:20131/` — port açma, DDNS yok. İlk girişte `~/.asistan/beyin.token` anahtarını gir; URL'ye ekleme. Sertifikayı Tailscale IP'siyle yenile: `TAILSCALE_IP=100.x.y.z bash scripts/termux/tls-uret.sh` ve beyni yeniden başlat.

Alternatif: 9remote'un "Zero-Config Localhost Preview" özelliği (HTTP sayfaları çalışır; WebSocket'li yazılım telefonu için Tailscale önerilir).

**Sabit alan adıyla Cloudflare Tunnel (isteğe bağlı):** Cloudflare Zero Trust'ta named tunnel ve public hostname oluştur; hostname'i panelin yerel origin'ine (`https://localhost:20131` veya TLS yoksa `http://localhost:20131`) yönlendir. Self-signed TLS kullanıyorsan origin TLS doğrulamasını Cloudflare tunnel yapılandırmasında kapat. Dış HTTPS'i tünel sonlandırıyorsa `.env` içinde `COOKIE_SECURE=1` ayarla. `.env` içine `CLOUDFLARED_TUNNEL_TOKEN` ve `CLOUDFLARED_PUBLIC_URL` yaz; Proot Ubuntu içinde Linux ARM64 `cloudflared` binary'si bulunmalı (`$HOME/cloudflared` konumundan kopyalanır). Termux `baslat.sh` named tunnel'ı token-file ile başlatır. Gizli `.env` dosyası kurulumda `0600` izin alır. Named tunnel yapılandırılmadıysa mevcut quick tunnel geçici URL verir; yeniden başladığında değişmesi beklenir.

## 6. Mikrofon ve HTTPS

Tarayıcılar mikrofonu ve konuşma tanımayı yalnızca **güvenli bağlamda** (HTTPS veya localhost) açar. Seçenekler:

- `scripts/termux/tls-uret.sh` (kur.sh `--tls`) → beyin HTTPS ile kalkar; ilk açılışta uyarıyı geç.
- Chrome'da `chrome://flags/#unsafely-treat-insecure-origin-as-secure` → `http://192.168.x.y:20131` ekle → HTTP ile de mikrofon açılır.
- Tailscale + HTTPS sertifikası (yukarıdaki gibi).

**Görev tahtası** adımlarını kamera/mikrofonla doğrulamak için de tarayıcı izinleri gerekir. Kullanıcıdan her kayıt öncesi tarayıcı izin ister; 5 saniyelik kayıt ve bir kare, STT/LLM incelemesi için yapılandırılmış sağlayıcıya gönderilir. Hassas belgeleri kadraja almadan önce kontrol et. Medya dosyaları kaydedilmez; konuşma transkripti ve değerlendirme notu kalıcı görev oturumunda tutulur. Yüksek riskli adım panelde ayrıca kullanıcı onayı olmadan ilerlemez.

Yazılım telefonunda **"Tarayıcı sesi"** modu Android Chrome'da en iyi çalışır. Yerleşik konuşma tanıması bulunmayan iOS/Brave tarayıcılarında HTTPS ve mikrofon izni varsa kayıt düğmesi MediaRecorder ile kısa ses alıp yapılandırılmış STT sağlayıcısına gönderir; bu da kullanılamazsa yazıyla devam edebilirsin.

## 7. proot Ubuntu + 9remote (isteğe bağlı, "sinir sistemi")

```bash
bash scripts/proot/ubuntu-kur.sh          # Ubuntu + Node 22 + 9remote (≈ 10 dk)
bash scripts/proot/9remote.sh             # ilk eşleşme: QR'ı cebindeki telefonla okut → Approve
ENABLE_9REMOTE=1 bash scripts/termux/baslat.sh   # sonrasında arka planda
```

Depo `/root/asistanim-cebimde`, ayarlar `/root/.asistan` olarak içeriye bağlanır → 9remote'un IDE'sinden kodu düzenleyip Claude Code/Codex'i (9router'a bağlı) çalıştırabilirsin. Proot içinden `localhost:20128` ve `:20130` aynı şekilde erişilebilir.

## Sorun giderme

| Belirti | Sebep / çözüm |
|---|---|
| `Beden: ulasilamiyor` | `bash scripts/termux/durum.sh`; `~/.asistan/log/beden.log`. Port çakışması → `.env` `BEDEN_PORT`. |
| Beden `mock` modunda | Termux:API paketi (`pkg install termux-api`) veya uygulaması yok. `termux-battery-status` çalışmalı. |
| `LLM hazır değil` | 9router çalışmıyor; normal kullanımda `bash scripts/termux/baslat.sh`, ön planlı tanılama için `bash scripts/termux/9router-servis.sh` çalıştır. `LLM_API_KEY` yanlış veya sağlayıcı bağlı değilse `curl -H "Authorization: Bearer $LLM_API_KEY" http://127.0.0.1:20128/v1/models` ile kontrol et. |
| Kamera 30 sn sonra hata | Başka uygulama kamerayı tutuyor; MIUI izinlerini kontrol et; ekran kilitliyken bazı ROM'lar kamerayı vermez → ekranı kilitsiz, karartılmış tut. |
| `termux-microphone-record` boş dosya | Mikrofon izni; arama sırasında mikrofon telefon uygulamasında kilitlidir (bkz. telefon-gorusmesi.md). |
| VoIP'ta karşı taraf ses duymuyor / arama açılmıyor | `bash scripts/termux/ses-testi.sh` (çaldırmadan 3 adımlık kanıt). Kırmızıysa arama kapısı kapalıdır; betik `.asoundrc`/FIFO/besleyici reçetesini basar. Log: `grep -iE 'mic.raw\|SES KANALI' ~/.asistan/log/beyin.log` |
| Servisler geceleri ölüyor | MIUI pil kısıtı / otomatik başlat kapalı; `termux-wake-lock` bildirimi görünmeli; Android 12+ ROM'larda phantom process killer → `adb shell device_config put activity_manager max_phantom_processes 2147483647`. |
| Panelde mikrofon izni yok | HTTPS değil → §6. |
| 9remote `sharp` / `koffi` hatası | Termux'ta değil proot'ta çalıştır (`scripts/proot/9remote.sh`). |
| `node-machine-id` hatası (proot) | `/etc/machine-id` yok → `icerde-kur.sh` üretir; elle: `tr -d '-' < /proc/sys/kernel/random/uuid > /etc/machine-id` |
