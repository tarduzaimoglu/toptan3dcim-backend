import React, { useEffect, useMemo, useState } from "react";
import { useAuth, useFetchClient } from "@strapi/strapi/admin";
import { Badge, Button, Typography } from "@strapi/design-system";
import styled, { useTheme } from "styled-components";

type Work = {
  id: string;
  requestNumber: string;
  status: string;
  state: string;
  createdAt: string;
  customerEmail: string;
  customerName: string;
  package: { title: string };
  details: any;
};
type Quote = {
  id: string;
  version: number;
  state: string;
  scope: any;
  amountMinor: number;
  taxMinor: number;
  shippingMinor: number;
  totalMinor: number;
  customerNote: string;
  internalNote: string;
  taxShippingDisclosure: string;
  validUntil: string | null;
};
const basePanel: React.CSSProperties = {
  marginTop: 20,
  padding: 24,
  borderRadius: 12,
  boxShadow: "0 4px 16px rgba(16,24,40,.06)",
};
const baseInput: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: 10,
  borderRadius: 8,
  marginTop: 4,
  marginBottom: 12,
};
const titleStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 700,
  marginBottom: 12,
};
const label = (text: string) => (
  <span style={{ fontSize: 13, fontWeight: 600 }}>{text}</span>
);
const requestStateLabel: Record<string, string> = {
  received: "Alındı",
  reviewing: "İnceleniyor",
  "waiting-customer": "Müşteri yanıtı bekleniyor",
  closed: "Kapatıldı",
};
const preferenceLabel: Record<string, string> = {
  email: "E-posta",
  whatsapp: "WhatsApp",
  color: "Renkli",
  monochrome: "Beyaz / tek renk",
  custom: "Özel",
};
const DesktopOnly = styled.div`
  display: block;
  @media (max-width: 767px) {
    display: none;
  }
`;
const MobileOnly = styled.div`
  display: none;
  @media (max-width: 767px) {
    display: grid;
    gap: 12px;
  }
`;
const DetailGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 24px;
  @media (max-width: 767px) {
    grid-template-columns: 1fr;
    gap: 16px;
  }
`;
const blankScope = (item?: Work) => ({
  characters: item?.details?.characters || 1,
  pets: item?.details?.pets || 0,
  colorChoice: item?.details?.style || "color",
  designDescription: "",
  includedParts: [""],
  sizeDescription: "",
  standIncluded: null as boolean | null,
  boxIncluded: null as boolean | null,
  productionDeliveryNote: "",
});

export default function Requests() {
  const { get, post, put } = useFetchClient();
  const token = useAuth("FigurineRequests", (state) => state.token);
  const theme = useTheme() as any;
  const colors = theme.colors;
  const panel: React.CSSProperties = {
    ...basePanel,
    color: colors.neutral800,
    background: colors.neutral0,
    border: `1px solid ${colors.neutral200}`,
  };
  const input: React.CSSProperties = {
    ...baseInput,
    color: colors.neutral800,
    background: colors.neutral0,
    border: `1px solid ${colors.neutral300}`,
  };
  const [requests, setRequests] = useState<Work[]>([]),
    [orders, setOrders] = useState<any[]>([]),
    [returns, setReturns] = useState<any[]>([]);
  const [deletions, setDeletions] = useState<any[]>([]);
  const [retention, setRetention] = useState<any>(null);
  const [guestClaims, setGuestClaims] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null),
    [images, setImages] = useState<Array<{ id: string; src: string }>>([]),
    [notifications, setNotifications] = useState<any[]>([]);
  const [detailTab, setDetailTab] = useState<"request" | "quote" | "operation">(
    "request",
  );
  const [generalTab, setGeneralTab] = useState<
    "requests" | "accounts" | "retention" | "notifications"
  >("requests");
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [quoteDetailsOpen, setQuoteDetailsOpen] = useState(false),
    [quoteNotesOpen, setQuoteNotesOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<any>(null);
  const [scope, setScope] = useState<any>(blankScope()),
    [price, setPrice] = useState({ amount: "", tax: "0", shipping: "0" }),
    [disclosure, setDisclosure] = useState("");
  const [customerNote, setCustomerNote] = useState(""),
    [internalNote, setInternalNote] = useState(""),
    [validUntil, setValidUntil] = useState(""),
    [offerId, setOfferId] = useState("");
  const [requestState, setRequestState] = useState("reviewing"),
    [customerStatus, setCustomerStatus] = useState("İnceleniyor"),
    [requestNote, setRequestNote] = useState("");
  const [operation, setOperation] = useState<any>({
    fulfillmentState: "preparing",
    shippingCarrier: "",
    trackingNumber: "",
    trackingUrl: "",
    customerNote: "",
    internalNote: "",
  });
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const dollars = (minorValue: number) =>
    `₺${(minorValue / 100).toLocaleString("tr-TR", { minimumFractionDigits: 2 })}`;

  async function refresh() {
    const [
      dashboard,
      queue,
      returnResult,
      deletionResult,
      retentionResult,
      claimResult,
    ] = await Promise.all([
      get("/figurine-admin/dashboard"),
      get("/figurine-admin/notifications"),
      get("/figurine-admin/returns"),
      get("/figurine-admin/account-deletions"),
      get("/figurine-admin/retention/preview"),
      get("/figurine-admin/guest-claims"),
    ]);
    setRequests(dashboard.data.requests || []);
    setOrders(dashboard.data.orders || []);
    setReturns(returnResult.data.returnRequests || []);
    setNotifications(queue.data.notifications || []);
    setDeletions(deletionResult.data.requests || []);
    setRetention(retentionResult.data);
    setGuestClaims(claimResult.data.claims || []);
  }
  useEffect(() => {
    let live = true;
    Promise.all([
      get("/figurine-admin/dashboard"),
      get("/figurine-admin/notifications"),
      get("/figurine-admin/returns"),
      get("/figurine-admin/account-deletions"),
      get("/figurine-admin/retention/preview"),
      get("/figurine-admin/guest-claims"),
    ])
      .then(
        ([
          dashboard,
          notificationsResult,
          returnsResult,
          deletionResult,
          retentionResult,
          claimResult,
        ]) => {
          if (!live) return;
          setRequests(dashboard.data.requests || []);
          setOrders(dashboard.data.orders || []);
          setNotifications(notificationsResult.data.notifications || []);
          setReturns(returnsResult.data.returnRequests || []);
          setDeletions(deletionResult.data.requests || []);
          setRetention(retentionResult.data);
          setGuestClaims(claimResult.data.claims || []);
        },
      )
      .catch(() => {
        if (live)
          setError(
            "Operasyon ekranı yüklenemedi. Girişinizi ve personel rolünüzü kontrol edin.",
          );
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [get]);
  useEffect(
    () => () => images.forEach((image) => URL.revokeObjectURL(image.src)),
    [images],
  );
  useEffect(() => {
    const orderId = new URLSearchParams(window.location.search).get("order");
    const requestId = new URLSearchParams(window.location.search).get(
      "request",
    );
    if (orderId)
      get(`/figurine-admin/orders/${encodeURIComponent(orderId)}`)
        .then(({ data }) => setSelectedOrder(data))
        .catch(() =>
          setError("Sipariş açılamadı. Operasyon yetkinizi kontrol edin."),
        );
    if (requestId) void open({ id: requestId } as Work);
  }, [get]);

  async function open(item: Work) {
    setError("");
    setImages([]);
    setDetailTab("request");
    try {
      const { data } = await get(
        `/figurine-admin/requests/${encodeURIComponent(item.id)}`,
      );
      setSelected(data);
      const draft: Quote | undefined = (data.offers || []).find(
        (quote: Quote) => quote.state === "draft",
      );
      setScope(
        draft
          ? {
              ...draft.scope,
              includedParts: (draft.scope.includedParts || []).join("\n"),
            }
          : blankScope(data),
      );
      setPrice(
        draft
          ? {
              amount: String(draft.amountMinor / 100),
              tax: String(draft.taxMinor / 100),
              shipping: String(draft.shippingMinor / 100),
            }
          : { amount: "", tax: "0", shipping: "0" },
      );
      setDisclosure(draft?.taxShippingDisclosure || "");
      setCustomerNote(draft?.customerNote || "");
      setInternalNote(draft?.internalNote || "");
      setValidUntil(
        draft?.validUntil
          ? new Date(draft.validUntil).toISOString().slice(0, 16)
          : "",
      );
      setOfferId(draft?.id || "");
      setRequestState(data.status || data.state || "reviewing");
      setCustomerStatus(data.customerStatusText || "İnceleniyor");
      setRequestNote(data.internalNotes || "");
      if (data.order)
        setOperation({
          fulfillmentState:
            data.order.fulfillmentState === "unknown"
              ? "preparing"
              : data.order.fulfillmentState,
          shippingCarrier: data.order.shippingCarrier,
          trackingNumber: data.order.trackingNumber,
          trackingUrl: data.order.trackingUrl,
          customerNote: data.order.customerNote,
          internalNote: data.order.internalNote,
        });
      const blobs = await Promise.all(
        (data.photos || []).map(async (photo: any) => {
          const response = await fetch(
            `/figurine-admin/requests/${encodeURIComponent(item.id)}/photos/${encodeURIComponent(photo.id)}`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "image/webp",
              },
            },
          );
          if (!response.ok) throw new Error("Private photo unavailable");
          return {
            id: photo.id,
            src: URL.createObjectURL(await response.blob()),
          };
        }),
      );
      setImages(blobs);
    } catch {
      setError(
        "Talep detayı açılamadı. Fotoğraf ve işlem yetkilerinizi kontrol edin.",
      );
    }
  }
  function inputField(
    name: string,
    value: string,
    onChange: (value: string) => void,
    opts: any = {},
  ) {
    return (
      <label style={{ display: "block", marginBottom: 10 }}>
        {label(name)}
        {opts.multiline ? (
          <textarea
            style={{ ...input, minHeight: 80 }}
            value={value}
            maxLength={opts.max || 3000}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <input
            style={input}
            type={opts.type || "text"}
            value={value}
            maxLength={opts.max || 1000}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </label>
    );
  }
  function quotePayload() {
    const asMinor = (value: string) =>
      Math.round(Number(value.replace(",", ".")) * 100);
    const amountMinor = asMinor(price.amount),
      taxMinor = asMinor(price.tax),
      shippingMinor = asMinor(price.shipping);
    return {
      ...(offerId ? { offerId } : {}),
      scope: {
        ...scope,
        includedParts: scope.includedParts.split
          ? scope.includedParts
              .split("\n")
              .map((v: string) => v.trim())
              .filter(Boolean)
          : scope.includedParts,
      },
      amountMinor,
      taxMinor,
      shippingMinor,
      totalMinor: amountMinor + taxMinor + shippingMinor,
      currency: "TRY",
      taxShippingDisclosure: disclosure,
      customerNote,
      internalNote,
      validUntil: validUntil ? new Date(validUntil).toISOString() : null,
    };
  }
  async function saveOffer(present: boolean) {
    setError("");
    if (present) {
      const amountMinor = Math.round(
        Number(price.amount.replace(",", ".")) * 100,
      );
      const totalMinor = Math.round(
        (Number(price.amount.replace(",", ".")) +
          Number(price.tax.replace(",", ".")) +
          Number(price.shipping.replace(",", "."))) *
          100,
      );
      if (
        !scope.designDescription?.trim() ||
        !disclosure.trim() ||
        !amountMinor ||
        !totalMinor
      ) {
        setQuoteDetailsOpen(true);
        setError(
          "Müşteriye sunmak için tasarım kapsamı, teklif tutarı ve vergi/kargo açıklaması zorunludur.",
        );
        return;
      }
      if (
        !window.confirm(
          `Müşteriye sunulacak teklif özeti:\n\nKapsam: ${scope.designDescription}\nToplam: ${dollars(totalMinor)}\n\nTeklif müşteriye sunulsun mu?`,
        )
      )
        return;
    }
    setBusy(true);
    try {
      const data = quotePayload();
      if (present) {
        const draft = await put(
          `/figurine-admin/requests/${encodeURIComponent(selected.id)}/offers`,
          data,
        );
        const result = await post(
          `/figurine-admin/requests/${encodeURIComponent(selected.id)}/offers/${encodeURIComponent(draft.data.id)}/present`,
          data,
        );
        setOfferId(result.data.id);
        setError("");
      } else {
        const result = await put(
          `/figurine-admin/requests/${encodeURIComponent(selected.id)}/offers`,
          data,
        );
        setOfferId(result.data.id);
      }
      await open({ ...selected, id: selected.id });
      await refresh();
    } catch (e: any) {
      setError(
        e?.response?.data?.message ||
          "Teklif kaydedilemedi. Tutar/kapsam bilgilerini kontrol edin.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function updateRequest() {
    setBusy(true);
    try {
      await put(`/figurine-admin/requests/${encodeURIComponent(selected.id)}`, {
        status: requestState,
        customerStatusText: customerStatus,
        internalNotes: requestNote,
      });
      await open(selected);
      await refresh();
    } catch (e: any) {
      setError(e?.response?.data?.message || "Talep güncellenemedi.");
    } finally {
      setBusy(false);
    }
  }
  async function updateOrder() {
    if (!selected?.order) return;
    setBusy(true);
    try {
      await put(
        `/figurine-admin/orders/${encodeURIComponent(selected.order.id)}/operation`,
        operation,
      );
      await open(selected);
      await refresh();
    } catch (e: any) {
      setError(
        e?.response?.data?.message ||
          "Sipariş operasyonu kaydedilemedi. Durum geçişini ve ödeme bilgisini kontrol edin.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function decideReturn(row: any, state: string) {
    const note = window.prompt(
      "Müşteriye görünen açıklama (hukuki metin eklemeyin):",
      "",
    );
    if (note === null) return;
    setBusy(true);
    try {
      await put(`/figurine-admin/returns/${encodeURIComponent(row.id)}`, {
        state,
        customerNote: note,
        staffNote: "",
      });
      await refresh();
    } catch (e: any) {
      setError(e?.response?.data?.message || "Başvuru güncellenemedi.");
    } finally {
      setBusy(false);
    }
  }
  async function retry(id: string) {
    try {
      await post(
        `/figurine-admin/notifications/${encodeURIComponent(id)}/retry`,
        {},
      );
      await refresh();
    } catch (e: any) {
      setError(
        e?.response?.data?.message || "Bildirim yeniden sıraya alınamadı.",
      );
    }
  }
  async function decideDeletion(row: any, status: string) {
    const reason = window.prompt(
      "Karar gerekçesi (saklama/işlem engellerini inceleyin):",
    );
    if (!reason?.trim()) return;
    try {
      await put(
        `/figurine-admin/account-deletions/${encodeURIComponent(row.id)}`,
        { status, reason },
      );
      await refresh();
    } catch (e: any) {
      setError(e?.response?.data?.message || "Hesap başvurusu güncellenemedi.");
    }
  }
  async function executeRetention(category: string, id: string) {
    if (
      !window.confirm(
        `Ön izlemede listelenen ${category} kaydı silinsin mi? Dosya silme geri alınamaz.`,
      )
    )
      return;
    try {
      await post("/figurine-admin/retention/execute", {
        category,
        targetId: id,
        confirmation: "execute",
      });
      await refresh();
    } catch (e: any) {
      setError(e?.response?.data?.message || "Saklama işlemi tamamlanamadı.");
    }
  }
  const actionOrders = useMemo(() => orders, [orders]);

  return (
    <main
      style={
        {
          padding: "28px clamp(16px,3vw,36px)",
          maxWidth: 1180,
          margin: "auto",
          color: colors.neutral800,
          fontSize: 15,
          lineHeight: 1.55,
          "--colors-neutral0": colors.neutral0,
          "--colors-neutral100": colors.neutral100,
          "--colors-neutral200": colors.neutral200,
          "--colors-neutral300": colors.neutral300,
          "--colors-neutral700": colors.neutral700,
          "--colors-neutral800": colors.neutral800,
          "--colors-primary100": colors.primary100,
          "--colors-primary600": colors.primary600,
          "--colors-primary700": colors.primary700,
        } as React.CSSProperties
      }
    >
      <Typography tag="h1" variant="alpha">
        {selected
          ? `Figür Talebi · ${selected.requestNumber}`
          : "Figür Talepleri"}
      </Typography>
      {error && (
        <p
          role="alert"
          style={{ color: "#b42318", background: "#fef2f2", padding: 12 }}
        >
          {error}
        </p>
      )}
      {!selected &&
        (loading ? (
          <p>Yükleniyor…</p>
        ) : (
          <>
            <nav
              aria-label="Genel yönetim bölümleri"
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                marginTop: 20,
              }}
            >
              {(
                [
                  ["requests", "Talepler"],
                  ["accounts", "Hesap işlemleri"],
                  ["retention", "Saklama"],
                  ["notifications", "Bildirimler"],
                ] as const
              ).map(([key, text]) => (
                <Button
                  key={key}
                  variant={generalTab === key ? "default" : "tertiary"}
                  onClick={() => setGeneralTab(key)}
                >
                  {text}
                </Button>
              ))}
            </nav>
            {generalTab === "requests" && (
              <section
                style={{ ...panel, boxShadow: "0 4px 16px rgba(16,24,40,.06)" }}
              >
                <h2 style={titleStyle}>Talepler</h2>
                {!requests.length ? (
                  <p>Henüz talep yok.</p>
                ) : (
                  <>
                    <DesktopOnly>
                      <table
                        style={{ width: "100%", borderCollapse: "collapse" }}
                      >
                        <thead>
                          <tr>
                            {[
                              "Talep",
                              "Müşteri",
                              "Paket",
                              "Tarih",
                              "Durum",
                            ].map((head) => (
                              <th
                                key={head}
                                style={{
                                  textAlign: "left",
                                  padding: "12px 10px",
                                  borderBottom: `1px solid ${colors.neutral200}`,
                                  fontSize: 13,
                                }}
                              >
                                {head}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {requests.map((item) => (
                            <tr
                              key={item.id}
                              onClick={() => void open(item)}
                              style={{ cursor: "pointer" }}
                            >
                              <td
                                style={{
                                  padding: 12,
                                  borderBottom: `1px solid ${colors.neutral150}`,
                                }}
                              >
                                <strong>{item.requestNumber}</strong>
                              </td>
                              <td
                                style={{
                                  padding: 12,
                                  borderBottom: `1px solid ${colors.neutral150}`,
                                }}
                              >
                                {item.customerName}
                                <br />
                                <small>{item.customerEmail}</small>
                              </td>
                              <td
                                style={{
                                  padding: 12,
                                  borderBottom: `1px solid ${colors.neutral150}`,
                                }}
                              >
                                {item.package?.title}
                              </td>
                              <td
                                style={{
                                  padding: 12,
                                  borderBottom: `1px solid ${colors.neutral150}`,
                                }}
                              >
                                {new Date(item.createdAt).toLocaleDateString(
                                  "tr-TR",
                                )}
                              </td>
                              <td
                                style={{
                                  padding: 12,
                                  borderBottom: `1px solid ${colors.neutral150}`,
                                }}
                              >
                                <Badge>
                                  {requestStateLabel[item.state] || item.status}
                                </Badge>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </DesktopOnly>
                    <MobileOnly>
                      {requests.map((item) => (
                        <button
                          key={item.id}
                          onClick={() => void open(item)}
                          style={{
                            textAlign: "left",
                            color: colors.neutral800,
                            background: colors.neutral0,
                            border: `1px solid ${colors.neutral200}`,
                            borderRadius: 10,
                            padding: 16,
                            boxShadow: "0 2px 8px rgba(16,24,40,.05)",
                            cursor: "pointer",
                          }}
                        >
                          <strong>{item.requestNumber}</strong>
                          <div style={{ marginTop: 6 }}>
                            {item.customerName}
                          </div>
                          <div>{item.package?.title}</div>
                          <small>
                            {new Date(item.createdAt).toLocaleDateString(
                              "tr-TR",
                            )}
                          </small>
                          <div style={{ marginTop: 8 }}>
                            <Badge>
                              {requestStateLabel[item.state] || item.status}
                            </Badge>
                          </div>
                        </button>
                      ))}
                    </MobileOnly>
                  </>
                )}
              </section>
            )}
            {generalTab === "accounts" && (
              <>
                <section style={panel}>
                  <h2 style={titleStyle}>Hesap silme başvuruları</h2>
                  {!deletions.length ? (
                    <p>İncelenecek başvuru yok.</p>
                  ) : (
                    deletions.map((row) => (
                      <article
                        key={row.id}
                        style={{
                          borderTop: `1px solid ${colors.neutral200}`,
                          padding: "12px 0",
                        }}
                      >
                        <p>
                          {row.customerEmail || "Müşteri hesabı bulunamadı"} ·{" "}
                          {row.status} ·{" "}
                          {new Date(row.requestedAt).toLocaleString("tr-TR")}
                        </p>
                        <p>{row.reason || "Açıklama yok"}</p>
                        <button
                          disabled={busy}
                          onClick={() => void decideDeletion(row, "blocked")}
                        >
                          Saklama/işlem engeli var
                        </button>{" "}
                        <button
                          disabled={busy}
                          onClick={() => void decideDeletion(row, "approved")}
                        >
                          İncelemeyi onayla
                        </button>{" "}
                        <button
                          disabled={busy}
                          onClick={() => void decideDeletion(row, "rejected")}
                        >
                          Reddet
                        </button>
                      </article>
                    ))
                  )}
                </section>
                <section style={panel}>
                  <h2 style={titleStyle}>
                    Manuel sipariş sahiplenme incelemesi
                  </h2>
                  {!guestClaims.length ? (
                    <p>İnceleme bekleyen sipariş yok.</p>
                  ) : (
                    guestClaims.map((row) => (
                      <article
                        key={row.id}
                        style={{
                          borderTop: `1px solid ${colors.neutral200}`,
                          padding: 10,
                        }}
                      >
                        <strong>
                          {row.orderNumber || "Sipariş bulunamadı"}
                        </strong>
                        <p>
                          Başvuran: {row.claimantEmail} ·{" "}
                          {new Date(row.createdAt).toLocaleString("tr-TR")}
                        </p>
                        <p>
                          {row.channelAvailable
                            ? "Sipariş iletişim kanalı mevcut; sahiplik personel sürecinde doğrulanmalı."
                            : "Kullanılabilir doğrulama kanalı yok."}
                        </p>
                      </article>
                    ))
                  )}
                </section>
              </>
            )}
            {generalTab === "retention" && (
              <section style={panel}>
                <h2 style={titleStyle}>Veri saklama ön izlemesi</h2>
                <p>
                  Figür fotoğrafları tamamlanan işlerde teslimden 90 gün, iptal
                  edilen veya vazgeçilen taleplerde kapanıştan 30 gün sonra
                  silinir; silinen fotoğraflar yedek döngüsünden en geç 30 gün
                  içinde çıkar. Hesap verileri için otomatik bir saklama/silme
                  süresi tanımlı değildir; hesap silme başvuruları ayrıca
                  personel incelemesinden geçer.
                </p>
                {(retention?.categories || []).map((item: any) => (
                  <article
                    key={item.category}
                    style={{
                      borderTop: `1px solid ${colors.neutral200}`,
                      padding: "10px 0",
                    }}
                  >
                    <strong>{item.category}</strong> ·{" "}
                    {item.configured
                      ? `${item.count} aday`
                      : "Politika veya işlem kapalı"}
                    {item.skipped && <p>{item.skipped}</p>}
                    {(item.candidates || []).map((candidate: any) => (
                      <div key={candidate.id} style={{ padding: "5px 0" }}>
                        {candidate.id}
                        {retention.executionEnabled && item.configured && (
                          <button
                            style={{ marginLeft: 12 }}
                            onClick={() =>
                              void executeRetention(item.category, candidate.id)
                            }
                          >
                            Ön izlenen kaydı sil
                          </button>
                        )}
                      </div>
                    ))}
                  </article>
                ))}
              </section>
            )}
            {generalTab === "requests" && !!actionOrders.length && (
              <section style={panel}>
                <h2 style={titleStyle}>İşlem bekleyen siparişler</h2>
                <ul>
                  {actionOrders.map((order) => (
                    <li key={order.id} style={{ padding: 8 }}>
                      <button
                        onClick={() => {
                          const request = requests.find(
                            (r) => r.id === order.requestId,
                          );
                          if (request) void open(request);
                        }}
                      >
                        {order.orderNumber} · {order.requestNumber}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {generalTab === "requests" && !!returns.length && (
              <section style={panel}>
                <h2 style={titleStyle}>İptal / iade başvuruları</h2>
                {returns.map((row) => (
                  <article
                    key={row.id}
                    style={{
                      borderTop: `1px solid ${colors.neutral200}`,
                      padding: 12,
                    }}
                  >
                    <strong>{row.orderNumber}</strong> · {row.customerEmail}
                    <p style={{ whiteSpace: "pre-wrap" }}>{row.reason}</p>
                    <button
                      disabled={busy}
                      onClick={() => void decideReturn(row, "reviewing")}
                    >
                      İncelemede
                    </button>{" "}
                    <button
                      disabled={busy}
                      onClick={() => void decideReturn(row, "accepted")}
                    >
                      Başvuruyu kabul et
                    </button>{" "}
                    <button
                      disabled={busy}
                      onClick={() => void decideReturn(row, "rejected")}
                    >
                      Başvuruyu reddet
                    </button>
                  </article>
                ))}
              </section>
            )}
            {generalTab === "notifications" && (
              <section style={panel}>
                <h2 style={titleStyle}>Bildirim kuyruğu</h2>
                {!notifications.length ? (
                  <p>Bildirim kaydı yok.</p>
                ) : (
                  notifications.map((job) => (
                    <p
                      key={job.id}
                      style={{
                        borderTop: `1px solid ${colors.neutral200}`,
                        padding: 8,
                      }}
                    >
                      <strong>
                        {job.orderNumber || job.requestNumber || "Bildirim"}
                      </strong>{" "}
                      · {job.audience === "business" ? "İşletme" : "Müşteri"} ·{" "}
                      {(
                        {
                          pending: "Bekliyor",
                          sent: "Gönderildi",
                          failed: "Başarısız",
                        } as Record<string, string>
                      )[job.status] || job.status}{" "}
                      · {job.attempts} deneme{" "}
                      {job.lastErrorCode && `· ${job.lastErrorCode}`}{" "}
                      {job.status !== "sent" && (
                        <button
                          style={{ marginLeft: 12 }}
                          onClick={() => void retry(job.id)}
                        >
                          Yeniden dene
                        </button>
                      )}
                    </p>
                  ))
                )}
              </section>
            )}
          </>
        ))}
      {selected && (
        <>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 12,
              marginTop: 16,
            }}
          >
            <Button
              variant="secondary"
              onClick={() => {
                setSelected(null);
                setImages([]);
                setError("");
              }}
            >
              ← Taleplere dön
            </Button>
            <strong>{selected.requestNumber}</strong>
            <Badge>
              {requestStateLabel[selected.status] ||
                selected.customerStatusText ||
                "Durum belirtilmedi"}
            </Badge>
          </div>
          <nav
            aria-label="Talep detay bölümleri"
            style={{
              display: "flex",
              gap: 8,
              marginTop: 20,
              borderBottom: "1px solid var(--colors-neutral200)",
              paddingBottom: 8,
            }}
          >
            {(
              [
                ["request", "Talep ve fotoğraflar"],
                ["quote", "Teklif"],
                ["operation", "Operasyon"],
              ] as const
            ).map(([key, text]) => (
              <button
                key={key}
                aria-current={detailTab === key ? "page" : undefined}
                onClick={() => setDetailTab(key)}
                style={{
                  padding: "10px 14px",
                  fontWeight: detailTab === key ? 700 : 500,
                  color:
                    detailTab === key
                      ? "var(--colors-primary700)"
                      : "var(--colors-neutral700)",
                  background:
                    detailTab === key
                      ? "var(--colors-primary100)"
                      : "transparent",
                  border: 0,
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                {text}
              </button>
            ))}
          </nav>

          {detailTab === "request" && (
            <section style={panel}>
              <h2 style={titleStyle}>Müşteri ve talep özeti</h2>
              <DetailGrid>
                <div>
                  <p>
                    <strong>Müşteri</strong>
                    <br />
                    {selected.customerName}
                    <br />
                    {selected.customerEmail}
                    {selected.details?.phone && (
                      <>
                        <br />
                        {selected.details.phone}
                      </>
                    )}
                  </p>
                  <p>
                    <strong>İletişim tercihi</strong>
                    <br />
                    {preferenceLabel[selected.details?.contactPreference] ||
                      "Belirtilmedi"}
                  </p>
                </div>
                <div>
                  <p>
                    <strong>Paket</strong>
                    <br />
                    {selected.package?.title || "Belirtilmedi"}
                  </p>
                  <p>
                    <strong>Tercihler</strong>
                    <br />
                    {preferenceLabel[selected.details?.style] ||
                      "Belirtilmedi"}{" "}
                    · {selected.details?.characters ?? 0} kişi ·{" "}
                    {selected.details?.pets ?? 0} evcil hayvan
                  </p>
                  <p>
                    <strong>Kaide / yazı</strong>
                    <br />
                    {selected.details?.base || "Belirtilmedi"} ·{" "}
                    {selected.details?.plinthText || "Yazı yok"}
                  </p>
                </div>
              </DetailGrid>
              <p style={{ whiteSpace: "pre-wrap" }}>
                <strong>Ek not</strong>
                <br />
                {selected.details?.note || "Belirtilmedi"}
              </p>
              <h2 style={titleStyle}>Kişi ve evcil hayvanlar</h2>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))",
                  gap: 16,
                }}
              >
                {(selected.details?.people || []).map(
                  (person: any, index: number) => {
                    const personImages = images.filter((image) =>
                      (person.fileKeys || []).includes(image.id),
                    );
                    return (
                      <article
                        key={index}
                        style={{
                          border: "1px solid var(--colors-neutral200)",
                          borderRadius: 10,
                          padding: 16,
                        }}
                      >
                        <h3 style={{ fontSize: 17, fontWeight: 700 }}>
                          {person.kind === "pet" ? "Evcil hayvan" : "Kişi"}{" "}
                          {index + 1}
                        </h3>
                        <p>{person.description || "Açıklama belirtilmedi"}</p>
                        {person.outfit && (
                          <p>
                            <strong>Kıyafet:</strong> {person.outfit}
                          </p>
                        )}
                        {person.pose && (
                          <p>
                            <strong>Poz:</strong> {person.pose}
                          </p>
                        )}
                        {person.hair && (
                          <p>
                            <strong>Saç:</strong> {person.hair}
                          </p>
                        )}
                        {person.accessories && (
                          <p>
                            <strong>Aksesuar:</strong> {person.accessories}
                          </p>
                        )}
                        <div
                          style={{ display: "flex", flexWrap: "wrap", gap: 10 }}
                        >
                          {personImages.map(
                            (image: any, photoIndex: number) => (
                              <img
                                key={image.id}
                                src={image.src}
                                onClick={() => setPreviewImage(image.src)}
                                alt={`${person.kind === "pet" ? "Evcil hayvan" : "Kişi"} ${index + 1} referans fotoğrafı ${photoIndex + 1}`}
                                style={{
                                  width: 200,
                                  height: 200,
                                  objectFit: "contain",
                                  background: "var(--colors-neutral100)",
                                  border: "1px solid var(--colors-neutral200)",
                                  borderRadius: 8,
                                  cursor: "zoom-in",
                                }}
                              />
                            ),
                          )}
                        </div>
                      </article>
                    );
                  },
                )}
              </div>
              {!(selected.details?.people || []).length && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                  {images.map((image: any, i: number) => (
                    <img
                      key={image.id}
                      src={image.src}
                      onClick={() => setPreviewImage(image.src)}
                      alt={`Özel referans ${i + 1}`}
                      style={{
                        width: 200,
                        height: 200,
                        objectFit: "contain",
                        background: "var(--colors-neutral100)",
                        borderRadius: 8,
                        cursor: "zoom-in",
                      }}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {detailTab === "quote" && (
            <section style={panel}>
              <h2 style={titleStyle}>Teklif kapsamı ve fiyat</h2>
              <DetailGrid>
                <div>
                  <label>
                    {label("Tasarım kapsamı · zorunlu")}
                    <textarea
                      style={{ ...input, minHeight: 130 }}
                      value={scope.designDescription}
                      onChange={(e) =>
                        setScope({
                          ...scope,
                          designDescription: e.target.value,
                        })
                      }
                    />
                  </label>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(3,minmax(90px,1fr))",
                      gap: 8,
                    }}
                  >
                    <label>
                      {label("Kişi sayısı")}
                      <input
                        style={input}
                        type="number"
                        value={scope.characters}
                        onChange={(e) =>
                          setScope({
                            ...scope,
                            characters: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      {label("Evcil hayvan")}
                      <input
                        style={input}
                        type="number"
                        value={scope.pets}
                        onChange={(e) =>
                          setScope({ ...scope, pets: Number(e.target.value) })
                        }
                      />
                    </label>
                    <label>
                      {label("Renk")}
                      <select
                        style={input}
                        value={scope.colorChoice}
                        onChange={(e) =>
                          setScope({ ...scope, colorChoice: e.target.value })
                        }
                      >
                        <option value="color">Renkli</option>
                        <option value="monochrome">Beyaz / tek renk</option>
                        <option value="custom">Özel</option>
                      </select>
                    </label>
                  </div>
                </div>
                <div>
                  {inputField(
                    "Teklif tutarı (TL) · zorunlu",
                    price.amount,
                    (amount: string) => setPrice({ ...price, amount }),
                  )}
                  {inputField("Vergi tutarı (TL)", price.tax, (tax: string) =>
                    setPrice({ ...price, tax }),
                  )}
                  {inputField(
                    "Kargo tutarı (TL)",
                    price.shipping,
                    (shipping: string) => setPrice({ ...price, shipping }),
                  )}
                  <div
                    style={{
                      padding: 16,
                      background: "var(--colors-primary100)",
                      borderRadius: 8,
                      fontSize: 22,
                      fontWeight: 700,
                    }}
                  >
                    Ödenecek toplam:{" "}
                    {dollars(
                      Math.round(
                        (Number(price.amount.replace(",", ".")) +
                          Number(price.tax.replace(",", ".")) +
                          Number(price.shipping.replace(",", "."))) *
                          100,
                      ),
                    )}
                  </div>
                </div>
              </DetailGrid>
              <details
                open={quoteDetailsOpen}
                onToggle={(e) => setQuoteDetailsOpen(e.currentTarget.open)}
                style={{ marginTop: 20 }}
              >
                <summary style={{ cursor: "pointer", fontWeight: 700 }}>
                  Ek kapsam ve teslimat ayrıntıları
                </summary>
                <div style={{ paddingTop: 14 }}>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
                      gap: 8,
                    }}
                  >
                    <label>
                      {label("Kaide")}
                      <select
                        style={input}
                        value={
                          scope.standIncluded === null
                            ? "unknown"
                            : scope.standIncluded
                              ? "yes"
                              : "no"
                        }
                        onChange={(e) =>
                          setScope({
                            ...scope,
                            standIncluded:
                              e.target.value === "unknown"
                                ? null
                                : e.target.value === "yes",
                          })
                        }
                      >
                        <option value="unknown">Belirtilmedi</option>
                        <option value="yes">Dahil</option>
                        <option value="no">Dahil değil</option>
                      </select>
                    </label>
                    <label>
                      {label("Kutu")}
                      <select
                        style={input}
                        value={
                          scope.boxIncluded === null
                            ? "unknown"
                            : scope.boxIncluded
                              ? "yes"
                              : "no"
                        }
                        onChange={(e) =>
                          setScope({
                            ...scope,
                            boxIncluded:
                              e.target.value === "unknown"
                                ? null
                                : e.target.value === "yes",
                          })
                        }
                      >
                        <option value="unknown">Belirtilmedi</option>
                        <option value="yes">Dahil</option>
                        <option value="no">Dahil değil</option>
                      </select>
                    </label>
                  </div>
                  <label>
                    {label("Dahil olan parçalar (satır başına bir madde)")}
                    <textarea
                      style={{ ...input, minHeight: 70 }}
                      value={scope.includedParts.join("\n")}
                      onChange={(e) =>
                        setScope({ ...scope, includedParts: e.target.value })
                      }
                    />
                  </label>
                  {inputField(
                    "Boyut açıklaması",
                    scope.sizeDescription,
                    (v: string) => setScope({ ...scope, sizeDescription: v }),
                  )}
                  {inputField(
                    "Üretim / teslimat bilgisi",
                    scope.productionDeliveryNote,
                    (v: string) =>
                      setScope({ ...scope, productionDeliveryNote: v }),
                    { multiline: true },
                  )}
                  {inputField(
                    "Vergi ve kargo kapsamı açıklaması · zorunlu",
                    disclosure,
                    setDisclosure,
                    { multiline: true },
                  )}
                </div>
              </details>
              <details
                open={quoteNotesOpen}
                onToggle={(e) => setQuoteNotesOpen(e.currentTarget.open)}
                style={{ marginTop: 16 }}
              >
                <summary style={{ cursor: "pointer", fontWeight: 700 }}>
                  Notlar ve geçerlilik
                </summary>
                <div style={{ paddingTop: 14 }}>
                  {inputField(
                    "Müşteriye görünen not",
                    customerNote,
                    setCustomerNote,
                    { multiline: true },
                  )}
                  {inputField(
                    "Dahili not · müşteriye gösterilmez",
                    internalNote,
                    setInternalNote,
                    { multiline: true },
                  )}
                  {inputField(
                    "İsteğe bağlı son geçerlilik",
                    validUntil,
                    setValidUntil,
                    { type: "datetime-local" },
                  )}
                </div>
              </details>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 12,
                  marginTop: 22,
                }}
              >
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void saveOffer(false)}
                >
                  Taslağı kaydet
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => void saveOffer(true)}
                >
                  Müşteriye sun
                </Button>
              </div>
              <div style={{ marginTop: 22 }}>
                <h3 style={titleStyle}>Teklif geçmişi</h3>
                {(selected.offers || []).map((q: Quote) => (
                  <div
                    key={q.id}
                    style={{
                      borderTop: "1px solid var(--colors-neutral200)",
                      padding: 8,
                    }}
                  >
                    Sürüm {q.version} ·{" "}
                    {(
                      {
                        draft: "Taslak",
                        offered: "Müşteriye sunuldu",
                        accepted: "Kabul edildi",
                        superseded: "Geçersiz kılındı",
                      } as Record<string, string>
                    )[q.state] || q.state}{" "}
                    · {dollars(q.totalMinor)}
                  </div>
                ))}
              </div>
              {!!selected.responses?.length && (
                <div style={{ marginTop: 18 }}>
                  <h3 style={titleStyle}>Müşteri yanıtları</h3>
                  {selected.responses.map((r: any, i: number) => (
                    <p key={i}>
                      Sürüm {r.quoteVersion} ·{" "}
                      {new Date(r.createdAt).toLocaleString("tr-TR")} ·{" "}
                      {r.comment}
                    </p>
                  ))}
                </div>
              )}
            </section>
          )}

          {detailTab === "operation" && (
            <section style={panel}>
              <h2 style={titleStyle}>Talep durumu</h2>
              <label>
                {label("Talep durumu")}
                <select
                  style={input}
                  value={requestState}
                  onChange={(e) => setRequestState(e.target.value)}
                >
                  {["received", "reviewing", "waiting-customer", "closed"].map(
                    (v) => (
                      <option key={v} value={v}>
                        {requestStateLabel[v]}
                      </option>
                    ),
                  )}
                </select>
              </label>
              {inputField(
                "Müşteriye görünen durum",
                customerStatus,
                setCustomerStatus,
              )}
              {inputField("Dahili not", requestNote, setRequestNote, {
                multiline: true,
                max: 5000,
              })}
              <button disabled={busy} onClick={() => void updateRequest()}>
                Talebi güncelle
              </button>
              {selected.order ? (
                <div
                  style={{
                    marginTop: 24,
                    borderTop: "1px solid var(--colors-neutral200)",
                    paddingTop: 20,
                  }}
                >
                  <h2 style={titleStyle}>Sipariş / üretim / kargo</h2>
                  <p>
                    {selected.order.orderNumber} · ödeme:{" "}
                    {selected.order.paymentState} · operasyon:{" "}
                    {selected.order.fulfillmentState}
                  </p>
                  <label>
                    {label("Operasyon durumu")}
                    <select
                      style={input}
                      value={operation.fulfillmentState}
                      onChange={(e) =>
                        setOperation({
                          ...operation,
                          fulfillmentState: e.target.value,
                        })
                      }
                    >
                      {[
                        ["preparing", "Hazırlanıyor"],
                        ["production", "Üretimde"],
                        ["ready", "Hazır"],
                        ["shipped", "Kargoya verildi"],
                        ["delivered", "Teslim edildi"],
                        ["cancelled", "İptal edildi"],
                      ].map(([v, t]) => (
                        <option key={v} value={v}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>
                  {inputField(
                    "Kargo firması",
                    operation.shippingCarrier,
                    (v: string) =>
                      setOperation({ ...operation, shippingCarrier: v }),
                  )}
                  {inputField(
                    "Takip numarası",
                    operation.trackingNumber,
                    (v: string) =>
                      setOperation({ ...operation, trackingNumber: v }),
                  )}
                  {inputField(
                    "HTTPS takip bağlantısı",
                    operation.trackingUrl,
                    (v: string) =>
                      setOperation({ ...operation, trackingUrl: v }),
                  )}
                  {inputField(
                    "Müşteriye görünen açıklama",
                    operation.customerNote,
                    (v: string) =>
                      setOperation({ ...operation, customerNote: v }),
                    { multiline: true },
                  )}
                  {inputField(
                    "Dahili not",
                    operation.internalNote,
                    (v: string) =>
                      setOperation({ ...operation, internalNote: v }),
                    { multiline: true },
                  )}
                  <button disabled={busy} onClick={() => void updateOrder()}>
                    Operasyonu güncelle
                  </button>
                </div>
              ) : (
                <p style={{ marginTop: 20 }}>
                  Bu talebe bağlı sipariş henüz oluşmamış.
                </p>
              )}
            </section>
          )}
        </>
      )}
      {previewImage && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Referans fotoğrafı ön izlemesi"
          onClick={() => setPreviewImage(null)}
          style={{ position: "fixed", inset: 0, zIndex: 1000, display: "grid", placeItems: "center", padding: 24, background: "rgba(0,0,0,.78)" }}
        >
          <button onClick={() => setPreviewImage(null)} style={{ position: "absolute", top: 20, right: 20, padding: "10px 14px" }}>Kapat</button>
          <img src={previewImage} alt="Büyütülmüş özel referans" style={{ maxWidth: "min(1100px,94vw)", maxHeight: "88vh", objectFit: "contain", background: colors.neutral0, borderRadius: 10 }} />
        </div>
      )}
      {selectedOrder && (
        <section style={panel}>
          <h2 style={titleStyle}>Sipariş {selectedOrder.orderNumber}</h2>
          <p>
            {new Date(selectedOrder.createdAt).toLocaleString("tr-TR")} · ödeme:{" "}
            {selectedOrder.paymentState || "kayıtlı değil"} · operasyon:{" "}
            {selectedOrder.fulfillmentState || "kayıtlı değil"}
          </p>
          <p>
            <strong>Müşteri:</strong> {selectedOrder.buyerName} ·{" "}
            {selectedOrder.buyerEmail} ·{" "}
            {selectedOrder.buyerPhone || "telefon kayıtlı değil"}
          </p>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              fontFamily: "inherit",
              background: "#f8fafc",
              padding: 12,
            }}
          >
            {JSON.stringify(
              {
                teslimat: selectedOrder.shippingAddress,
                urunler: selectedOrder.items,
                araToplam: selectedOrder.subtotal,
                indirim: selectedOrder.discountTotal,
                vergi: selectedOrder.vatTotal,
                kargo: selectedOrder.shippingCost,
                toplam: selectedOrder.grandTotal,
                paraBirimi: selectedOrder.currency,
                musteriNotu: selectedOrder.customerNote,
              },
              null,
              2,
            )}
          </pre>
        </section>
      )}
    </main>
  );
}
