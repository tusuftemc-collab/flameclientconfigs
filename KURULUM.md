# Flame V1 — Bulut Config Kurulumu (Git ile deploy)

Bu klasör, config'leri **8 haneli bir kodla** paylaşmanı sağlayan küçük bir
bulut servisidir. Oyunda bir config'i yükleyince bir kod alırsın; o kodu giren
herkes config'i (modüller + bindler + tüm ayarlar) **doğrudan oyun içine** çeker.

- Hedef adres: **https://flame-client-configs.vercel.app**
- **Site arayüzü yoktur**; servis yalnızca bir API'dir, `curl` ile konuşulur.
- Config'ler **listelenemez / aranamaz**; sadece tam kodu bilen ulaşır.
- Kötü niyetli IP'ler **otomatik banlanır** (aşağıda "Güvenlik").
- Deploy **Git ile** yapılır: GitHub'a `push` edersin, Vercel otomatik yayınlar.

Bu repo zaten `git init` edilmiş ve ilk commit atılmış durumda. Aşağıda sadece
kendi GitHub repona bağlayıp push etmen ve Vercel + veritabanı ayarların kaldı.

> Hazır değerler: mod tarafı `BASE_URL` ve `UPLOAD_KEY` ile **ayarlandı**.
> `UPLOAD_KEY = IL_vFtsoKrExnQERDplcWQJXGwoKsTN6` — bunu 4. adımda Vercel'e de **aynen** gireceksin.

---

## 0) Gerekenler

- Bir **GitHub** hesabı + bir **boş repo** (örn. `flameclientconfigs`).
- Bir **Vercel** hesabı (ücretsiz, GitHub ile giriş en kolayı).
- `git` (sende var).

---

## 1) GitHub'a push et

GitHub'da boş bir repo aç (README/gitignore **ekleme**, boş olsun). Sonra bu
klasörde (`flamev1-cloud`) terminalden:

```bash
cd "C:\Users\tusufTE MC\Desktop\system-2.0\flamev1-cloud"
git remote add origin https://github.com/KULLANICI_ADIN/flameclientconfigs.git
git push -u origin main
```

- `KULLANICI_ADIN/flameclientconfigs.git` kısmını kendi repo adresinle değiştir.
- Push ederken GitHub kullanıcı adı + **token** (parola değil) ister; GitHub →
  Settings → Developer settings → Personal access tokens'tan bir token alıp parola
  yerine yapıştır.

> Daha sonra her değişiklikte deploy: `git add -A && git commit -m "..." && git push`
> — Vercel bu repoya bağlı olduğu için **her push'ta otomatik yeniden yayınlar.**

---

## 2) Vercel'e bağla (repo import)

1. https://vercel.com/new → **Import Git Repository** → az önce push ettiğin
   `flameclientconfigs` reposunu seç.
2. **Root Directory:** repo doğrudan bu klasörse `/` (varsayılan) kalsın.
   *(Eğer repona tüm `system-2.0`'ı koyduysan, burada `flamev1-cloud` seç.)*
3. Framework Preset: **Other** (otomatik gelir). **Deploy** de.
4. İlk deploy biter; henüz veritabanı yok, API `500 "Storage is not configured"`
   döner — normal, sıradaki adımda bağlayacağız.

---

## 3) Veritabanını bağla (Upstash Redis — ücretsiz)

1. Vercel → **flameclientconfigs** projesi → üstte **Storage** → **Create Database**
   → **Upstash** → **Redis**.
2. Bölge **Frankfurt (eu-central)** (site de `fra1`), **Create / Connect**.
3. "Connect to Project" → **flameclientconfigs**'i seç.

Bu, projeye otomatik olarak `..._REST_API_URL` ve `..._REST_API_TOKEN` ortam
değişkenlerini ekler (isim `KV_...` veya `UPSTASH_...` olabilir — ikisi de çalışır).

---

## 4) Yükleme anahtarını ekle (UPLOAD_KEY)

Sadece **senin client'ın** config yükleyebilsin diye:

1. Proje → **Settings** → **Environment Variables** → **Add**.
2. **Key:** `UPLOAD_KEY` — **Value:** `IL_vFtsoKrExnQERDplcWQJXGwoKsTN6`
   (mod'a gömülü olanla **birebir aynı**) — **Environments:** Production (+ Preview).
3. Kaydet.

> Opsiyonel güvenlik ayarları (hepsinin varsayılanı var, dokunmasan da olur):
> `STRIKE_LIMIT` (20 — ban eşiği), `BAN_SECONDS` (3600 — ban süresi), `LOOKUP_LIMIT`
> (60/dk), `UPLOAD_LIMIT` (20/10dk), `CONFIG_TTL_DAYS` (0 = süresiz), `MAX_CONFIG_KB` (512).

---

## 5) Env'leri etkinleştir (tekrar deploy)

Ortam değişkenleri **yeni bir deploy'da** etkin olur. En kolayı boş bir commit atıp
push etmek (ya da Vercel panelinde Deployments → son deploy → **Redeploy**):

```bash
git commit --allow-empty -m "trigger deploy with env vars" && git push
```

Test (kod yok → 404 yani ayakta):

```bash
curl "https://flame-client-configs.vercel.app/api/config?code=ABCD-EFGH"
```

`{"error":"Code not found"}` dönerse her şey çalışıyor.

---

## 6) Oyunu (mod'u) derle

Mod tarafı **zaten ayarlı** (`CloudConfigs.java` içinde `BASE_URL` ve `UPLOAD_KEY`
dolu). Sadece jar'ı derlemen yeterli:

```bash
cd "C:\Users\tusufTE MC\Desktop\system-2.0\system-2.0"
.\gradlew build
```

Yeni jar: `system-2.0\build\libs\flamev1.jar`.

> Anahtarı değiştirmek istersen: `CloudConfigs.java`'daki `UPLOAD_KEY` ile Vercel'deki
> `UPLOAD_KEY` **aynı** olmalı; sonra hem jar'ı yeniden derle hem env'i güncelleyip
> yeniden deploy et.

---

## 7) Nasıl kullanılır (oyun içinde)

**Config paylaşmak (Private / Public):**
1. Menü → **Client → Configs** (sağ tık ile ayar panelini aç).
2. Bir config'i kaydet (**Save** → isim → Enter).
3. O satırdaki **bulut ↑** simgesine tıkla → üstte iki seçenek çıkar:
   - **🔒 Private:** config buluta gider, **kod panoya kopyalanır**. Sadece kodu bilen yükleyebilir.
   - **🌐 Public:** aynı şekilde kod alırsın **ve** config herkese açık listede görünür.
   (Esc / başka yere tık = iptal. Shift+tık = eskisi gibi JSON'u panoya kopyalar.)

**Config yüklemek — Import menüsü üç seçenek sunar:**
- **File:** bilgisayardaki `.json` dosyasından.
- **Code:** kodu yaz ya da **Ctrl+V** ile yapıştır → **Enter**.
- **Public:** herkese açık liste açılır.
  - Üstte **Popular** (en çok indirilen) / **New** (en yeni) / **Back**.
  - Her satırda isim, kaydedildiği sunucu ve indirme sayısı görünür.
  - Satıra tıkla → config indirilir ve **anında uygulanır** (modüller, bindler, ayarlar).
  - Liste uzunsa en altta **Load more**.

Buluttan (kod ya da public) gelen config yerelde **"isim - XXXX"** adıyla kaydedilir
(XXXX = kodun ilk 4 hanesi). Aynı config'i tekrar yüklemek kopya üretmez, aynı yerel
config'i günceller; senin kendi config'lerinle de çakışmaz.

---

## 8) Public listeden kaldırma (sadece sen)

Herkes public yayınlayabildiği için uygunsuz bir config'i listeden kaldırma yetkisi
**yalnızca sende** olur. Bunun için ayrı bir **ADMIN_KEY** kullanılır — bu anahtar
**jar'a ve bu repoya asla girmez**, sadece Vercel'de ve senin bilgisayarında durur.

1. Anahtar üret (çıktıyı kimseyle paylaşma, bir yere not et):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
2. Vercel → **Settings → Environment Variables** → `ADMIN_KEY` = üretilen değer
   (Production) → kaydet → **Redeploy**.

Kullanım (PowerShell'de `curl.exe`, Git Bash'te `curl`):

```bash
# Public listeden kaldır (config kodla yüklenebilir kalır, private'a döner)
curl -X DELETE "https://flame-client-configs.vercel.app/api/config?code=XXXX-XXXX" -H "x-admin-key: ADMIN_KEY_DEGERIN"

# Tamamen sil (kodla da yüklenemez olur)
curl -X DELETE "https://flame-client-configs.vercel.app/api/config?code=XXXX-XXXX&purge=1" -H "x-admin-key: ADMIN_KEY_DEGERIN"
```

`ADMIN_KEY` ayarlı değilse bu işlem tamamen kapalıdır (404). Yanlış anahtarla deneyen
IP 4. denemede otomatik banlanır.

Public listeye curl ile bakmak:

```bash
curl "https://flame-client-configs.vercel.app/api/config?list=public&sort=top&page=0"
curl "https://flame-client-configs.vercel.app/api/config?list=public&sort=new&page=0"
```

---

## Güvenlik — nasıl korunuyor

Katmanlı savunma (API `api/config.js`):

1. **Katı doğrulama:** kod biçimi (8 hane), gövde ≤512 KB, yalnızca `GET`/`POST`/`DELETE`,
   geçerli config şeması, isimler sadece harf/rakam/` _.-`. Redis komutları parametreli
   (enjeksiyon yok).
2. **Anahtarlar:** yükleme için `UPLOAD_KEY` (401); listeden kaldırma için ayrı
   `ADMIN_KEY` (yükleme anahtarı admin işlemi yapamaz).
3. **Hız sınırı:** IP başına arama/liste 60/dk, yükleme 20/10dk, **public yayın 5/saat**
   (liste spam ile dolamaz) → aşınca 429.
4. **Otomatik IP ban:** başarısız/kötü istekler puan toplar (yanlış anahtar=5,
   bozuk kod=3, boş deneme=1). 10 dk içinde **20 puanı** geçen IP **1 saat** boyunca
   her istekte **403** alır (public liste dahil). Masum yazım hatası kimseyi banlamaz.
5. **Sayaç hilesine karşı:** indirme sayısı aynı IP + aynı config için günde 1 kez artar.
6. **Gizlilik:** private config'ler hiçbir listede görünmez; public liste config
   gövdesini değil sadece özetini (isim, sunucu, modül sayısı, indirme) döner.
   `noindex` + sıkı güvenlik başlıkları. Kod uzayı 30⁸ ≈ 6.5×10¹¹.

Ayarlanabilir env değerleri: `STRIKE_LIMIT`, `BAN_SECONDS`, `LOOKUP_LIMIT`, `UPLOAD_LIMIT`,
`PUBLIC_LIMIT` (5/saat), `CONFIG_TTL_DAYS`, `MAX_CONFIG_KB`.
Yerel test: `scratchpad/cloudtest/test-api.mjs` (23 senaryo).

**Dürüst notlar:**
- `UPLOAD_KEY` client jar'ının içine gömülüdür; jar'ı decompile eden anahtarı görebilir.
  Yine de limitler + ban yüzünden en fazla "izinli hızda" yükleme yapabilir.
- Herkes public yayınlayabildiği için listeye uygunsuz isimli config düşebilir;
  saatlik sınır bunu yavaşlatır, temizlemek için 8. bölümdeki kaldırma komutu var.
  (UID/HWID gelince yayınlar kişiye bağlanıp kişi bazında engellenebilir.)
- Büyük **DDoS** koruması uygulama değil Vercel kenarı işidir; gerekirse proje →
  **Firewall** ile ek kural eklenir.

---

## İleride (altyapı buna hazır)

- **UID / HWID:** kayıt şemasında `owner` alanı ayrıldı; yükleme akışına doğrulama
  eklemek yapıyı bozmaz.
