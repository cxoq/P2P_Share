# NEON DROP

**Tarayıcıdan tarayıcıya, sunucusuz dosya ve metin transferi.**

NEON DROP, AirDrop benzeri bir WebRTC uygulamasıdır. Dosyalar ve mesajlar iki tarayıcı arasında **doğrudan** akar. Node.js sunucusu yalnızca WebRTC el sıkışmasını (offer / answer / ICE candidate) iletir; dosya baytlarını taşımaz, diske yazmaz ve depolamaz.

Arayüz koyu, neon vurgulu bir "cyberpunk" tasarım kullanır. Masaüstü ve mobil tarayıcılarda çalışır.

---

## Özellikler

- **Sıfır bulut:** dosya trafiği sunucudan geçmez; `RTCDataChannel` üzerinden P2P gider.
- **64 KB parçalı akış:** büyük dosyalar tarayıcı belleğine tamamen yüklenmeden gönderilir.
- **Akış kontrolü:** `bufferedAmount` tabanlı geri basınç (4 MB yüksek eşik, 512 KB düşük eşik) ile bellek şişmesi önlenir.
- **Çoklu cihaz:** aynı odada en fazla 8 cihaz (ortam değişkeniyle 2–20) mesh topolojisinde bağlanır.
- **Dosya + metin:** sürükle-bırak, dosya seçici, canlı ilerleme, anlık hız ve metin mesajları.
- **Kabul akışı:** alıcı her dosyayı kabul veya reddeder. Chromium tarayıcılarda dosya doğrudan diske yazılır (`File System Access API`).
- **Oda daveti:** 6 haneli oda kodu, kopyalanabilir bağlantı ve sunucuda üretilen QR kod.
- **Sinyalleşme dayanıklılığı:** WebSocket koparsa yeniden bağlanır; devam eden P2P aktarımı sinyal kesintisinden etkilenmez.
- **Ağ dayanıklılığı:** bağlantı kurulamazsa ICE restart, ardından tam yeniden kurulum (2 deneme) otomatik denenir; cihaz satırındaki yenile düğmesiyle manuel tekrar başlatılabilir.
- **Rota şeffaflığı:** her cihaz için "doğrudan P2P" veya "TURN üzerinden" etiketi, sunucu için STUN/TURN rozeti gösterilir.
- **Oturum devamı:** sekme yenilenirse `sessionStorage`'daki kimlikle aynı odaya dönülür; 15 saniyelik bekleme penceresinde peer kimliği korunur.
- **Güvenli varsayılanlar:** sıkı CSP, Origin doğrulaması, mesaj boyutu limitleri, oda kapasitesi, hız sınırı, XSS'e karşı `textContent` kullanımı.
- **Tek tık:** `run.bat` bağımlılıkları kurar, sunucuyu başlatır ve tarayıcıyı açar.
- **Test edilebilir çekirdek:** `public/protocol.js` parça/boyut/kimlik doğrulamasını saf fonksiyonlar olarak dışa açar; Node birim testleri ve gerçek tarayıcı E2E senaryoları birlikte çalışır.

---

## Nasıl çalışır?

```
                                WebSocket (yalnızca signaling)
 ┌──────────────┐  ────────────────────────────────────────  ┌──────────────┐
 │   Tarayıcı A │  ◄──── offer / answer / ICE candidate ────► │  Node.js     │
 │              │                                             │  server.js   │
 │              │  ◄───────────── oda kodu, peer listesi ──── │              │
 └──────┬───────┘                                             └──────┬───────┘
        │                                                            │
        │                  WebRTC (DTLS ile şifreli)                 │
        │  ═══════════════════════════════════════════════════════   │
        │         RTCDataChannel: 64 KB binary parçalar             │
 ┌──────▼───────┐                                             ┌──────▼───────┐
 │   Tarayıcı B │  ◄──────── dosya + metin doğrudan ─────────► │   Tarayıcı C │
 └──────────────┘                                             └──────────────┘
```

1. Bir kullanıcı oda oluşturur. Sunucu 6 haneli bir kod üretir.
2. Diğer cihaz kodu veya davet bağlantısını kullanarak katılır.
3. Sunucu mevcut peer listesini yeni cihaza verir. Yeni cihaz, mevcut cihazların her birine offer gönderir; mevcut cihazlar answer döner. Bu deterministik kural, WebRTC "offer glare" durumunu önler.
4. ICE adayları el değiştirir. NAT geçilebilirse doğrudan bağlantı kurulur; geçilemezse TURN gerekir.
5. DataChannel açılır. Dosya gönderen, dosyayı 64 KB parçalara ayırır ve kanal tamponu dolduğunda bekler. Alıcı, gelen parçaları diske veya belleğe yazar.
6. Transfer tamamlandığında alıcı `file-complete` onayı gönderir; gönderen taraf "Karşıya ulaştı" durumunu gösterir.

Sunucu; oda üyeliği, peer adları, SDP/ICE mesajları ve QR görseli dışında hiçbir veriyi işlemez. SDP/ICE mesajları yerel IP adreslerini içerebilir; bu WebRTC'nin doğal davranışıdır.

---

## Gereksinimler

- **Node.js 18.17+** (önerilen: Node 20 veya 22)
- npm
- Güncel bir tarayıcı:
  - Chrome / Edge 90+
  - Firefox 90+
  - Safari 15.4+ (masaüstü)
- İnternet üzerinden kullanım için **TURN sunucusu** önerilir (aşağıya bakın).

---

## Hızlı başlangıç (Windows)

1. **Node.js** kurulu değilse [nodejs.org](https://nodejs.org/) üzerinden LTS sürümünü kurun.
2. `run.bat` dosyasına çift tıklayın.

Betik:

- Node.js'i kontrol eder,
- `node_modules` yoksa `npm install` çalıştırır,
- sunucuyu `http://localhost:3000` üzerinde başlatır,
- tarayıcıyı otomatik açar.

### Terminalden

```bash
npm install
npm start
```

Tarayıcıda `http://localhost:3000` adresini açın.

Aynı bilgisayarda iki farklı tarayıcı sekmesi kullanarak transferi hızlıca test edebilirsiniz: bir sekmede oda oluşturun, diğerinde oda koduna katılın.

---

## Yerel ağda kullanım

1. Sunucuyu başlatın.
2. Sunucu konsolunda görünen `Ağ: http://192.168.x.x:3000` adresini diğer cihazın tarayıcısında açın.
3. Windows Güvenlik Duvarı sorarsa **Node.js için özel ağ erişimine izin verin**.
4. İlk cihazda oda oluşturun; diğer cihazda kodu girin veya QR'ı okutun.

Notlar:

- WebRTC veri kanalı çoğu tarayıcıda HTTP üzerinde de çalışır; ancak `showSaveFilePicker`, pano API'si ve bazı modern özellikler **güvenli bağlam** ister. Yerel ağda HTTPS kullanmak isterseniz bir reverse proxy (Caddy, Nginx) veya Cloudflare Tunnel kullanabilirsiniz.
- Aynı Wi-Fi ağındaki cihazlar genellikle TURN olmadan doğrudan bağlanır.
- Kurumsal ağlar, misafir Wi-Fi ağları ve bazı mobil operatörler peer-to-peer bağlantıyı engelleyebilir. Bu durumda TURN gerekir.

### Arkadaşınla internet üzerinden paylaşım — en kısa yol

1. Uygulamayı bir bulut sağlayıcısında yayınlayın (aşağıdaki Render adımları en hızlısıdır) veya `cloudflared tunnel --url http://localhost:3000` gibi bir tünelle kendi makinenizi geçici olarak açın.
2. Herkese açık HTTPS adresini arkadaşınıza gönderin. İki taraf da aynı adresi açmalıdır; tarayıcı WebSocket için otomatik olarak `wss://` kullanır.
3. Bir taraf **Oda oluştur**'a basar, 6 haneli kodu veya davet bağlantısını paylaşır. Diğer taraf kodu girer.
4. Bağlantı kurulunca cihaz satırında **Bağlı · doğrudan** yazar; dosya seçin veya metin yazın.
5. Bağlantı kurulamazsa önce **Yeniden bağlan** düğmesini deneyin. Hâlâ kurulmuyorsa TURN yapılandırın (`TURN_URLS` + `TURN_SECRET`); simetrik NAT arkasındaki mobil/kurumsal ağlarda bu genellikle zorunludur.

---

## İnternet üzerinde yayınlama

Sunucu, kalıcı bir Node.js süreci ve WebSocket bağlantısı gerektirir. Statik hosting veya klasik serverless fonksiyonlar bu uygulama için uygun değildir.

### Render

1. Depoyu GitHub'a gönderin.
2. **New → Web Service** seçin.
3. Build command: `npm ci` (depoda `package-lock.json` var)
4. Start command: `npm start`
5. Health check path: `/healthz`
6. Ortam değişkenleri: `TURN_URLS` + `TURN_SECRET` (önerilen; `TURN_TTL` isteğe bağlı) veya `TURN_URLS` + `TURN_USERNAME`/`TURN_CREDENTIAL`; ayrıca isteğe bağlı `MAX_ROOM_PEERS`, `MAX_CONNECTIONS`, `ALLOWED_ORIGINS`, `ICE_TRANSPORT_POLICY`.
7. Deploy sonrası Render HTTPS ve WSS'i otomatik sağlar. Uygulama, sayfa protokolüne göre `wss://` kullanır. `PORT` değişkenini Render verir; kod bunu okur.
8. Render'ın ücretsiz planı boşta uykuya geçer; uyku sırasında odalar bellekten silinir. Kalıcı odalar için ücretli plan veya her zaman açık bir VPS kullanın.

### Railway

1. Depoyu Railway'e bağlayın.
2. Build command: `npm ci`; Start command: `npm start`.
3. `PORT` değişkenini Railway otomatik verir; sunucu bunu okur ve dinlediği portu loglar.
4. TURN ve isteğe bağlı kapasite değişkenlerini ekleyin.
5. Health check: `/healthz`.

### Fly.io / Docker

```bash
docker build -t neon-drop .
docker run --rm -p 3000:3000 --env-file .env neon-drop
```

`Dockerfile`, `package-lock.json` ile `npm ci --omit=dev` çalıştırır, `node` kullanıcısına geçer ve `/healthz` sağlık kontrolü içerir. Docker kurulu bir makinede yukarıdaki iki komutla doğrulanabilir; bu depoda Docker bulunmadığı için imaj derlemesi otomatik olarak test edilmemiştir.

Fly.io'da:

```bash
fly launch --dockerfile Dockerfile
fly secrets set TURN_URLS="turn:turn.example.com:3478,turns:turn.example.com:5349?transport=tcp" TURN_SECRET="..." TURN_TTL="3600"
fly deploy
```

Fly'da makine sayısını `1` ve otomatik durdurmayı kapalı tutun (`fly scale count 1`, `fly machines update ... --autostop=false`); aksi hâlde boşta duran makine odaları kaybeder. `PORT=3000`, `HOST=0.0.0.0` varsayılanları Dockerfile ile uyumludur.

### Vercel hakkında

Bu proje uzun ömürlü WebSocket sunucusu ve sürekli çalışan Node.js süreci gerektirir. Vercel'in klasik serverless modeli buna uygun değildir. Arayüzü statik olarak yayınlayabilirsiniz; fakat signaling sunucusunu Render, Railway, Fly.io veya bir VPS üzerinde ayrıca çalıştırmanız ve uygulamadaki WebSocket adresini ona yönlendirmeniz gerekir. En kolay yol Render/Railway/Fly.io kullanmaktır.

### Ters proxy / HTTPS

Nginx veya Caddy kullanıyorsanız WebSocket upgrade başlıklarını iletin.

Caddy örneği:

```caddyfile
drop.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Nginx örneği:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
}
```

---

## TURN yapılandırması (önerilir)

STUN yalnızca cihazların genel adreslerini keşfetmesine yardımcı olur. Simetrik NAT veya katı güvenlik duvarı arkasındaki kullanıcılar için TURN sunucusu gerekir. TURN, şifreli WebRTC paketlerini iletir; içeriği okuyamaz, ancak trafik TURN sunucusundan geçer.

### coturn kurulumu (özet)

```bash
sudo apt install coturn
sudo systemctl enable --now coturn
```

`/etc/turnserver.conf` için önerilen (kısa ömürlü kimlik bilgileri) örnek:

```conf
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=UZUN_RASTGELE_SIR
realm=drop.example.com
external-ip=SUNUCU_PUBLIC_IP
min-port=49152
max-port=65535
stale-nonce=600
no-multicast-peers
no-cli
no-loopback-peers
```

Hazır bir örnek depoda: `deploy/coturn/turnserver.conf`. Kopyalayıp `CHANGE_ME` değerlerini doldurun. Statik kullanıcı/parola ile de çalışır (`user=neondrop:GUCLU-BIR-SIFRE`); ancak her tarayıcıya aynı parola gönderildiği için üretimde `use-auth-secret` tercih edin.

Güvenlik duvarında `3478/udp`, `3478/tcp`, `5349/tcp` ve `49152-65535/udp` portlarını açın. TLS kullanacaksanız `turns:` için sertifika ekleyin. `turns:` (TCP/443 veya 5349) UDP'yi engelleyen kurumsal ağlarda tek çıkış yoludur.

Sunucu tarafında TURN'ü etkinleştirmenin iki yolu vardır:

**Önerilen — kısa ömürlü kimlik bilgileri:** coturn'daki `static-auth-secret` ile aynı değeri `TURN_SECRET` olarak verin. Sunucu her `/api/config` isteğinde `<son-kullanma-zamanı>:neondrop` biçiminde bir kullanıcı adı ve HMAC-SHA1 imzası üretir; sır tarayıcıya hiç gitmez.

```env
TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
TURN_SECRET=UZUN_RASTGELE_SIR
TURN_TTL=3600
```

**Basit — statik kimlik bilgileri:**

```env
TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
TURN_USERNAME=neondrop
TURN_CREDENTIAL=GUCLU-BIR-SIFRE
```

Öncelik sırası: `ICE_SERVERS_JSON` > `TURN_SECRET` (dinamik) > `TURN_USERNAME`/`TURN_CREDENTIAL` (statik). `TURN_URLS` verilip hiçbir kimlik bilgisi verilmezse sunucu TURN'ü atlar ve başlangıçta bir kez uyarır.

Tamamen özel bir ICE listesi için:

```env
ICE_SERVERS_JSON=[{"urls":["stun:stun.l.google.com:19302"]},{"urls":["turn:turn.example.com:3478"],"username":"neondrop","credential":"GUCLU-BIR-SIFRE"}]
```

> **Üretim notu:** Statik TURN kullanıcı adı/parolası tarayıcıya gönderilir; herkese açık kurulumda kısa ömürlü kimlik bilgileri (`TURN_SECRET`) kullanın. TURN sunucusunu yalnızca gerekli portlarla ve güçlü bir parolayla yayınlayın.

### Ağlar arası doğrulama kontrol listesi

Bu depoda otomatik testler aynı makinede (loopback) çalışır. TURN/NAT davranışı bu ortamda **doğrulanmamıştır** (erişilebilir coturn sunucusu yok). Kendi ortamınızda şu adımları izleyin:

1. Sunucuyu TURN değişkenleriyle başlatın ve `/api/config` yanıtında `turn:` girdisinin göründüğünü doğrulayın.
2. İki cihazı **farklı ağlara** alın (ör. biri mobil hotspot, diğeri kurumsal Wi-Fi).
3. Oda kurun, katılın ve DevTools → `chrome://webrtc-internals` üzerinden seçilen ICE candidate çiftinin `relay` olduğunu kontrol edin.
4. Küçük bir metin, ardından 50 MB'lık bir dosya gönderin; her iki tarafta `complete` ve SHA-256 eşleşmesi görülmeli.
5. TURN sunucusunu kapatıp aynı senaryoyu deneyin; bağlantı kurulamıyorsa TURN gerçekten kullanılıyor demektir.
6. `turns:` (5349/TCP) yapılandırıldıysa sertifika zincirini ve saat kaymasını kontrol edin.

---

## Kullanım

1. Görünen adınızı yazın.
2. **Oda oluştur**'a basın veya 6 haneli koda katılın.
3. Oda ekranında:
   - **QR göster** ile davet QR'ını açın.
   - **Bağlantıyı kopyala** ile davet linkini paylaşın.
   - Cihaz listesinden hedefleri seçin. Yeni bağlanan cihazlar otomatik seçilir.
4. Dosyaları sürükleyip bırakın veya alana tıklayın. Her dosya için alıcı tarafta **Kabul et** / **Reddet** görünür.
5. İlerleme yüzdesi, aktarılan boyut ve anlık hız satır üzerinde canlı güncellenir.
6. Metin panelinden seçili cihazlara anlık not gönderebilirsiniz.

### Alıcı tarafında dosya nereye gider?

- **Chrome / Edge (güvenli bağlam):** kabul ettiğinizde kayıt konumu sorulur; dosya parçalar hâlinde doğrudan diske yazılır. Bellekte tam kopya tutulmaz.
- **Firefox / Safari / HTTP üzerinden erişim:** dosya, tarayıcı belleğinde birleştirilir. Tamamlandığında indirme otomatik başlatılır ve satırda **İndir** düğmesi kalır. Çok büyük dosyalarda tarayıcı belleği sınırı geçerli olabilir.

Her iki durumda da dosya sunucuya gitmez.

---

## Ortam değişkenleri

| Değişken | Varsayılan | Açıklama |
| --- | --- | --- |
| `PORT` | `3000` | HTTP/WebSocket portu |
| `HOST` | `0.0.0.0` | Dinlenecek arayüz |
| `MAX_ROOM_PEERS` | `8` | Oda başına azami cihaz (2–20) |
| `MAX_CONNECTIONS` | `500` | Sunucu genelinde eşzamanlı WebSocket sınırı (1–100000) |
| `ALLOWED_ORIGINS` | boş | Virgülle ayrılmış ek Origin'ler; aynı origin her zaman kabul edilir |
| `TURN_URLS` | boş | Virgülle ayrılmış TURN/TURNS adresleri |
| `TURN_USERNAME` | boş | Statik TURN kullanıcı adı |
| `TURN_CREDENTIAL` | boş | Statik TURN parolası |
| `TURN_SECRET` | boş | coturn `use-auth-secret` paylaşılan sırrı; ayarlanırsa kısa ömürlü kimlik bilgileri üretilir (statik kullanıcı/parolayı ezer) |
| `TURN_TTL` | `3600` | Kısa ömürlü TURN kimlik bilgisi ömrü, saniye (60–86400) |
| `ICE_TRANSPORT_POLICY` | `all` | `relay` yalnızca TURN üzerinden bağlanır (tanılama için) |
| `ICE_SERVERS_JSON` | boş | Tam `iceServers` JSON dizisi (diğer ICE ayarlarını ezer) |

Yerel geliştirmede `.env.example` dosyasını `.env` olarak kopyalayabilirsiniz. Sunucu `dotenv` ile `.env` dosyasını otomatik okur.

```bash
cp .env.example .env
npm start
```

---

## Güvenlik ve gizlilik

### Veri akışı

- **Dosyalar sunucuya yüklenmez.** Sunucuda dosya yazma kodu yoktur; yalnızca JSON signaling mesajları işlenir.
- DataChannel bağlantısı WebRTC tarafından **DTLS** ile şifrelenir. Anahtarlar tarayıcılar arasında müzakere edilir.
- Oda kodu bir erişim anahtarı gibidir. Kodu bilen herkes, kapasite sınırına kadar odaya katılabilir. Gizli işler için oda kodunu yalnızca güvendiğiniz kişilerle paylaşın.
- Sunucu; oda kodunu, görünen adları, SDP/ICE mesajlarını ve bağlantı meta verilerini görebilir. Dosya içeriğini veya metin mesajlarını göremez.
- TURN kullanılıyorsa paketler TURN sunucusundan geçer; uçtan uca DTLS şifrelemesi korunur.
- Kalıcı dosya, veritabanı veya oturum kaydı tutulmaz. Oda boşalınca bellekten silinir.
- WebSocket bağlantısı kopan bir peer, 15 saniyelik yeniden bağlanma süresi boyunca odada tutulur. Bu süre sonunda üyelik düşer.

### Sunucu sertleştirmeleri

- **CSP:** `default-src 'self'`; `connect-src` yalnızca isteğin kendi host'unu (`ws://host`, `wss://host`) içerir. Script başına nonce yoktur, inline script yoktur; `script-src 'self'`.
- **Başlıklar:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`, `Cross-Origin-Opener-Policy: same-origin`; HTTPS'te `Strict-Transport-Security`.
- **WebSocket Origin doğrulaması:** Tarayıcı `Origin` başlığı aynı host değilse upgrade **403** ile reddedilir. `Origin` göndermeyen araçlar (testler) kabul edilir; istenirse `ALLOWED_ORIGINS` ile ek origin eklenir.
- **Bağlantı sınırı:** `MAX_CONNECTIONS` aşılırsa upgrade **503** ile reddedilir.
- **Mesaj sınırları:** WebSocket çerçevesi 64 KB; DataChannel kontrol metni 64 KB; metin mesajı 20.000 karakter. Aşan mesajlar işlenmeden atılır.
- **SDP/ICE doğrulaması:** `signal.kind` yalnızca `offer`/`answer`/`candidate`; SDP `v=0` ile başlamalı ve boyut sınırını aşmamalı; hedef yalnızca aynı odadaki başka bir peer olabilir. Kendine/ulaşılamaz peer'a sinyal `PEER_UNAVAILABLE`, geçersiz sinyal `INVALID_SIGNAL` ile reddedilir. Bilinmeyen mesaj tipleri ve geçersiz odalar hata döner.
- **Hız sınırı:** 10 saniyelik pencerede 180'den fazla mesaj gönderen bağlantı `RATE_LIMIT` hatası alır.
- **Oda sızıntısı:** Boşalan odalar ve süresi dolan üyelikler bellekten silinir; QR uç noktası yalnızca aynı origin'e ait `http(s)` URL'lerini kabul eder (yabancı host → 400).
- **XSS:** Kullanıcı kaynaklı tüm metinler (`innerText`/`textContent`) ile yazılır; tek statik `innerHTML` kullanımı sabit bir SVG'dir. Dosya adı ve MIME sunucuya gitmeden istemcide temizlenir.
- **Büyük yük reddi:** 100 GB üzeri dosya ilanı, 256 KB üzeri parça, bildirilen boyutu aşan bayt ve geçersiz uzunluklar reddedilir; disk hatası sonraki yazımları durdurur.
- **Kod yolu:** Sunucu yalnızca `public/` altındaki bilinen statik dosyaları sunar; `/server.js`, `package.json` ve traversal denemeleri kaynak sızdırmaz.

### Bilinen sınırlar

> Bu proje kimlik doğrulaması içermez; oda kodu bilen herkes katılabilir. Genel internete açık, hassas veriler için kurumsal SSO/reverse-proxy kimlik doğrulaması ekleyin ve TURN'ü kısa ömürlü kimlik bilgileriyle yapılandırın. TLS sonlandırma reverse proxy'de yapılıyorsa HSTS yalnızca `X-Forwarded-Proto`/`req.secure` doğru iletildiğinde eklenir.

---

## Büyük dosyalar ve performans

- Gönderim parça boyutu: **65.536 bayt (64 KB)**; alıcı en fazla 256 KB'lık parçayı kabul eder.
- İlan edilebilecek azami dosya boyutu: **100 GB**. Metin mesajı 20.000 karakter, oda başına sohbet geçmişi 250 mesajla sınırlıdır.
- DataChannel sıralı ve güvenilir modda açılır.
- Gönderen, kanal tamponu 4 MB'ı aştığında bekler; 512 KB altına inince devam eder. Her parça `File.slice()` ile istek üzerine okunur; tüm dosya RAM'e alınmaz.
- Alıcı, disk yazımını sıraya koyar ve TRANSFER bitiminde dosyayı kapatır.
- Alıcı her dosya için `file-complete` onayı gönderene kadar gönderen sonraki dosyaya geçmez. Bu, eşzamanlı dosya akışlarının karışmasını önler.
- Aynı anda birden fazla peer'a gönderim yapılırsa her peer için ayrı kuyruk ve ayrı DataChannel kullanılır.
- Tarayıcı sekmesi arka plandayken zamanlayıcılar yavaşlayabilir; aktarım devam eder ancak hız göstergesi gecikebilir.

### Tarayıcı uyumluluğu

| Özellik | Chrome / Edge | Firefox | Safari |
| --- | --- | --- | --- |
| WebRTC DataChannel | ✅ | ✅ | ✅ |
| Doğrudan diske akış (`showSaveFilePicker`) | ✅ (HTTPS/localhost) | ❌ | ❌ |
| Bellekten indirme yedeği | ✅ | ✅ | ✅ |
| QR okuyucu | İşletim sistemi / kamera uygulaması | aynı | aynı |

### Safari ve mobil bilinen sınırlamalar

- **iOS/iPadOS Safari:** WebRTC DataChannel desteklenir; ancak `showSaveFilePicker` yoktur. Dosya bellekte birleştirilir ve indirme sayfası/sekmesi üzerinden kaydedilir. Çok büyük dosyalarda (yüzlerce MB) bellek sınırı nedeniyle sekme yeniden yüklenebilir.
- **Arka plan sürekliliği:** iOS, arka plana atılan sekmenin zamanlayıcılarını ve bazen DataChannel trafiğini askıya alır. Aktarım sırasında ekranı kapatmayın ve uygulamayı ön planda tutun.
- **Safari masaüstü:** `RTCDataChannel` ve `File.slice()` çalışır; doğrudan disk akışı yoktur. Çok büyük dosyalarda bellek kullanımı Chrome'a göre daha yüksektir.
- **Pano API'si:** HTTP üzerinde (localhost dışında) kısıtlıdır; uygulama otomatik kopyalama başarısız olursa kullanıcıya seçim yaptırır.
- **Kamera/QR:** Uygulama kamera istemez (izin politikası `camera=()`); QR'ı işletim sistemi kamerası veya başka bir uygulama okur.
- **Mobil klavye:** Küçük ekranlarda sohbet paneli klavye açılınca kayabilir; 390 px genişlikte yatay taşma otomatik E2E ile kontrol edilir.

---

## Proje yapısı

```
P2P_Share/
├── server.js                    # Express + ws signaling, QR, güvenlik başlıkları
├── public/
│   ├── index.html               # Arayüz iskeleti ve şablonlar
│   ├── styles.css               # Cyberpunk koyu tema, responsive tasarım
│   ├── protocol.js              # Parça/boyut/kimlik doğrulaması (UMD, test edilebilir)
│   ├── app.js                   # WebRTC motoru, chunking, UI mantığı
│   └── favicon.svg
├── test/
│   ├── protocol.test.js         # Saf protokol birim testleri
│   └── signaling.test.js        # WebSocket/HTTP entegrasyon testleri
├── tools/
│   └── browser-e2e.js           # Headless Chromium uçtan uca senaryoları
├── deploy/
│   └── coturn/turnserver.conf   # Örnek TURN yapılandırması
├── package.json
├── package-lock.json
├── run.bat                      # Windows tek tık başlatıcı
├── Dockerfile
├── .dockerignore
├── .env.example
├── .gitignore
└── README.md
```

### HTTP uç noktaları

| Yol | Açıklama |
| --- | --- |
| `GET /` | Uygulama arayüzü |
| `GET /healthz` | Sağlık kontrolü (JSON) |
| `GET /api/config` | ICE sunucuları, sürüm, oda kapasitesi |
| `GET /api/qr?text=...` | Aynı origin için PNG QR kod |
| `WS /ws` | Sinyalleşme kanalı |

### Sinyal mesajları

İstemci → sunucu:

```json
{ "type": "create", "name": "Mavi Şahin", "clientId": "uuid" }
{ "type": "join", "room": "K7M2QX", "name": "Mavi Şahin", "clientId": "uuid" }
{ "type": "signal", "to": "peer-id", "signal": { "kind": "offer", "sdp": "v=0..." } }
{ "type": "leave" }
{ "type": "ping" }
```

Sunucu → istemci:

```json
{ "type": "joined", "room": "K7M2QX", "self": { ... }, "peers": [ ... ], "resumed": false }
{ "type": "peer-joined", "peer": { ... } }
{ "type": "peer-offline", "peerId": "..." }
{ "type": "peer-online", "peer": { ... } }
{ "type": "peer-left", "peerId": "..." }
{ "type": "signal", "from": "peer-id", "signal": { ... } }
{ "type": "pong" }
{ "type": "error", "code": "ROOM_FULL", "message": "..." }
```

Hata kodları: `INVALID_JSON`, `UNKNOWN_MESSAGE`, `INVALID_ROOM`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `ALREADY_JOINED`, `NOT_IN_ROOM`, `PEER_UNAVAILABLE`, `INVALID_SIGNAL`, `RATE_LIMIT`, `MESSAGE_TOO_LARGE`.

### DataChannel mesajları

- Kontrol mesajları UTF-8 JSON string olarak gider: `hello`, `text`, `file-start`, `file-accept`, `file-reject`, `file-cancel`, `file-end`, `file-complete`, `file-error`. Liste `public/protocol.js` içindeki `CONTROL_TYPES` ile tanımlıdır ve bir birim testi, istemci switch'inin bu listeyle birebir eşleştiğini doğrular.
- Dosya baytları binary `ArrayBuffer` olarak gider. Aktif transfer sırasında gelen binary parçalar o transferin 64 KB'lık parçalarıdır. Aynı peer'da aynı anda tek dosya akar.
- Her transferin rastgele bir `id`'si vardır; kontrol mesajları bu kimlikle eşleştirilir.

---

## Test

```bash
npm test
```

Suit iki dosyadan oluşur ve toplam **20 test** içerir (`node --test`, rastgele port, gerçek sunucu süreci):

- `test/protocol.test.js` (10 birim testi): 64 KB parça sınırları, 256 KB azami parça, sıfır bayt, tam boyut, bir bayt taşma, negatif/ondalık/NaN uzunluklar, `write-error` önceliği, `validateFileSize`, güvenli kimlikler, dosya adı/mime temizliği, `hasTurnServer` (string/dizi/büyük-küçük harf/boşluk/null) ve `handleControlMessage` switch'inin `CONTROL_TYPES` ile birebir eşleşmesi.
- `test/signaling.test.js` (10 entegrasyon testi): sağlık/config/QR, **kısa ömürlü TURN kimlik bilgileri** (HMAC-SHA1, bitiş zamanı, sırrın yanıtta bulunmaması), oda oluşturma-katılma, peer olayları, offer/answer/ICE iletimi, ayrılma, hatalı mesajlar, CSP/HSTS/Referrer/Permissions başlıkları, cross-origin WebSocket reddi (403), kaynak sızıntısı kontrolü, hız sınırı, aynı `clientId` ile ikinci sekmenin yeni kimlik alması ve **8 cihaz kapasitesi** + 15 saniyelik yeniden bağlanma penceresi.

Tarayıcı uçtan uca testi (gerçek Chromium, gerçek WebRTC, gerçek dosya indirmesi):

```bash
npm run test:e2e
```

Edge veya Chrome otomatik aranır (`BROWSER_PATH` ile değiştirilebilir); yoksa test `SKIP` yazıp başarıyla çıkar. Her senaryo taze oda, benzersiz geçici dizin ve rastgele port kullanır; sabit `sleep` yerine koşul beklenir. Senaryolar:

1. **Temel:** oda kur/katıl, ağ rozetinin `STUN` modunu ve peer durumunun `Bağlı · doğrudan` yol etiketini göstermesi, metin, 2 MB dosya (SHA-256 karşılaştırmalı), QR uç noktası ve yabancı host reddi, ayrılma (oda her iki tarafta temizlenir), konsol/CSP/HTTP≥400 taraması.
2. **Büyük dosya:** 50 MB + 17 bayt, iki tarafta `complete`, indirilen dosyanın SHA-256 eşleşmesi.
3. **Reddetme:** alıcı reddeder; gönderen `rejected` durumunu ve nedeni görür, durum sonradan değişmez.
4. **İptal:** (a) kabulden önce, (b) 80 MB aktarım sırasında; iki tarafta `cancelled`.
5. **Kabul zaman aşımı:** test kancasıyla 1,2 s'ye indirilir; gönderen hata, alıcı iptal durumuna geçer (gerçek üretim süresi 2 dakikadır).
6. **Kanal kopması:** aktarım ortasında DataChannel kapatılır; iki taraf da hatayı temiz biçimde gösterir. Ardından görünür **Yeniden bağlan** düğmesine tıklanır, kanal yeniden kurulur ve metin aktarımı çalışır.
7. **Mesh:** üç cihaz tam bağlanır, metin ve dosya iki alıcıya birden gider.
8. **Sekme yenileme:** `sessionStorage` kimliği korunur, aynı peer id ile otomatik geri katılım, sonrasında metin çalışır.
9. **Sinyal kopması:** WebSocket kapatılır; istemci yeni soket açar, oturum/peer kimliği korunur, metin çalışır.
10. **Erişilebilirlik:** yalnızca klavyeyle oda kurma/katılma, Ctrl+Enter ile gönderme, görünür kontrollerin erişilebilir adları, 390 px'te yatay taşma yokluğu, `prefers-reduced-motion`, axe-core (wcag2a/aa) taraması.

`axe-core` isteğe bağlıdır (`devDependencies`); kurulu değilse o adım `SKIP` yazar. Tek bir senaryoyu çalıştırmak için: `E2E_ONLY="mesh" npm run test:e2e` (senaryo adları yukarıdaki listedeki gibidir).

### File System Access API — manuel doğrulama

Doğrudan diske yazma (`showSaveFilePicker` + `createWritable`) tarayıcı otomasyonunda gerçek kayıt konumu seçtirilemediği için E2E'de **otomatik doğrulanmaz**; E2E bu API'yi devre dışı bırakıp indirme yedeğini bayt bayt doğrular. Gerçek Chrome/Edge ile manuel doğrulama:

1. `npm start` ve `https://` ya da `http://localhost:3000` üzerinden açın (güvenli bağlam gerekir).
2. İki sekmede oda kurun/katılın; alıcıda `showSaveFilePicker` desteklenmeli (`'showSaveFilePicker' in window` → `true`).
3. 50 MB'lık bir dosya gönderin, alıcıda **Kabul et**'e basın.
4. Kayıt konumu penceresinde bir klasör seçin; aktarım sırasında dosyanın geçici olarak `.crswap` uzantısıyla büyüdüğünü, tamamlanınca gerçek ada döndüğünü görün.
5. Dosyayı kaynakla karşılaştırın: PowerShell `Get-FileHash kaynak`, `Get-FileHash hedef` çıktıları eşit olmalı.
6. Aktarım sırasında sekmeyi kapatıp hedef klasörde geçici (`.crswap`) dosyanın kalıp kalmadığını gözlemleyin; bu davranış tarayıcı sürümüne göre değişebilir.

Manuel uçtan uca test için:

1. `npm start`
2. İki sekme açın: `http://localhost:3000`
3. Birinde oda oluşturun, diğerinde katılın.
4. Küçük bir metin ve bir dosya gönderin.
5. DevTools → Network → WS altında yalnızca signaling mesajlarının geçtiğini, dosya trafiğinin WebRTC üzerinde olduğunu doğrulayın.

### Otomatik doğrulanmayanlar

Aşağıdaki maddeler bu geliştirme ortamında **test edilmemiştir**; README'de talimat olarak yer alır:

- Docker imajının derlenmesi ve konteynerde `/healthz` (ortamda Docker yok; Dockerfile mantıksal olarak incelendi).
- Gerçek (headless olmayan) Chrome/Edge'de `showSaveFilePicker` ile doğrudan diske yazma; adımlar yukarıda.
- Farklı ağlar arasında TURN/coturn geçişi; kontrol listesi yukarıda.
- Fiziksel iOS/Android cihazlarda Safari/Chrome davranışı.
- Firefox'ta uçtan uca akış (E2E yalnızca Chromium/Edge otomasyonu kullanır).

---

## Sorun giderme

| Belirti | Olası neden / çözüm |
| --- | --- |
| "Sunucu çevrimdışı" | `npm start` çalışıyor mu? Port ve güvenlik duvarını kontrol edin. |
| Oda bulunamadı | Kod 6 karakter mi? Oda boşaldıysa silinmiş olabilir; yeni oda kurun. |
| Cihazlar bağlanmıyor | Ağ P2P'yi engelliyor olabilir. TURN ekleyin. Birden fazla NAT arkasındaysanız bu normaldir. |
| Bağlantı kuruluyor ama dosya akmıyor | Tarayıcı konsolunda WebRTC hatalarını kontrol edin; sayfayı iki tarafta da yenileyin. |
| Dosya kabul edilmiyor | Alıcı tarafta kayıt yeri seçimi iptal edilmiş veya disk dolu olabilir. |
| Çok büyük dosyada bellek hatası | Firefox/Safari bellekten indirme kullanır. Chrome/Edge + HTTPS ile doğrudan diske akış kullanın. |
| QR görünmüyor | Sunucunun `/api/qr` uç noktasına erişebildiğinden emin olun; ters proxy yolu bozmamalı. |
| Pano çalışmıyor | HTTP üzerinde pano API'si kısıtlıdır; otomatik metin kopyalama yedeği devreye girer. |
| LAN'da `localhost` çalışıyor, IP çalışmıyor | Windows güvenlik duvarında Node.js'e özel ağ izni verin. |

---

## Lisans

MIT. Dilediğiniz gibi kullanın, değiştirin ve yayınlayın.
