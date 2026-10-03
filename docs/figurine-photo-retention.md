# Figurine photo retention and restore procedure

Policy/version: `figurine-photo-notice-v1-2026-10-03`  
Effective date: 2026-10-03

- Delivered figurine-order photos and every derived reference image are retained for 90 days from the explicitly recorded delivery transition.
- Closed, cancelled, or abandoned-by-staff requests are retained for 30 days from the explicitly recorded close/cancel transition. Inactivity never starts this clock.
- Historical terminal records without an explicit terminal timestamp are listed under `photo-retention-review`; the worker does not infer a date or delete them.
- Deletion removes private object bytes but keeps the request, offer, order, accounting record, asset tombstone, retention job, and operational audit.
- Each asset is tombstoned after its object deletion. A partial storage/database failure leaves the job failed and retryable; completed assets are idempotently re-deleted on retry.
- The scheduled cleanup processes due requests and reconciles every tombstoned object key. This also removes a photo accidentally reintroduced by restoring an older private-object archive.
- Private-object backup archives have both a seven-snapshot cap and an absolute 30-day maximum age. Database and public-media backup schedules are unchanged.

## Restore order

1. Keep the private bucket ingress unavailable to customers and staff.
2. Restore the database and the selected private-object archive without deleting the current database retention/tombstone rows.
3. Start one backend instance and run/await the normal figurine cleanup pass. Confirm no failed `completed-request-photo` retention jobs remain and that tombstone reconciliation completed.
4. Only then restore private photo ingress and application traffic.

Never restore an older database over newer retention/tombstone rows as an ordinary media recovery. If a database point-in-time restore is unavoidable, first preserve and replay the newer `retention_jobs` and `figurine_private_assets` deletion columns, then run reconciliation before exposing photos.

## Published customer notice

Version: `figurine-photo-notice-v1-2026-10-03`  
Effective date: 3 October 2026

Kişiye özel figür talebiniz kapsamında yüklediğiniz fotoğrafları; talebinizi değerlendirmek, figürünüzün modellenmesi ile üretim hazırlığını yapmak ve talebiniz hakkında sizinle iletişim kurmak amacıyla işleriz.

Fotoğraflar herkese açık ürün görseli alanına yüklenmez. Şirketimizin yönettiği özel depolama alanında tutulur. Fotoğraflara hesabınız üzerinden yalnız siz ve görevleri kapsamında yetkilendirilmiş Strapi personeli erişebilir. Anonim erişim kapalıdır.

Yükleme sırasında kısa süreli ve yalnız ilgili dosya için geçerli güvenli bir bağlantı kullanılır. Yükleme tamamlandığında dosya türü, boyutu ve görüntü sınırları kontrol edilir; görüntü metadata'sı kaldırılarak işleme uygun WebP referans kopyası oluşturulur ve geçici yükleme kopyası silinir.

Teslim edilen işlere bağlı fotoğraflar ve oluşturulan referans türevleri, kaydedilmiş teslim tarihinden itibaren 90 gün saklanır. İptal edilen veya kapatılan taleplere bağlı fotoğraflar ve türevleri, kaydedilmiş iptal ya da kapanış tarihinden itibaren 30 gün saklanır. Bu sürelerin sonunda fotoğraflar ana özel depolamadan silinir. Silinen fotoğrafları içeren private depolama yedekleri en geç 30 gün içinde yedek döngüsünden çıkar. Sipariş, teklif ve muhasebe kayıtları bu fotoğraf silme işlemi kapsamında silinmez.

Fotoğrafların figür modelleme ve üretim amacıyla işlenmesine ilişkin bu bilgilendirme; reklam, sosyal medya veya portföy kullanımına izin verildiği anlamına gelmez. Bu amaçların her biri için ayrıca bağımsız ve açık izin alınır. Pazarlama iletişimi tercihi fotoğraf kullanım izni değildir.
