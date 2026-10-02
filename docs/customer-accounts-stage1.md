# Müşteri hesabı — 1. aşama teslimi

Bu çalışma yalnızca yerel/izole test ortamında uygulanmıştır. Canlıya yayınlama,
canlı veritabanı migration'ı ve canlı rol/izin değişikliği yapılmamıştır.

## Tamamlanan kapsam

- Strapi Users & Permissions kullanıcılarıyla kayıt, giriş, çıkış.
- E-posta doğrulama, yeniden doğrulama bağlantısı isteme, şifremi unuttum ve reset.
- Yeni e-posta doğrulanana kadar mevcut adresi koruyan, mevcut şifre gerektiren e-posta değişikliği.
- Ad soyad/telefon profili, en fazla 20 adres, ayrı teslimat/fatura varsayılanları.
- Yalnızca mevcut `Order.user` ilişkisiyle hesaba bağlı siparişlerin listesi/detayı.
- Masaüstü/mobil header hesabı erişimi, korunan hesap sayfaları, boş/hata durumları.

Yeni kimlik sistemi kurulmadı. Admin kullanıcıları ve admin JWT alanı ayrı kaldı.
Üyelikte adres/kimlik bilgisi istenmiyor. Telefon profil/adres için isteğe bağlı.
Adres defteri geçmiş Order JSON snapshot'larını değiştirmiyor. Misafir siparişleri
e-posta/telefon eşleşmesiyle bağlanmıyor. Olmayan kargo/üretim bilgileri gösterilmiyor.

## Mimari ve güvenlik

Tarayıcı → Next `/api/account/[operation]` → Strapi `/api/customer/dispatch`.
İkinci endpoint yalnızca sunucu tarafındaki BFF anahtarıyla erişilebilir.
Backend müşteri kimliğini istemci `userId` alanından değil, kalıcı oturum kaydından alır.

Kurulu 5.43.0 kaynakları incelendi:

- `node_modules/@strapi/plugin-users-permissions/server/config.js`
- `server/controllers/auth.js`, `server/services/jwt.js`
- `node_modules/@strapi/core/dist/services/session-manager.js`

Gerçek `generateRefreshToken`, `generateAccessToken`, `validateRefreshToken`,
`rotateRefreshToken`, `invalidateRefreshToken` API'leri kullanılır. Access JWT
doğrulaması tek başına iptal kontrolü yapmadığı için oturum DB kaydı, refresh aile
kaydı, confirmed ve blocked her hesap isteğinde kontrol edilir.

Kalıcı kayıtlar Strapi'nin aynı veritabanındadır: `customer_profiles`,
`customer_addresses`, `customer_sessions`, `customer_actions`, `customer_rates`,
`customer_mails` ve ilişkileri. Bunlar kullanıcı/parola deposu değil, U&P kullanıcısına
bağlı profil ve güvenlik kayıtlarıdır. Generic router'ları yoktur ve Content Manager'da gizlidir.

Tarayıcı cookie'si yalnızca rastgele 256-bit oturum kimliği taşır. DB'de hash'i saklanır;
Strapi access/refresh tokenları AES-256-GCM ile şifrelenir. Anahtar DB dışında tutulur.
Cookie production'da `__Host-customer-session`, HttpOnly, Secure, SameSite=Lax,
Path=/ ve Domain belirtmeden oluşturulur. Yerel HTTP testlerinde Secure ve __Host
kullanılmaz. Token/parola localStorage'a yazılmaz; mevcut misafir sepeti değişmedi.

Access ömrü 10 dakika; hareketsiz oturum 24 saat; mutlak oturum 7 gün. Her etkin
istek idle süresini mutlak sınırı aşmadan uzatır. Yenileme son dakikada yapılır.
DB compare-and-swap lease ve yazma fencing'i aynı oturum için eşzamanlı refresh'i
kontrol eder. Çıkış ilgili cihaz oturumunu; reset, bloklama, admin parola/e-posta
değişikliği ve doğrulanmış e-posta değişikliği tüm ilgili oturumları iptal eder.
Bloklama/password/email güncellemeleri bekleyen güvenlik bağlantılarını da geçersiz kılar.

CSRF: HttpOnly cookie'deki HMAC imzalı, 1 saatlik ve mevcut oturuma bağlı ticket,
istek başlığında aynı değer ve kesin Origin/Fetch Metadata kontrolü. Kayıt, giriş,
çıkış, doğrulama, reset ve profil/adres mutasyonlarına uygulanır. Gövdeler JSON ve
en fazla 16 KB; chunked isteklerde de gerçek byte sayısı denetlenir.

Rate limit süreç belleğinde değildir. DB UNIQUE bucket + atomik upsert/returning
kullanılır. Genel istek 120/dakika; giriş 20/15 dakika; diğer auth işlemleri
8/15 dakika; ilgili e-posta/işlem için ayrıca 5/15 dakika. Güvenilir proxy başlığı
tanımlanmamışsa istemciler ortak muhafazakâr bucket kullanır; kullanıcı tarafından
gönderilen X-Forwarded-For'a otomatik güvenilmez. Production'da proxy bu başlığı
yeniden yazmalı, doğrudan Next erişimi kapatılmalı ve giriş başlığı sahteciliği test edilmelidir.

Doğrulama/e-posta değişikliği bağlantıları 24 saat, reset 30 dakika; tokenlar
hash'lenir, transaction içinde tek kullanımlı tüketilir. Yeni bağlantı önceki aynı
işlem bağlantısını iptal eder. Mail tokenı URL fragment'indedir; HTTP query/loglarına
gitmez ve sayfa açılınca adres çubuğundan kaldırılır. GET bağlantıyı tüketmez;
kullanıcı düğmeye basıp CSRF kontrollü POST yapar. Dönüş hedefleri yalnızca çalışan
hesap route'larıyla sınırlıdır.

Müşteri yanıtları açık alan listesiyle oluşturulur. Rol, confirmed, blocked,
sahiplik, fiyat, ödeme/sipariş durumu, token, banka ham verisi ve kalem iç maliyeti
ne müşteriden kabul edilir ne yanıtla açılır. `/api/orders`, `/api/users`, `/api/auth`
ve özel collection generic yolları middleware ile engellenir. `/backend` rewrite'ı
bu kontrolleri atlayamaz. Admin `/admin` ve `/content-manager` yolları ayrıdır.

## E-posta

Yerel harness `CUSTOMER_MAIL_MODE=file` kullanır. Kontrollü kutu
`.tmp/customer-mail/` altında, git dışında ve yalnızca development/test içindir.
Production'da file modu kabul edilmez; doğrulama devre dışı bırakılmaz.

Mail işi DB'ye şifreli payload ile yazılır. Kayıt/e-posta değişikliği gönderim
başarısızlığında 503 verir; hesabı/talebi varmış gibi gönderim başarısı göstermez.
Tekrar doğrulama isteğiyle kayıt tamamlanabilir. Reset/resend önce SMTP sağlık
kontrolü yapar, sonra kalıcı kuyruk kabulünü hesap varlığını açıklamayan aynı yanıtla
bildirir; yanıt e-postanın teslim edildiğini iddia etmez. Mail gönderimi dakikalık
cron'da en fazla 3 denemeyle yürür. Sonraki gönderim hatası API hesap varlığını
açıklamaz; iş failed durumunda kalır. Süresi dolmuş bağlantı gönderilmez. Başarılı
gönderimden sonra şifreli payload temizlenir. SMTP kabulü, alıcının gelen kutusuna
teslimat kanıtı değildir; production teslimat ayrıca doğrulanmalıdır.

15 dakikalık cleanup süresi dolmuş oturum/aileleri, rate kayıtlarını, eski action
kayıtlarını ve mail payload'larını temizler. Başarısız mail işleri için DB'de
durum/deneme sayısı vardır; özel operasyon ekranı bu aşamaya dahil değildir.
Uygulama auth hata nesnelerini/gövdelerini, cookie veya Authorization başlıklarını
loglamaz. Harici proxy/APM de bu alanları kaydetmeyecek şekilde yapılandırılmalıdır.

## Değişen dosyalar

Backend:

- `src/api/customer/{routes,controllers,services}/customer.ts`
- `src/customer/security.ts`, `src/middlewares/customer-boundary.ts`
- `src/api/customer-{profile,address,session,action,rate,mail}/content-types/.../schema.json`
- `src/extensions/users-permissions/strapi-server.ts`
- `src/index.ts`, `config/plugins.ts`, `config/middlewares.ts`, `config/server.ts`
- `tests/customer.integration.test.ts`, `.env.example`, package dosyaları, bu belge.

Frontend:

- `app/api/account/[operation]/route.ts`, `lib/server/account*.ts`
- `app/hesap/` altındaki auth, profil, adres ve sipariş ekranları.
- `components/account/`, `components/Header.tsx`
- `lib/account-client.ts`, `lib/account-redirect.ts`, `lib/order-display.ts`
- `tests/account.e2e.cjs`, `.env.example`, `.gitignore`, package dosyaları.
- `next.config.ts`: yalnızca isteğe bağlı yerel/staging backend rewrite hedefi;
  değişken boşsa mevcut hedef korunur.

`src/api/order/`, `src/api/payment/`, misafir `CartContext`, cart, checkout ve
payment sayfalarının iş mantığı değiştirilmedi. Order alanları silinmedi/yeniden
adlandırılmadı, `user` opsiyonel kaldı.

## Test komutları ve kapsam

Backend dizininde:

```sh
npm run test:accounts
npm run test:accounts:e2e
node --import tsx tests/customer.integration.test.ts --build
```

Harness her çalışmada yeni, izole SQLite DB ve geçici secretlar üretir; gerçek
`.env`/canlı DB'ye dayanmaz. E2E gerçek Strapi + Next + yeni, izole headless Edge
kullanır. Browser'ın production/banka ağ trafiği engellenir. Port 3210 test sırasında
boş olmalıdır. Test bitince başlattığı sunucular kapanır. E2E görüntüleri frontend
`.tmp/customer-e2e/` altındadır. Test mailbox ve DB dosyaları paylaşılmamalıdır.

Entegrasyon testleri kayıt/doğrulama/giriş/çıkış, süresi dolmuş/kullanılmış/geçersiz
bağlantılar, reset/bloklama sonrası iptal, e-posta değişikliği, adres CRUD ve
varsayılanları, başka hesap erişimi, rol/alan manipülasyonu, salt okunur sipariş,
misafir izolasyonu, snapshot korunması, paralel refresh, CSRF/Origin/açık yönlendirme,
DB rate limit, tekrar kurulum/schema sync, SMTP eksikliği, mail retry ve cleanup'ı kapsar.
Public rolüne kasıtlı geniş CRUD izni verilse dahi sınırın geçilemediği yalnızca
geçici test DB'sinde sınanır.

E2E mobil kayıt/hata/doğrulama/giriş, HttpOnly yanıt ve tokenların JSON'dan
çıkarılması, mobil adres ekleme/düzenleme, boş sipariş ekranı, masaüstü profil,
çıkış/korunan route, gerçek Next CSRF/Origin ve rewrite reddi, mevcut misafir
localStorage sepeti ve hesapsız checkout'u doğrular. Banka işlemi başlatmaz.
Adres silme, şifremi unuttum/reset formları ve mevcut hesaba bağlı dolu sipariş
listesi/detayı da tarayıcıda doğrulanmıştır.

Son doğrulama sonuçları: 14 backend entegrasyon/güvenlik grubu ve 6 uçtan uca
tarayıcı/HTTP grubu geçti. Gerçek Next/Edge testleri mobil ve masaüstü hesap işlemlerini doğruladı. Her iki proje
TypeScript kontrolü, yeni frontend dosyaları için hedefli ESLint ve iki production
derlemesi başarılıdır. Next build yalnızca geçici yerel CMS'yi kullanmıştır.

Frontend/backend TypeScript, değişen yeni frontend dosyalarının ESLint kontrolü
ve yerel fixture CMS ile üretim derlemeleri uygulanır. Genel frontend lint'i
mevcut cart/checkout/catalog/lib dosyalarındaki kapsam dışı hatalar nedeniyle temiz değildir.

## Ortam değişkenleri — değerler verilmez

| İsim | Amaç / yer |
|---|---|
| `CUSTOMER_ACCOUNTS_ENABLED` | Hesap hizmetini açar; iki uygulama |
| `CUSTOMER_BFF_SECRET` | En az 32 bayt, aynı origin aracı–backend güveni ve CSRF; iki uygulama |
| `CUSTOMER_PUBLIC_ORIGIN` | Kesin canonical origin; CSRF ve e-posta bağlantısı; iki uygulama |
| `CUSTOMER_STRAPI_INTERNAL_URL` | Sunucu tarafı Strapi adresi; yalnızca Next |
| `CUSTOMER_TOKEN_ENCRYPTION_KEY` | Base64 kodlu 32 bayt AES anahtarı; yalnızca backend |
| `CUSTOMER_SCHEMA_SETUP` | Kontrollü, idempotent başlangıç kurulumu; yalnızca backend |
| `CUSTOMER_MAIL_MODE` | smtp veya yalnızca yerel test file modu; backend |
| `CUSTOMER_SMTP_HOST` | SMTP sunucusu; backend |
| `CUSTOMER_SMTP_PORT` | Implicit TLS veya STARTTLS portu; backend |
| `CUSTOMER_SMTP_USER` | SMTP kullanıcı adı; backend |
| `CUSTOMER_SMTP_PASS` | SMTP kimlik bilgisi; backend |
| `CUSTOMER_MAIL_FROM` | Doğrulanmış gönderen; backend |
| `CUSTOMER_TRUSTED_CLIENT_IP_HEADER` | Proxy tarafından yeniden yazılan istemci başlığı; Next |
| `BACKEND_PROXY_URL` | İsteğe bağlı yerel/staging rewrite hedefi; Next |

Mevcut `JWT_SECRET`, `APP_KEYS`, admin secretları ve production PostgreSQL
`DATABASE_CLIENT`/`DATABASE_URL` ayarları ayrıca gereklidir. Hiçbir hesap secretı
`NEXT_PUBLIC_` önekiyle verilmez.

## Şema geçişi ve ileride production uygulama sırası

Bu adımlar bu teslimde canlıda çalıştırılmadı:

1. Bakım penceresi ve geri dönüş sürümü belirlenir; DB ve mevcut konfigurasyon
   yedeği alınır, staging'de geri yükleme provası yapılır. Order sayısı/tutar/XID/
   user ilişkisi ve U&P kullanıcı ID'leri kontrol listesine kaydedilir.
2. Mevcut e-postalarda büyük/küçük harf farkıyla duplicate kimlikler önceden incelenir.
   Setup duplicate varsa durur; kullanıcıları birleştirmez/silmez.
3. Yeni schema dosyaları Strapi'nin normal schema sync'iyle eklemeli tablolar/ilişkiler
   oluşturur. U&P e-posta column UNIQUE kısıtı ile yeni güvenlik kayıtlarının açık
   SQL unique indeksleri şemada tanımlıdır. `unique: true` uygulama doğrulaması
   tek başına atomik upsert için yeterli olmadığından DB indeksleri ayrıca vardır.
4. Tek backend instance ve kontrollü `CUSTOMER_SCHEMA_SETUP` ile `setup()` çalıştırılır:
   duplicate ön kontrolü, kullanıcı e-postalarının lowercase normalizasyonu,
   idempotent unique indeksleri ve U&P e-posta doğrulamasının etkinleştirilmesi.
   Kullanıcı ID'leri, parolaları, Order alanları/tutarları/snapshot'ları değiştirilmez.
5. Kurulum flag'i kapatılır; aynı kalıcı anahtarlarla bütün backend/Next instance'ları
   açılır. İndeksler, SMTP, cron, HTTPS cookie, trusted proxy ve sahiplik smoke testleri
   doğrulanır. Mevcut doğrulanmamış U&P kullanıcıları yeni bağlantı istemelidir.
6. Public/Authenticated rollerine generic User/Order CRUD yetkisi verilmez;
   varsa kaldırılır. Yeni müşteri dispatch'i rol iznine dayanmaz: BFF anahtarı,
   oturum ve kayıt sahipliği şartlarıyla çalışır. Katalogun mevcut okuma izinleri
   korunur. Admin kimlik/izinleri müşteri rolü olarak kullanılmaz.
7. Misafir cart/checkout/Posnet smoke testi yapılır. Eski misafir siparişleri ve
   mevcut user ilişkileri değişmeden kalır; otomatik backfill yapılmaz.

Staging/production PostgreSQL'de gerçek çoklu instance yarışları ve schema-sync
provası ayrıca gerekir; yerel suite SQLite üzerinde çalıştı. Test `setup()`ı
tekrarlar ve mevcut Order fixture'larını schema sync sonrasında birebir karşılaştırır.

Geri dönüşte önce müşteri erişimi durdurulur ve yeni oturumlar iptal edilir.
Güvenlik boundary'si korunur; eski generic User/Order erişimi geri açılmaz. Eski
Strapi şemasını körlemesine başlatmak yeni tabloların silinmesine yol açabilir;
bu nedenle uyumlu kapalı hesap sürümüyle geri dönüş veya kontrollü veri export'u
tercih edilir. Yedek geri yüklemek yayın sonrası yeni siparişleri kaybettirmemelidir;
gerekirse aradaki sipariş/ödeme kayıtları uzlaştırılır. Lowercase e-posta
normalizasyonunu geri çevirmek için eski değerler yedekten kontrollü eşlenir.
AES anahtarı değişirse eski şifreli oturumlar okunamaz; anahtar rotasyonundan önce
oturumlar iptal edilmeli veya kontrollü yeniden şifreleme uygulanmalıdır.

## Harici doğrulama bekleyenler

Gerçek SMTP credentials/teslimat/SPF-DKIM, production HTTPS/domain ve reverse proxy
başlık politikası, PostgreSQL instance'lar arası yük testi, cron'un kesintisiz
çalışması ve production admin izin envanteri yerel testle kanıtlanmadı. Gerçek
Posnet callback/banka tahsilatı bu aşamada denenmedi. Bunlar kodun yerel doğrulamasını
engellemez ancak production yayın kontrolünde tamamlanmalıdır.

## Sonraki aşamalara kalanlar

Hesap sepeti ve merge, checkout'un hesabı Order'a bağlaması, ödeme idempotency ve
callback/mutabakat iyileştirmeleri, eski sipariş sahiplenme, figür sayfası/talepleri,
private fotoğraf/HEIC yükleme, teklif sürümleri/onay/sipariş dönüşümü, üretim/kargo,
iptal/iade, iletişim/pazarlama tercihleri, hesap silme ve özel admin operasyonları
tamamlanmış değildir. Bunlar için çalışmayan menü eklenmedi. Bu aşamadaki mail
kuyruğu yalnızca üyelik güvenlik e-postaları içindir.
