# Flame V1 — Bulut Config Kurulumu

Bu klasör, config'leri **8 haneli bir kodla** paylaşmanı sağlayan küçük bir
bulut servisidir. Oyunda bir config'i yükleyince bir kod alırsın; o kodu giren
herkes config'i (modüller + bindler + tüm ayarlar) **doğrudan oyun içine** çeker.

- **Site arayüzü yoktur.** Servis yalnızca bir API'dir, `curl` ile konuşulur.
- Config'ler **listelenemez / aranamaz**; sadece tam kodu bilen ulaşır.
- Kötü niyetli IP'ler **otomatik banlanır** (aşağıda "Güvenlik").

Sonunda elinde şu olacak: `https://senin-projen.vercel.app` adresinde çalışan,
oyunun konuştuğu bir API.

---

## 0) Gerekenler

- Bir **Vercel** hesabı (ücretsiz): https://vercel.com (GitHub ile giriş en kolayı).
- Bilgisayarında **Node.js** (sende zaten var).

---

## 1) Servisi Vercel'e yükle (deploy)

Terminalde bu klasöre gir ve Vercel CLI ile yükle:

```bash
cd "C:\Users\tusufTE MC\Desktop\system-2.0\flamev1-cloud"
npm i -g vercel
vercel login
vercel
```

- `vercel login` tarayıcıda hesabını açar, onaylarsın.
- `vercel` ilk kez çalışınca birkaç soru sorar: hepsine **Enter** (varsayılan) de;
  "link to existing project?" → **N**, proje adı → `flamev1-cloud` (ya da ne istersen).
- Bitince sana bir **Preview** linki verir. Henüz veritabanı bağlı olmadığı için
  API `500 "Storage is not configured"` döner — bu normal, bir sonraki adımda bağlayacağız.

> Alternatif: CLI istemezsen bu klasörü bir GitHub deposuna atıp Vercel panelinden
> **Add New → Project → Import** ile de yükleyebilirsin. Fark etmez.

---

## 2) Veritabanını bağla (Upstash Redis — ücretsiz)

Config'ler bir Redis'te saklanır. Vercel'in kendi pazarından tek tıkla eklenir:

1. https://vercel.com/dashboard → **flamev1-cloud** projesine gir.
2. Üstten **Storage** sekmesi → **Create Database** → **Upstash** → **Redis**.
3. Bir isim ver, bölge olarak **Frankfurt (eu-central)** seç (site de `fra1`'de),
   **Create** / **Connect**.
4. "Connect to Project" sorarsa **flamev1-cloud**'u seç.

Bu işlem, projeye otomatik olarak şu ortam değişkenlerini ekler (isim
`KV_REST_API_URL` veya `UPSTASH_REDIS_REST_URL` olabilir — ikisi de desteklenir):
`..._REST_API_URL` ve `..._REST_API_TOKEN`. Elle bir şey girmene gerek yok.

---

## 3) Yükleme anahtarını ayarla (UPLOAD_KEY)

Sadece **senin client'ın** config yükleyebilsin diye bir gizli anahtar koyuyoruz.

1. Proje → **Settings** → **Environment Variables**.
2. Yeni değişken ekle:
   - **Key:** `UPLOAD_KEY`
   - **Value:** uzun rastgele bir şey (örn. aşağıdaki komutun çıktısı)
   - **Environments:** Production (+ istersen Preview)

Rastgele anahtar üret:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Çıkan değeri kopyala — birazdan oyun tarafına da **aynısını** gireceğiz.

> İstersen güvenlik ayarlarını da buradan değiştirebilirsin (hepsi opsiyonel):
> `STRIKE_LIMIT` (varsayılan 20 — ban eşiği), `BAN_SECONDS` (3600 — ban süresi),
> `LOOKUP_LIMIT` (60/dk), `UPLOAD_LIMIT` (20/10dk), `CONFIG_TTL_DAYS` (0 = süresiz),
> `MAX_CONFIG_KB` (512).

---

## 4) Son deploy

Env değişkenleri yeni deploy'da etkin olur. Terminalden:

```bash
vercel --prod
```

Sana **Production** linkini verir, örn. `https://flamev1-cloud.vercel.app`.
**Bu linki not et.**

Hızlı test (kod yok → 404, yani ayakta):

```bash
curl "https://flamev1-cloud.vercel.app/api/config?code=ABCD-EFGH"
```

`{"error":"Code not found"}` dönerse her şey çalışıyor demektir.

---

## 5) Oyunu (mod'u) bağla

`system-2.0` projesinde tek bir dosyada iki satır değiştireceğiz:

`src/main/java/dlindustries/uk/daduncs/managers/CloudConfigs.java`

```java
public static final String BASE_URL = "https://flamev1-cloud.vercel.app"; // 4. adımdaki Production link
public static final String UPLOAD_KEY = "...";                            // 3. adımdaki UPLOAD_KEY ile AYNI
```

Sonra jar'ı yeniden derle:

```bash
cd "C:\Users\tusufTE MC\Desktop\system-2.0\system-2.0"
.\gradlew build
```

Yeni jar: `system-2.0\build\libs\flamev1.jar`.

---

## 6) Nasıl kullanılır (oyun içinde)

**Config yükleyip kod almak:**
1. Menü → **Client → Configs** (sağ tık ile ayar panelini aç).
2. Bir config'i kaydet (**Save** → isim → Enter).
3. O satırdaki **bulut ↑** simgesine tıkla → config buluta gider, **kod panoya kopyalanır**
   ve sohbette "Cloud code XXXX-XXXX copied" yazar. (Shift+tık yaparsan buluta değil,
   eskisi gibi JSON'u panoya kopyalar.)

**Kodla config çekmek:**
1. **Configs → Import** → **Code**.
2. Kodu yaz ya da **Ctrl+V** ile yapıştır → **Enter**.
3. Config indirilir, "cloud XXXX" adıyla kaydedilir ve **anında uygulanır**
   (modüller, bindler, ayarlar). **Import → File** ise eskisi gibi dosyadan yükler.

> `BASE_URL` placeholder'da kaldıysa oyun "Cloud is not set up yet" der ve bulut
> simgesi otomatik olarak dosya-dışa-aktarıma döner; yani kurmadan da mod sorunsuz çalışır.

---

## Güvenlik — nasıl korunuyor

Katmanlı savunma (API `api/config.js` içinde):

1. **Katı doğrulama:** kod biçimi (8 hane, belirli alfabe), gövde boyutu (≤512 KB),
   yalnızca `GET`/`POST`, geçerli Flame V1 config şeması. Redis komutları parametreli
   (enjeksiyon yok).
2. **Yükleme anahtarı:** `UPLOAD_KEY` olmadan kimse config yükleyemez (401).
3. **Hız sınırı (rate limit):** IP başına arama 60/dk, yükleme 20/10dk → aşınca 429.
4. **Otomatik IP ban:** başarısız/kötü istekler puan toplar (yanlış anahtar=5,
   bozuk kod=3, boş deneme=1…). 10 dk içinde **20 puanı** geçen IP **1 saat banlanır**
   → tüm istekleri anında **403**. Yani kod tahmini (brute force), tarama ve spam
   daha başlamadan kesilir. Masum bir yazım hatası (1–2 deneme) kimseyi banlamaz.
5. **Gizlilik:** listeleme/arama endpoint'i yok; `noindex` + sıkı güvenlik başlıkları.
   Kod uzayı 30^8 ≈ 6.5×10¹¹ — ban + limit ile kaba kuvvet pratikte imkânsız.

Bu kurallar `api/config.js` + `vercel.json`'da; `STRIKE_LIMIT`, `BAN_SECONDS` vb.
ortam değişkenleriyle sıkılaştırılabilir. Değişiklikleri yerelde test etmek için
`scratchpad/cloudtest/test-api.mjs` (19 senaryo: ban, brute force, yetkisiz yükleme…)
`node test-api.mjs <api/config.js yolu>` ile çalışır.

**Dürüst notlar:**
- `UPLOAD_KEY` client jar'ının içine gömülür; jar'ı decompile eden biri anahtarı
  görebilir. Yine de limit + ban yüzünden en fazla "izinli hızda" yükleme yapabilir,
  DB'yi dolduramaz. (İleride UID/HWID ile yükleme kişiye bağlanıp bu tamamen kapanır.)
- Ağ seviyesinde büyük **DDoS** koruması uygulama katmanında değil, Vercel kenarında
  olur. Gerekirse Vercel **Firewall/WAF** (proje → Firewall) ile ek kural ekleyebilirsin.

---

## İleride (altyapı buna hazır)

- **UID / HWID:** kayıt şeması `{ v, name, server, created, owner, config }` — `owner`
  alanı ileride UID/HWID için ayrıldı. Yükleme akışına bir UID/HWID doğrulaması
  eklemek bu yapıyı bozmadan yapılabilir.
- **Public configs:** herkese açık configler için ayrı bir koleksiyon + oyun içinde
  bir liste ekranı + aynı kod/çekme altyapısı kullanılabilir. (Bunu sonra yapacağız.)
