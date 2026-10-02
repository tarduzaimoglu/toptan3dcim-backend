export default {
  routes: [
    {
      method: 'GET',
      path: '/figurine-package/catalog',
      handler: 'figurine-package.catalog',
      config: { auth: false, policies: [], middlewares: [] },
    },
  ],
};
