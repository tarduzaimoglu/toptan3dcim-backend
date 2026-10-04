import React, { useEffect, useMemo, useState } from 'react';
import { useFetchClient } from '@strapi/strapi/admin';

type Work = { id: string; requestNumber: string; status: string; state: string; createdAt: string; customerEmail: string; customerName: string; package: { title: string }; details: any };
type Quote = { id: string; version: number; state: string; scope: any; amountMinor: number; taxMinor: number; shippingMinor: number; totalMinor: number; customerNote: string; internalNote: string; taxShippingDisclosure: string; validUntil: string | null };
const panel: React.CSSProperties = { marginTop: 20, padding: 20, background: '#fff', border: '1px solid #ddd', borderRadius: 12 };
const input: React.CSSProperties = { display: 'block', width: '100%', padding: 10, border: '1px solid #ccc', borderRadius: 8, marginTop: 4, marginBottom: 12 };
const titleStyle: React.CSSProperties = { fontSize: 20, fontWeight: 700, marginBottom: 12 };
const label = (text: string) => <span style={{ fontSize: 13, fontWeight: 600 }}>{text}</span>;
const blankScope = (item?: Work) => ({ characters: item?.details?.characters || 1, pets: item?.details?.pets || 0, colorChoice: item?.details?.style || 'color', designDescription: '', includedParts: [''], sizeDescription: '', standIncluded: null as boolean | null, boxIncluded: null as boolean | null, productionDeliveryNote: '' });

export default function Requests() {
  const { get, post, put } = useFetchClient();
  const [requests, setRequests] = useState<Work[]>([]), [orders, setOrders] = useState<any[]>([]), [returns, setReturns] = useState<any[]>([]);
  const [deletions, setDeletions] = useState<any[]>([]);
  const [retention, setRetention] = useState<any>(null);
  const [guestClaims, setGuestClaims] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null), [images, setImages] = useState<string[]>([]), [notifications, setNotifications] = useState<any[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<any>(null);
  const [scope, setScope] = useState<any>(blankScope()), [price, setPrice] = useState({ amount: '', tax: '0', shipping: '0' }), [disclosure, setDisclosure] = useState('');
  const [customerNote, setCustomerNote] = useState(''), [internalNote, setInternalNote] = useState(''), [validUntil, setValidUntil] = useState(''), [offerId, setOfferId] = useState('');
  const [requestState, setRequestState] = useState('reviewing'), [customerStatus, setCustomerStatus] = useState('İnceleniyor'), [requestNote, setRequestNote] = useState('');
  const [operation, setOperation] = useState<any>({ fulfillmentState: 'preparing', shippingCarrier: '', trackingNumber: '', trackingUrl: '', customerNote: '', internalNote: '' });
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const dollars = (minorValue: number) => `₺${(minorValue / 100).toLocaleString('tr-TR', { minimumFractionDigits: 2 })}`;

  async function refresh() {
    const [dashboard, queue, returnResult, deletionResult, retentionResult, claimResult] = await Promise.all([get('/figurine-admin/dashboard'), get('/figurine-admin/notifications'), get('/figurine-admin/returns'), get('/figurine-admin/account-deletions'), get('/figurine-admin/retention/preview'), get('/figurine-admin/guest-claims')]);
    setRequests(dashboard.data.requests || []); setOrders(dashboard.data.orders || []); setReturns(returnResult.data.returnRequests || []);
    setNotifications(queue.data.notifications || []);
    setDeletions(deletionResult.data.requests || []);
    setRetention(retentionResult.data);
    setGuestClaims(claimResult.data.claims||[]);
  }
  useEffect(() => { let live = true; Promise.all([get('/figurine-admin/dashboard'), get('/figurine-admin/notifications'), get('/figurine-admin/returns'), get('/figurine-admin/account-deletions'), get('/figurine-admin/retention/preview'), get('/figurine-admin/guest-claims')]).then(([dashboard, notificationsResult, returnsResult, deletionResult, retentionResult, claimResult]) => {
    if (!live) return; setRequests(dashboard.data.requests || []); setOrders(dashboard.data.orders || []); setNotifications(notificationsResult.data.notifications || []); setReturns(returnsResult.data.returnRequests || []); setDeletions(deletionResult.data.requests || []); setRetention(retentionResult.data); setGuestClaims(claimResult.data.claims||[]);
  }).catch(() => { if (live) setError('Operasyon ekranı yüklenemedi. Girişinizi ve personel rolünüzü kontrol edin.'); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, [get]);
  useEffect(() => () => images.forEach(URL.revokeObjectURL), [images]);
  useEffect(() => {
    const orderId = new URLSearchParams(window.location.search).get('order');
    const requestId = new URLSearchParams(window.location.search).get('request');
    if (orderId) get(`/figurine-admin/orders/${encodeURIComponent(orderId)}`).then(({ data }) => setSelectedOrder(data)).catch(() => setError('Sipariş açılamadı. Operasyon yetkinizi kontrol edin.'));
    if (requestId) void open({ id: requestId } as Work);
  }, [get]);

  async function open(item: Work) {
    setError(''); setImages([]);
    try {
      const { data } = await get(`/figurine-admin/requests/${encodeURIComponent(item.id)}`);
      setSelected(data);
      const draft: Quote | undefined = (data.offers || []).find((quote: Quote) => quote.state === 'draft');
      setScope(draft ? { ...draft.scope, includedParts: (draft.scope.includedParts || []).join('\n') } : blankScope(data));
      setPrice(draft ? { amount: String(draft.amountMinor / 100), tax: String(draft.taxMinor / 100), shipping: String(draft.shippingMinor / 100) } : { amount: '', tax: '0', shipping: '0' });
      setDisclosure(draft?.taxShippingDisclosure || ''); setCustomerNote(draft?.customerNote || ''); setInternalNote(draft?.internalNote || '');
      setValidUntil(draft?.validUntil ? new Date(draft.validUntil).toISOString().slice(0, 16) : ''); setOfferId(draft?.id || '');
      setRequestState(data.state || 'reviewing'); setCustomerStatus(data.status || 'İnceleniyor'); setRequestNote(data.internalNotes || '');
      if (data.order) setOperation({ fulfillmentState: data.order.fulfillmentState === 'unknown' ? 'preparing' : data.order.fulfillmentState, shippingCarrier: data.order.shippingCarrier, trackingNumber: data.order.trackingNumber, trackingUrl: data.order.trackingUrl, customerNote: data.order.customerNote, internalNote: data.order.internalNote });
      const blobs = await Promise.all((data.photos || []).map(async (photo: any) => {
        const response = await get(`/figurine-admin/requests/${encodeURIComponent(item.id)}/photos/${encodeURIComponent(photo.id)}`, { responseType: 'blob' }); return URL.createObjectURL(response.data);
      })); setImages(blobs);
    } catch { setError('Talep detayı açılamadı. Fotoğraf ve işlem yetkilerinizi kontrol edin.'); }
  }
  function inputField(name: string, value: string, onChange: (value: string) => void, opts: any = {}) {
    return <label style={{ display: 'block', marginBottom: 10 }}>{label(name)}{opts.multiline ? <textarea style={{ ...input, minHeight: 80 }} value={value} maxLength={opts.max || 3000} onChange={e => onChange(e.target.value)} /> : <input style={input} type={opts.type || 'text'} value={value} maxLength={opts.max || 1000} onChange={e => onChange(e.target.value)} />}</label>;
  }
  function quotePayload() {
    const asMinor = (value: string) => Math.round(Number(value.replace(',', '.')) * 100);
    const amountMinor = asMinor(price.amount), taxMinor = asMinor(price.tax), shippingMinor = asMinor(price.shipping);
    return { ...(offerId ? { offerId } : {}), scope: { ...scope, includedParts: scope.includedParts.split ? scope.includedParts.split('\n').map((v: string) => v.trim()).filter(Boolean) : scope.includedParts },
      amountMinor, taxMinor, shippingMinor, totalMinor: amountMinor + taxMinor + shippingMinor, currency: 'TRY', taxShippingDisclosure: disclosure,
      customerNote, internalNote, validUntil: validUntil ? new Date(validUntil).toISOString() : null };
  }
  async function saveOffer(present: boolean) {
    setBusy(true); setError('');
    try {
      const data = quotePayload();
      if (present) {
        const draft = await put(`/figurine-admin/requests/${encodeURIComponent(selected.id)}/offers`, data);
        const result = await post(`/figurine-admin/requests/${encodeURIComponent(selected.id)}/offers/${encodeURIComponent(draft.data.id)}/present`, data);
        setOfferId(result.data.id); setError('');
      } else {
        const result = await put(`/figurine-admin/requests/${encodeURIComponent(selected.id)}/offers`, data); setOfferId(result.data.id);
      }
      await open({ ...selected, id: selected.id }); await refresh();
    } catch (e: any) { setError(e?.response?.data?.message || 'Teklif kaydedilemedi. Tutar/kapsam bilgilerini kontrol edin.'); }
    finally { setBusy(false); }
  }
  async function updateRequest() {
    setBusy(true); try { await put(`/figurine-admin/requests/${encodeURIComponent(selected.id)}`, { status: requestState, customerStatusText: customerStatus, internalNotes: requestNote }); await open(selected); await refresh(); }
    catch (e: any) { setError(e?.response?.data?.message || 'Talep güncellenemedi.'); } finally { setBusy(false); }
  }
  async function updateOrder() {
    if (!selected?.order) return; setBusy(true);
    try { await put(`/figurine-admin/orders/${encodeURIComponent(selected.order.id)}/operation`, operation); await open(selected); await refresh(); }
    catch (e: any) { setError(e?.response?.data?.message || 'Sipariş operasyonu kaydedilemedi. Durum geçişini ve ödeme bilgisini kontrol edin.'); } finally { setBusy(false); }
  }
  async function decideReturn(row: any, state: string) {
    const note = window.prompt('Müşteriye görünen açıklama (hukuki metin eklemeyin):', ''); if (note === null) return;
    setBusy(true); try { await put(`/figurine-admin/returns/${encodeURIComponent(row.id)}`, { state, customerNote: note, staffNote: '' }); await refresh(); }
    catch (e: any) { setError(e?.response?.data?.message || 'Başvuru güncellenemedi.'); } finally { setBusy(false); }
  }
  async function retry(id: string) { try { await post(`/figurine-admin/notifications/${encodeURIComponent(id)}/retry`, {}); await refresh(); } catch (e: any) { setError(e?.response?.data?.message || 'Bildirim yeniden sıraya alınamadı.'); } }
  async function decideDeletion(row: any, status: string) { const reason = window.prompt('Karar gerekçesi (saklama/işlem engellerini inceleyin):'); if (!reason?.trim()) return; try { await put(`/figurine-admin/account-deletions/${encodeURIComponent(row.id)}`, { status, reason }); await refresh(); } catch (e: any) { setError(e?.response?.data?.message || 'Hesap başvurusu güncellenemedi.'); } }
  async function executeRetention(category: string, id: string) { if (!window.confirm(`Ön izlemede listelenen ${category} kaydı silinsin mi? Dosya silme geri alınamaz.`)) return; try { await post('/figurine-admin/retention/execute',{category,targetId:id,confirmation:'execute'}); await refresh(); } catch(e:any) { setError(e?.response?.data?.message||'Saklama işlemi tamamlanamadı.'); } }
  const actionOrders = useMemo(() => orders, [orders]);

  return <main style={{ padding: 24, maxWidth: 1320, margin: 'auto', color: '#20232a' }}>
    <h1 style={{ fontSize: 28, fontWeight: 700 }}>Figür Talepleri ve Operasyon</h1><p>Yetkiler teklif, talep inceleme, operasyon ve özel fotoğraflar için backend’de ayrı doğrulanır.</p>
    {error && <p role="alert" style={{ color: '#b42318', background: '#fef2f2', padding: 12 }}>{error}</p>}
    {loading ? <p>Yükleniyor…</p> : <>
      <section style={panel}><h2 style={titleStyle}>Talepler</h2>{!requests.length ? <p>Henüz talep yok.</p> : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 12 }}>{requests.map(item => <button key={item.id} onClick={() => void open(item)} style={{ textAlign: 'left', background: 'white', border: '1px solid #ddd', borderRadius: 10, padding: 14, cursor: 'pointer' }}><strong>{item.requestNumber}</strong><div>{item.customerName} · {item.customerEmail}</div><div>{item.package?.title}</div><small>{new Date(item.createdAt).toLocaleString('tr-TR')} · {item.status}</small></button>)}</div>}</section>
      <section style={panel}><h2 style={titleStyle}>Hesap silme başvuruları</h2>{!deletions.length?<p>İncelenecek başvuru yok.</p>:deletions.map(row=><article key={row.id} style={{borderTop:'1px solid #ddd',padding:'12px 0'}}><p>{row.customerEmail||'Müşteri hesabı bulunamadı'} · {row.status} · {new Date(row.requestedAt).toLocaleString('tr-TR')}</p><p>{row.reason||'Açıklama yok'}</p><button disabled={busy} onClick={()=>void decideDeletion(row,'blocked')}>Saklama/işlem engeli var</button>{' '}<button disabled={busy} onClick={()=>void decideDeletion(row,'approved')}>İncelemeyi onayla</button>{' '}<button disabled={busy} onClick={()=>void decideDeletion(row,'rejected')}>Reddet</button><p style={{fontSize:12}}>Onay veri silme işlemi değildir. Sistem devam eden/bilinmeyen sipariş durumlarında onayı bloke eder.</p></article>)}</section>
      <section style={panel}><h2 style={titleStyle}>Manuel sipariş sahiplenme incelemesi</h2>{!guestClaims.length?<p>İnceleme bekleyen sipariş yok.</p>:guestClaims.map(row=><article key={row.id} style={{borderTop:'1px solid #ddd',padding:10}}><strong>{row.orderNumber||'Sipariş bulunamadı'}</strong><p>Başvuran: {row.claimantEmail} · {new Date(row.createdAt).toLocaleString('tr-TR')}</p><p>{row.channelAvailable?'Sipariş iletişim kanalı mevcut; sahiplik personel sürecinde doğrulanmalı.':'Kullanılabilir doğrulama kanalı yok.'}</p><p>Bu ekran otomatik hesap bağlamaz ve e-posta/telefon eşleşmesini tek başına kanıt saymaz.</p></article>)}</section>
      <section style={panel}><h2 style={titleStyle}>Veri saklama ön izlemesi</h2><p>Liste yalnızca ön izlemedir. Tamamlanmış talepler ve hesap verileri için onaylı politika tanımlı değildir.</p>{(retention?.categories||[]).map((item:any)=><article key={item.category} style={{borderTop:'1px solid #ddd',padding:'10px 0'}}><strong>{item.category}</strong> · {item.configured?`${item.count} aday`:'politika/işlem kapalı'}{item.skipped&&<p>{item.skipped}</p>}{(item.candidates||[]).map((candidate:any)=><div key={candidate.id} style={{padding:'5px 0'}}>{candidate.id}{retention.executionEnabled&&item.configured&&<button style={{marginLeft:12}} onClick={()=>void executeRetention(item.category,candidate.id)}>Ön izlenen kaydı sil</button>}</div>)}</article>)}</section>
      {!!actionOrders.length && <section style={panel}><h2 style={titleStyle}>İşlem bekleyen siparişler</h2><ul>{actionOrders.map(order => <li key={order.id} style={{ padding: 8 }}><button onClick={() => { const request = requests.find(r => r.id === order.requestId); if (request) void open(request); }} style={{ color: '#6d28d9', textDecoration: 'underline' }}>{order.orderNumber} · {order.requestNumber} · ödeme: {order.paymentState} · operasyon: {order.fulfillmentState}</button></li>)}</ul></section>}
      {!!returns.length && <section style={panel}><h2 style={titleStyle}>İptal / iade başvuruları</h2>{returns.map(row => <article key={row.id} style={{ borderTop: '1px solid #eee', padding: 12 }}><strong>{row.orderNumber}</strong> · {row.customerEmail} · {row.state}<p style={{ whiteSpace: 'pre-wrap' }}>{row.reason}</p><button disabled={busy} onClick={() => void decideReturn(row, 'reviewing')}>İncelemede</button>{' '}<button disabled={busy} onClick={() => void decideReturn(row, 'accepted')}>Başvuruyu kabul et</button>{' '}<button disabled={busy} onClick={() => void decideReturn(row, 'rejected')}>Başvuruyu reddet</button><p style={{ fontSize: 12 }}>Bu karar ödeme durumunu değiştirmez ve iade işlemi yapmaz.</p></article>)}</section>}
      <section style={panel}><h2 style={titleStyle}>Bildirim kuyruğu</h2>{!notifications.length ? <p>Bildirim kaydı yok.</p> : notifications.map(job => <p key={job.id} style={{ borderTop: '1px solid #eee', padding: 8 }}><strong>{job.orderNumber || job.requestNumber || 'Bildirim'}</strong> · {job.audience === 'business' ? 'işletme' : 'müşteri'} · {job.status} · {job.attempts} deneme {job.lastErrorCode && `· ${job.lastErrorCode}`} {job.status !== 'sent' && <button style={{ marginLeft: 12, color: '#6d28d9' }} onClick={() => void retry(job.id)}>Yeniden dene</button>}</p>)}</section>
    </>}
    {selected && <section style={panel}><h2 style={titleStyle}>{selected.requestNumber} · {selected.customerName} · {selected.customerEmail}</h2><p>{selected.package?.title} · {selected.details?.characters} kişi · {selected.details?.pets} pet</p><pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: '#f8fafc', padding: 12 }}>{JSON.stringify(selected.details, null, 2)}</pre>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>{images.map((src, i) => <img key={`${src}-${i}`} src={src} alt={`Özel referans ${i + 1}`} style={{ width: 180, height: 180, objectFit: 'contain', background: '#f4f4f5', borderRadius: 8 }} />)}</div>
      <div style={{ ...panel, marginTop: 18 }}><h3 style={titleStyle}>Talep inceleme</h3><label>{label('Talep durumu')}<select style={input} value={requestState} onChange={e => setRequestState(e.target.value)}>{['received','reviewing','waiting-customer','closed'].map(v => <option key={v} value={v}>{v}</option>)}</select></label>{inputField('Müşteriye görünen durum', customerStatus, setCustomerStatus)}{inputField('Dahili not', requestNote, setRequestNote, { multiline: true, max: 5000 })}<button disabled={busy} onClick={() => void updateRequest()}>Talebi güncelle</button></div>
      <div style={{ ...panel, marginTop: 18 }}><h3 style={titleStyle}>Teklif taslağı · TRY ve kuruş</h3>
        <label>{label('Tasarım kapsamı')}<textarea style={{ ...input, minHeight: 80 }} value={scope.designDescription} onChange={e => setScope({ ...scope, designDescription: e.target.value })} /></label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 8 }}>
          <label>{label('Karakter sayısı')}<input style={input} type="number" value={scope.characters} onChange={e => setScope({ ...scope, characters: Number(e.target.value) })} /></label><label>{label('Pet sayısı')}<input style={input} type="number" value={scope.pets} onChange={e => setScope({ ...scope, pets: Number(e.target.value) })} /></label>
          <label>{label('Renk')}<select style={input} value={scope.colorChoice} onChange={e => setScope({ ...scope, colorChoice: e.target.value })}><option value="color">Renkli</option><option value="monochrome">Beyaz / tek renk</option><option value="custom">Özel</option></select></label>
          <label>{label('Kaide')}<select style={input} value={scope.standIncluded === null ? 'unknown' : scope.standIncluded ? 'yes' : 'no'} onChange={e => setScope({ ...scope, standIncluded: e.target.value === 'unknown' ? null : e.target.value === 'yes' })}><option value="unknown">Belirtilmedi</option><option value="yes">Dahil</option><option value="no">Dahil değil</option></select></label>
          <label>{label('Kutu')}<select style={input} value={scope.boxIncluded === null ? 'unknown' : scope.boxIncluded ? 'yes' : 'no'} onChange={e => setScope({ ...scope, boxIncluded: e.target.value === 'unknown' ? null : e.target.value === 'yes' })}><option value="unknown">Belirtilmedi</option><option value="yes">Dahil</option><option value="no">Dahil değil</option></select></label>
        </div>
        <label>{label('Dahil olan parçalar (satır başına bir madde)')}<textarea style={{ ...input, minHeight: 70 }} value={scope.includedParts.join('\n')} onChange={e => setScope({ ...scope, includedParts: e.target.value })} /></label>
        {inputField('Boyut açıklaması (yalnızca belirlenmişse)', scope.sizeDescription, (v: string) => setScope({ ...scope, sizeDescription: v }))}{inputField('Üretim / teslimat bilgisi (yalnızca netleşmişse)', scope.productionDeliveryNote, (v: string) => setScope({ ...scope, productionDeliveryNote: v }), { multiline: true })}
        {inputField('Teklif tutarı · TL', price.amount, (amount: string) => setPrice({ ...price, amount }))}{inputField('Vergi tutarı · TL', price.tax, (tax: string) => setPrice({ ...price, tax }))}{inputField('Kargo tutarı · TL', price.shipping, (shipping: string) => setPrice({ ...price, shipping }))}
        <p style={{ marginBottom: 12, fontWeight: 700 }}>Ödenecek toplam: {dollars(Math.round((Number(price.amount.replace(',', '.')) + Number(price.tax.replace(',', '.')) + Number(price.shipping.replace(',', '.'))) * 100))}</p>
        {inputField('Vergi ve kargo kapsamı açıklaması · zorunlu', disclosure, setDisclosure, { multiline: true })}{inputField('Müşteriye görünen not', customerNote, setCustomerNote, { multiline: true })}{inputField('Dahili not · müşteriye gösterilmez', internalNote, setInternalNote, { multiline: true })}{inputField('İsteğe bağlı son geçerlilik', validUntil, setValidUntil, { type: 'datetime-local' })}
        <button disabled={busy} onClick={() => void saveOffer(false)}>Taslağı kaydet</button>{' '}<button disabled={busy} onClick={() => void saveOffer(true)}>Müşteriye sun</button>
        <div style={{ marginTop: 18 }}><h4 style={{ fontWeight: 700 }}>Teklif geçmişi</h4>{(selected.offers || []).map((q: Quote) => <div key={q.id} style={{ borderTop: '1px solid #eee', padding: 8 }}>Sürüm {q.version} · {q.state} · {dollars(q.totalMinor)}{q.internalNote && <p>Dahili: {q.internalNote}</p>}</div>)}</div>
      </div>
      {!!selected.responses?.length && <div style={{ ...panel, marginTop: 18 }}><h3 style={titleStyle}>Müşteri yanıtları</h3>{selected.responses.map((r: any, i: number) => <p key={i}>{r.kind} · sürüm {r.quoteVersion} · {new Date(r.createdAt).toLocaleString('tr-TR')} {r.comment}</p>)}</div>}
      {selected.order && <div style={{ ...panel, marginTop: 18 }}><h3 style={titleStyle}>Sipariş / üretim / kargo</h3><p>{selected.order.orderNumber} · ödeme {selected.order.paymentState} · durum {selected.order.fulfillmentState}</p><label>{label('Operasyon durumu')}<select style={input} value={operation.fulfillmentState} onChange={e => setOperation({ ...operation, fulfillmentState: e.target.value })}>{['preparing','production','ready','shipped','delivered','cancelled'].map(v => <option key={v}>{v}</option>)}</select></label>{inputField('Kargo firması', operation.shippingCarrier, (v: string) => setOperation({ ...operation, shippingCarrier: v }))}{inputField('Takip numarası', operation.trackingNumber, (v: string) => setOperation({ ...operation, trackingNumber: v }))}{inputField('HTTPS takip bağlantısı', operation.trackingUrl, (v: string) => setOperation({ ...operation, trackingUrl: v }))}{inputField('Müşteriye görünen açıklama', operation.customerNote, (v: string) => setOperation({ ...operation, customerNote: v }), { multiline: true })}{inputField('Dahili not', operation.internalNote, (v: string) => setOperation({ ...operation, internalNote: v }), { multiline: true })}<button disabled={busy} onClick={() => void updateOrder()}>Operasyonu güncelle</button></div>}
    </section>}
    {selectedOrder && <section style={panel}><h2 style={titleStyle}>Sipariş {selectedOrder.orderNumber}</h2><p>{new Date(selectedOrder.createdAt).toLocaleString('tr-TR')} · ödeme: {selectedOrder.paymentState || 'kayıtlı değil'} · operasyon: {selectedOrder.fulfillmentState || 'kayıtlı değil'}</p><p><strong>Müşteri:</strong> {selectedOrder.buyerName} · {selectedOrder.buyerEmail} · {selectedOrder.buyerPhone || 'telefon kayıtlı değil'}</p><pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: '#f8fafc', padding: 12 }}>{JSON.stringify({ teslimat: selectedOrder.shippingAddress, urunler: selectedOrder.items, araToplam: selectedOrder.subtotal, indirim: selectedOrder.discountTotal, vergi: selectedOrder.vatTotal, kargo: selectedOrder.shippingCost, toplam: selectedOrder.grandTotal, paraBirimi: selectedOrder.currency, musteriNotu: selectedOrder.customerNote }, null, 2)}</pre></section>}
  </main>;
}
