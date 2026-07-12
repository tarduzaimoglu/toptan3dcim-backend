/**
 * payment router
 *
 * initiate ve callback banka/ödeme akışının parçası olduğu için herkese
 * açıktır (auth: false) - kart verisi bu endpoint'lere hiçbir zaman gelmez,
 * sadece Posnet'e yönlendirme/dönüş verisi taşınır.
 */

export default {
  routes: [
    {
      method: 'POST',
      path: '/payment/initiate',
      handler: 'payment.initiate',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/payment/callback',
      handler: 'payment.callback',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
