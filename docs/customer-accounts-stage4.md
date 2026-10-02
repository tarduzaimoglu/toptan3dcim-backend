# Müşteri hesapları — 4. aşama

Bu aşama teklif, figür siparişine dönüşüm, operasyon ve iptal/iade başvurularını var olan Users & Permissions oturumu, hesap BFF'si, Order/PaymentAttempt/Posnet, private asset ve kalıcı outbox üzerine ekler. Yerel geliştirme ve test içindir; canlıya deploy, canlı şema/izin değişikliği, gerçek tahsilat ve gerçek iade yapılmadı.

## Tamamlanan akışlar

- Personel talep detayından taslak teklif kaydedebilir, sunabilir, geri çekebilir ve yeni sürüm oluşturabilir. Kapsam, insan/pet adedi, renk, tasarım, dahil parçalar, isteğe bağlı boyut/kaide/kutu ve üretim/teslimat notu sürüm snapshot'ındadır. İç not yalnızca personel yanıtındadır. Tutarlar TRY kuruş/minor birimindedir; vergi, kargo ve ödenecek toplam açıkça kaydedilir ve toplam aritmetiği backend'de doğrulanır. Vergi/kargo açıklaması ve toplam olmadan sunum yapılamaz; opsiyonel geçerlilik sunucu tarafında uygulanır.
- Sunulan teklif sürümü değişmez. Yeni sunum eskisini `superseded` yapar ve önceki müşteri onayını geçmişte tutup `approvalInvalidatedAt` ile geçersiz kılar. Süresi dolmuş, geri çekilmiş veya eski sürüm onaylanamaz. Tekrar onay ve değişiklik isteği idempotency/event key kullanır; teklif yanıtı talep kaydı ve outbox ile transaction içinde tutulur.
- Müşteri yalnızca kendine ait talep/teklifi görür, sürümü açıkça onaylar veya açıklamalı değişiklik ister. Teklif onayı ödeme değildir. Geçerli onaylı sürümden, sahibi doğrulanmış hesap adresleri snapshot alınarak idempotent Order yaratılır. Fiyat teklif sürümünden okunur, frontend tutarı kabul edilmez; katalog KDV/kargosu yeniden eklenmez.
- Figür siparişi mevcut PaymentAttempt ve Posnet servisini kullanır. Ödeme yalnızca `FIGURINE_PAYMENTS_ENABLED=true` ve `POSNET_BANK_VERIFIED=true` iken başlatılabilir; varsayılan ikisi de kapalıdır. Aktif/belirsiz ödeme teklifi değiştirme/geri çekmeyi bloke eder. Ödenmiş sipariş snapshot'ı kilitlidir. Bu ortamda ödeme UI'sı gerçek tahsilat başlatmaz.
- Personel ekranı Strapi admin eklentisinde mevcut admin kimliğiyle çalışır. Talepler, siparişler, müşteri yanıtları, fotoğraflar, teklif taslakları, operasyon/kargo ve iade başvuruları arasında bağlantı sağlar; başarısız outbox kaydı yeniden kuyruğa alınabilir. `review`, `quote`, `operations`, `photo`, `refund` kabiliyetleri rol adlarıyla ayrı denetlenir. Var olan order operasyon servisi ayrıca `strapi-super-admin` veya `order-operator` rol kodu ister. Content Manager ve genel koleksiyon endpoint'leri workflow kayıtları için kapalıdır.
- Operasyon durumu ödeme durumundan ayrıdır; izinli geçişler mevcut order operasyon servisince doğrulanır. Müşteriye görünen açıklama ile dahili not ayrı alan ve yanıtlardadır. Değişiklik özeti, aktör ve zaman `operation-event` içinde tutulur. Kargo takip URL'si mevcut güvenli URL kontrolünden geçer.
- Müşteri kendi siparişi için açıklamalı iptal/iade başvurusu bırakabilir. Başvuru siparişi iptal etmez, ödeme durumunu değiştirmez ve para iadesi yapmaz. Personelin kabul/ret kararı yalnızca başvuru kaydını günceller; banka iadesi başarılıymış gibi gösterilmez.
- Teklif, müşteri yanıtı, siparişe dönüşüm, önemli operasyon ve başvuru bildirimleri kalıcı outbox'a idempotent anahtarla yazılır. E-posta hatası ana işlemi geri almaz; admin retry ve worker retry kullanılabilir. E-postalar giriş gerektiren hesap bağlantıları taşır; fotoğraf URL'si, dahili not ve maliyet taşımaz.

## Şema ve veri ilişkileri

Yeni `figurine-offer`, `figurine-response`, `figurine-return-request` collection type'ları eklenmiştir. `figurine-request` bu kayıtlara ve mevcut sahibine/asset'lerine bağlıdır. `Order` için opsiyonel `figurineRequest`, `figurineOffer`, `figurineOfferKey`, değişmez `figurineSnapshot`, müşteri/dahili operasyon notları ve operasyon alanları eklenir. `operation-event` talep ilişkisi kazanır. Mevcut sipariş kolonları kaldırılmadı veya yeniden adlandırılmadı; eski Order, tutar, kullanıcı ilişkisi ve XID korunur. Teklif-sipariş anahtarı tekrarlı dönüşümü sınırlayan benzersiz alan/index olarak tanımlıdır.

Strapi şeması ilk açılışta eklemeli olarak tablo/kolonları oluşturur. Fixture'da uygulamanın tekrar başlatılması/şema hazırlığıyla mevcut kayıtlar korunmuştur; bu SQLite doğrulamasıdır, PostgreSQL kanıtı değildir. Canlı öncesi yedek alınmalı, önce geriye uyumlu şema ve backend yayınlanmalı, veriler/izinler doğrulanmalı, sonra müşteri yüzeyi açılmalıdır. Geri dönüşte yeni tablolar ve kolonlar korunmalı; eski sipariş alanları silinmemelidir. Yeni kodu geri almak gerekiyorsa ilişkili yeni tabloları veri incelemesi ve yedek olmadan düşürmeyin.

## Değişen/eklenen dosyalar

- İş kuralları ve yetki: `src/commerce/figurine-workflow.ts`, `src/commerce/operations.ts`, `src/commerce/figurines.ts`, `src/api/customer/services/customer.ts`, `src/middlewares/customer-boundary.ts`.
- Şema: `src/api/figurine-offer/content-types/figurine-offer/schema.json`, `src/api/figurine-response/content-types/figurine-response/schema.json`, `src/api/figurine-return-request/content-types/figurine-return-request/schema.json`, `src/api/figurine-request/content-types/figurine-request/schema.json`, `src/api/order/content-types/order/schema.json`, `src/api/operation-event/content-types/operation-event/schema.json`.
- Strapi admin: `src/plugins/figurine-admin/server/src/controllers/figurines.ts`, `src/plugins/figurine-admin/server/src/routes/index.ts`, `src/plugins/figurine-admin/admin/src/pages/Requests.tsx`.
- Ortam/entegrasyon: `.env.example`, `tests/customer.integration.test.ts`; müşteri BFF ve ekranları `toptan3dcim-frontend/app/api/account/[operation]/route.ts`, `app/hesap/(private)/figur-talepleri/[id]/page.tsx`, `app/hesap/(private)/siparisler/[id]/page.tsx`, `components/figurine/OfferActions.tsx`, `components/account/OrderReturnPanel.tsx`.

## Test ve derleme

- `npm run test:accounts`: izole **SQLite** veritabanında 26 entegrasyon/güvenlik grubu geçti. Teklif rolü, geçersiz aritmetik, müşteri sahipliği, eski/süresi dolmuş sürüm, eşzamanlı onay ve yeni sürüm, idempotent onay/dönüşüm, adres snapshot'ı, tutar manipülasyonu, KDV/kargo çift eklenmemesi, belirsiz ödeme kilidi, mevcut Posnet akışının mock callback'i, operasyon geçişi/audit, müşteri iade başvurusu, Content Manager sınırı ve SMTP/outbox retry kapsandı. Banka işlemi yalnızca mock'tur.
- Backend `tsc --noEmit` ve frontend `tsc --noEmit` geçti.
- Strapi `npm run build` admin eklentisiyle çalıştırıldı; bitiş sonucu aşağıdaki doğrulama kaydına göre güncellenecek.
- Tam frontend üretim derlemesi `node --import tsx tests/customer.integration.test.ts --build` ile yerel izole CMS fixture'ı ve kontrollü katalog izinleri kullanılarak çalıştırılır; dış CMS hataları boş içeriğe çevrilmez. Bitiş sonucu aşağıdaki doğrulama kaydına göre güncellenecek.
- SQLite sonuçları PostgreSQL transaction/kilit/benzersizlik doğrulaması olarak sunulmaz. Eşzamanlılık için yerel PostgreSQL testi ve üretim veritabanı doğrulaması hâlâ gereklidir.

## Üretim öncesi ayarlar ve harici doğrulamalar

İsimler dışında secret değerleri belgelenmez:

- `FIGURINE_REVIEW_ROLE_NAMES`: başvuru inceleme/personel görünümü rol adları.
- `FIGURINE_QUOTE_ROLE_NAMES`: teklif hazırlama/sunma rol adları.
- `FIGURINE_OPERATIONS_ROLE_NAMES`: figür siparişi operasyon rol adları; mevcut order servisi rol kodu koşulu da sağlanmalıdır.
- `FIGURINE_PHOTO_ROLE_NAMES`: özel fotoğraf görüntüleme rol adları.
- `FIGURINE_PAYMENTS_ENABLED`: figür ödemesi özelliğini açma anahtarı; varsayılan `false`.
- `POSNET_BANK_VERIFIED`: Posnet işyeri/test ve callback davranışı doğrulanana kadar `false`.
- Önceki aşamalardaki `CUSTOMER_*`, `FIGURINE_*_S3_*`, SMTP ve şifreleme anahtarları da doğru şekilde sağlanmalıdır.

Yayından önce Posnet'in resmi banka ortamında 3D Secure dönüş/callback, mutabakat ve tekrar callback davranışı; gerçek PostgreSQL eşzamanlı işlemleri; private S3 imza/erişim/yaşam döngüsü; SMTP teslimatı/outbox worker; canlı Strapi rol adları ve admin eklentisi yetkileri doğrulanmalıdır. Gerçek iade entegrasyonu yoktur. Vergi/kargo açıklaması ile müşteri sözleşmesi ve iptal/iade bilgilendirmesi için onaylı hukuki metin gerekir; hukuki hak veya saklama süresi bu uygulama tarafından uydurulmamıştır.

## Hesap kapsamı tamamlama tablosu

| Kapsam | Durum | Not |
|---|---|---|
| Üyelik, doğrulama, giriş/çıkış, sıfırlama ve güvenli oturum | Tamamlandı (1. aşama) | Mevcut Strapi Users & Permissions hesabı ve aynı-origin BFF. |
| Profil ve birden çok teslimat/fatura adresi | Tamamlandı (1. aşama) | Sipariş snapshot'ları adres defterinden bağımsız. |
| Salt okunur müşteri sipariş görünümü ve sahiplik | Tamamlandı (1. aşama) | Eski misafir siparişleri otomatik bağlanmaz. |
| Kalıcı sepet, üye checkout, PaymentAttempt ve takip | Tamamlandı (2. aşama, yerel) | Gerçek Posnet ve PostgreSQL kanıtı açık üretim koşulu. |
| Kişiye özel figür talebi, private fotoğraf ve müşteri takip ekranı | Tamamlandı (3. aşama, yerel) | Gerçek S3/HEIC/SMTP ve hukuki metin ayrıca doğrulanmalı. |
| Teklif sürümü, müşteri onayı/değişiklik isteği ve idempotent siparişe dönüşüm | Tamamlandı (4. aşama, yerel) | Ödeme varsayılan kapalı; Posnet doğrulaması yok. |
| Operasyon, kargo, audit ve personel iş akışı | Tamamlandı (4. aşama, yerel) | Üretim rol adları ve gerçek admin erişimi ayrıca doğrulanmalı. |
| İptal/iade başvurusu ve personel kararı | Başvuru akışı tamamlandı | Gerçek banka iadesi yok; kabul kararı iade yapılmış demek değildir. |
| Hesap silme başvurusu ve hesap/fotoğraf/sipariş saklama-silme politikaları | Sonraki iş | Hukuki saklama yükümlülüğü/onaylı süreç belirlenmeli. |
| İletişim ve isteğe bağlı pazarlama tercihleri | Sonraki iş | İşlemsel bildirimlerden ayrıştırılmış tercih merkezi yapılmalı. |
| Eski misafir siparişini sahiplenme | Sonraki iş | E-posta/telefon eşleşmesiyle otomatik bağlama yapılmıyor; sahiplik doğrulama akışı gerekli. |
| Gerçek iade entegrasyonu | Sonraki iş/harici bağımlılık | Banka sağlayıcısı ve doğrulanmış iade API'si olmadan çalıştırılmaz. |

## Final verification note

- Strapi TypeScript compilation and admin-panel production build completed successfully.
- The isolated SQLite integration suite passed 26 groups. This is not PostgreSQL concurrency verification.
- The full Next.js production build completed successfully against the controlled local Strapi fixture and generated 30 routes, including the account and figurine routes.
- Frontend TypeScript and ESLint on the Stage 4 customer pages/components and browser harness passed after fixes. Repository-wide `npm run lint` remains red on unrelated existing files and legacy errors outside this focused set.
- `npm run test:accounts:e2e` passed on the local fixture, including the 390px mobile figurine form/File draft round trip, membership, saved addresses, profile, order snapshot, guest checkout, member checkout, logout/privacy, CSRF, and rewrite-boundary checks. Bank responses were mocked and outbound browser traffic to banks was blocked.
- Two `<img>` lint warnings remain in the figurine form: one for the public package gallery and one for an in-memory object-URL preview. The private preview remains local and bypasses Next's optimizer/cache, so private photos are not exposed through a public image proxy.
- No real Posnet request, charge, or refund was made.
