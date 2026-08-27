export default {
  routes: [
    {
      method: 'GET',
      path: '/health',
      handler: 'health.index',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
